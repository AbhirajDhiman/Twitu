import { config } from 'dotenv';
import readline from 'readline/promises'
import { GoogleGenAI } from "@google/genai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"


config({ override: true })
let tools = []
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
    console.error("Missing GEMINI_API_KEY in .env");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: geminiApiKey });
const preferredModel = (process.env.GEMINI_MODEL ?? "gemini-2.0-flash").trim();
const fallbackModels = (process.env.GEMINI_FALLBACK_MODELS ?? "gemini-2.0-flash-001,gemini-2.0-flash-lite,gemini-flash-latest")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

function isQuotaError(error) {
    const status = error?.status;
    const rawMessage = typeof error?.message === "string" ? error.message : "";
    return status === 429 || /RESOURCE_EXHAUSTED|quota exceeded/i.test(rawMessage);
}

function isModelNotFoundError(error) {
    const status = error?.status;
    const rawMessage = typeof error?.message === "string" ? error.message : "";
    return status === 404 || /not found for API version|is not supported for generateContent/i.test(rawMessage);
}

async function generateModelResponse({ contents, tools }) {
    const modelsToTry = [preferredModel, ...fallbackModels].filter(
        (model, index, array) => model && array.indexOf(model) === index,
    );
    let lastError;

    for (const modelName of modelsToTry) {
        try {
            return await ai.models.generateContent({
                model: modelName,
                contents,
                config: {
                    tools: [
                        {
                            functionDeclarations: tools,
                        }
                    ]
                }
            });
        } catch (error) {
            lastError = error;
            if (!isQuotaError(error) && !isModelNotFoundError(error)) {
                throw error;
            }

            if (isModelNotFoundError(error)) {
                console.warn(`Model ${modelName} is unavailable for this API key/project. Trying next model...`);
                continue;
            }

            console.warn(`Model ${modelName} hit quota limits. Trying next available model...`);
        }
    }

    throw lastError;
}
const mcpHost = process.env.MCP_HOST ?? "127.0.0.1";
const mcpPort = process.env.MCP_PORT ?? "3001";
const mcpUrl = `http://${mcpHost}:${mcpPort}/sse`;
const authMode = (process.env.AUTH_MODE ?? "none").toLowerCase();
const mcpApiKeyHeader = process.env.MCP_API_KEY_HEADER ?? "x-api-key";
const mcpApiKey = process.env.MCP_API_KEY;
const mcpJwtToken = process.env.MCP_JWT_TOKEN;

const requestHeaders = {};
if (authMode === "apikey") {
    if (!mcpApiKey) {
        console.error("AUTH_MODE=apikey requires MCP_API_KEY in .env");
        process.exit(1);
    }
    requestHeaders[mcpApiKeyHeader] = mcpApiKey;
}

if (authMode === "jwt") {
    if (!mcpJwtToken) {
        console.error("AUTH_MODE=jwt requires MCP_JWT_TOKEN in .env");
        process.exit(1);
    }
    requestHeaders.Authorization = `Bearer ${mcpJwtToken}`;
}

const mcpClient = new Client({
    name: "example-client",
    version: "1.0.0",
})



const chatHistory = [];
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function getFriendlyModelError(error) {
    const status = error?.status;
    const rawMessage = typeof error?.message === "string" ? error.message : "Unknown model error";

    if (status === 429 || /RESOURCE_EXHAUSTED|quota exceeded/i.test(rawMessage)) {
        return "Gemini quota exceeded (HTTP 429). Check API billing/quota, then retry. The app is still running.";
    }

    return `Model request failed: ${rawMessage}`;
}


mcpClient.connect(
    new SSEClientTransport(new URL(mcpUrl), {
        requestInit: {
            headers: requestHeaders,
        },
    }),
)
    .then(async () => {

        console.log("Connected to mcp server")

        tools = (await mcpClient.listTools()).tools.map(tool => {
            return {
                name: tool.name,
                description: tool.description,
                parameters: {
                    type: tool.inputSchema.type,
                    properties: tool.inputSchema.properties,
                    required: tool.inputSchema.required
                }
            }
        })

        chatLoop()


    })
    .catch((error) => {
        console.error("Failed to connect to MCP server:", error?.message ?? "unknown_error");
        process.exit(1);
    })

async function chatLoop(toolCall) {

    if (toolCall) {

        console.log("calling tool ", toolCall.name)

        chatHistory.push({
            role: "model",
            parts: [
                {
                    text: `calling tool ${toolCall.name}`,
                    type: "text"
                }
            ]
        })

        let toolResult;
        try {
            toolResult = await mcpClient.callTool({
                name: toolCall.name,
                arguments: toolCall.args
            })
        } catch (error) {
            console.error("Tool call failed:", error?.message ?? "unknown_error");
            return chatLoop();
        }

        const toolText = toolResult?.content?.[0]?.text ?? "(No tool output)";

        chatHistory.push({
            role: "user",
            parts: [
                {
                    text: "Tool result : " + toolText,
                    type: "text"
                }
            ]
        })

    } else {
        const question = await rl.question('You: ');

        if (["exit", "quit"].includes(question.trim().toLowerCase())) {
            console.log("Goodbye!");
            rl.close();
            await mcpClient.close();
            process.exit(0);
        }

        chatHistory.push({
            role: "user",
            parts: [
                {
                    text: question,
                    type: "text"
                }
            ]
        })
    }

    let response;
    try {
        response = await generateModelResponse({
            contents: chatHistory,
            tools,
        })
    } catch (error) {
        console.error(getFriendlyModelError(error));
        return chatLoop();
    }
    const firstCandidate = response?.candidates?.[0];
    const firstPart = firstCandidate?.content?.parts?.[0] ?? {};
    const functionCall = firstPart.functionCall
    const responseText = typeof firstPart.text === "string" ? firstPart.text : ""

    if (functionCall) {
        return chatLoop(functionCall)
    }


    chatHistory.push({
        role: "model",
        parts: [
            {
                text: responseText,
                type: "text"
            }
        ]
    })

    if (responseText) {
        console.log(`AI: ${responseText}`)
    } else {
        console.log("AI: (No text response returned)")
    }


    chatLoop()

}
