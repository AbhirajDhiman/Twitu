import express from "express";
import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { createPost } from "./mcp.tool.js";
import { randomUUID } from "node:crypto";

config();

const authMode = (process.env.AUTH_MODE ?? "none").toLowerCase();
const apiKeyHeader = (process.env.MCP_API_KEY_HEADER ?? "x-api-key").toLowerCase();
const mcpApiKey = process.env.MCP_API_KEY;
const jwtSecret = process.env.JWT_SECRET;
const jwtIssuer = process.env.JWT_ISSUER;
const jwtAudience = process.env.JWT_AUDIENCE;

if (!["none", "apikey", "jwt"].includes(authMode)) {
    console.error("Invalid AUTH_MODE. Allowed values: none, apikey, jwt.");
    process.exit(1);
}

if (authMode === "apikey" && !mcpApiKey) {
    console.error("AUTH_MODE=apikey requires MCP_API_KEY.");
    process.exit(1);
}

if (authMode === "jwt" && !jwtSecret) {
    console.error("AUTH_MODE=jwt requires JWT_SECRET.");
    process.exit(1);
}

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.MCP_PORT ?? 3001);
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 120);
const trustProxy = process.env.TRUST_PROXY;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Invalid MCP_PORT. Use an integer between 1 and 65535.");
    process.exit(1);
}

if (!Number.isInteger(rateLimitWindowMs) || rateLimitWindowMs < 1) {
    console.error("Invalid RATE_LIMIT_WINDOW_MS. Use an integer > 0.");
    process.exit(1);
}

if (!Number.isInteger(rateLimitMax) || rateLimitMax < 1) {
    console.error("Invalid RATE_LIMIT_MAX_REQUESTS. Use an integer > 0.");
    process.exit(1);
}

const app = express();
const transports = new Map();
let isShuttingDown = false;

if (typeof trustProxy === "string" && trustProxy.trim() !== "") {
    app.set("trust proxy", trustProxy.trim());
}

const allowedHosts = Array.from(
    new Set([
        `${host}:${port}`,
        `localhost:${port}`,
        `127.0.0.1:${port}`,
        `[::1]:${port}`,
    ]),
);

const server = new McpServer({
    name: "twitterpost-agent-mcp-server",
    version: "1.0.0",
});

app.use(express.json({ limit: "64kb", strict: true }));

app.use((req, res, next) => {
    const requestId = randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
});

app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
        const durationMs = Date.now() - startedAt;
        console.log(
            JSON.stringify({
                level: "info",
                requestId: req.requestId,
                method: req.method,
                path: req.path,
                statusCode: res.statusCode,
                durationMs,
            }),
        );
    });
    next();
});

const mcpLimiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests. Please retry later.",
});

function authenticateRequest(req, res, next) {
    if (authMode === "none") {
        return next();
    }

    if (authMode === "apikey") {
        const incomingApiKey = req.headers[apiKeyHeader];
        if (incomingApiKey !== mcpApiKey) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.slice(7).trim();
    try {
        jwt.verify(token, jwtSecret, {
            algorithms: ["HS256"],
            issuer: jwtIssuer || undefined,
            audience: jwtAudience || undefined,
        });
        return next();
    } catch {
        return res.status(401).json({ error: "Unauthorized" });
    }
}

app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", uptimeSec: Math.floor(process.uptime()) });
});

app.get("/ready", (_req, res) => {
    if (isShuttingDown) {
        res.status(503).json({ status: "shutting_down" });
        return;
    }

    res.status(200).json({ status: "ready" });
});

server.tool(
    "addTwoNumbers",
    "Add two numbers",
    {
        a: z.number(),
        b: z.number(),
    },
    async ({ a, b }) => {
        return {
            content: [
                {
                    type: "text",
                    text: `The sum of ${a} and ${b} is ${a + b}`,
                },
            ],
        };
    },
);

server.tool(
    "createPost",
    "Create a post on X formally known as Twitter",
    {
        status: z.string().min(1).max(280),
    },
    async ({ status }) => {
        return createPost(status);
    },
);

app.get("/sse", mcpLimiter, authenticateRequest, async (req, res) => {
    try {
        const transport = new SSEServerTransport("/messages", res, {
            enableDnsRebindingProtection: true,
            allowedHosts,
        });

        transports.set(transport.sessionId, transport);

        res.on("close", async () => {
            transports.delete(transport.sessionId);
            await transport.close();
        });

        await server.connect(transport);
    } catch (error) {
        console.error("Failed to initialize SSE transport:", error?.message ?? "unknown_error");
        if (!res.headersSent) {
            res.status(500).send("Failed to initialize SSE connection");
        }
    }
});

app.post("/messages", mcpLimiter, authenticateRequest, async (req, res) => {
    const sessionId = req.query.sessionId;
    const isValidSessionId = typeof sessionId === "string" && /^[A-Za-z0-9-]{8,128}$/.test(sessionId);
    const transport = isValidSessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
        res.status(400).send("No transport found for sessionId");
        return;
    }

    try {
        await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
        console.error("Error handling /messages:", error?.message ?? "unknown_error");
        if (!res.headersSent) {
            res.status(500).send("Internal server error");
        }
    }
});

const httpServer = app.listen(port, host, (error) => {
    if (error) {
        console.error("Failed to start MCP server:", error);
        process.exit(1);
    }

    console.log(`MCP server is running on http://${host}:${port}`);
    console.log(`SSE endpoint: http://${host}:${port}/sse`);
});

async function shutdown(signal) {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    console.log(`${signal} received. Shutting down MCP server...`);

    for (const [sessionId, transport] of transports.entries()) {
        transports.delete(sessionId);
        try {
            await transport.close();
        } catch {
        }
    }

    httpServer.close(() => {
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(1);
    }, 10_000).unref();
}

process.on("SIGINT", () => {
    shutdown("SIGINT");
});

process.on("SIGTERM", () => {
    shutdown("SIGTERM");
});
