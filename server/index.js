import express from "express";
import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { createPost } from "./mcp.tool.js";

config();

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.MCP_PORT ?? 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Invalid MCP_PORT. Use an integer between 1 and 65535.");
    process.exit(1);
}

const app = express();
const transports = new Map();
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

app.get("/sse", async (req, res) => {
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

app.post("/messages", async (req, res) => {
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

app.listen(port, host, (error) => {
    if (error) {
        console.error("Failed to start MCP server:", error);
        process.exit(1);
    }

    console.log(`MCP server is running on http://${host}:${port}`);
    console.log(`SSE endpoint: http://${host}:${port}/sse`);
});
