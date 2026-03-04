import { config } from 'dotenv';
import readline from 'readline/promises'
import { GoogleGenAI } from "@google/genai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"


config()
let tools = []
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
    console.error("Missing GEMINI_API_KEY in .env");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: geminiApiKey });
const mcpHost = process.env.MCP_HOST ?? "127.0.0.1";
const mcpPort = process.env.MCP_PORT ?? "3001";
const mcpUrl = `http://${mcpHost}:${mcpPort}/sse`;

const mcpClient = new Client({
    name: "example-client",
    version: "1.0.0",
})



const chatHistory = [];
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});


mcpClient.connect(new SSEClientTransport(new URL(mcpUrl)))
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

        const toolResult = await mcpClient.callTool({
            name: toolCall.name,
            arguments: toolCall.args
        })

        chatHistory.push({
            role: "user",
            parts: [
                {
                    text: "Tool result : " + toolResult.content[ 0 ].text,
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

    const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: chatHistory,
        config: {
            tools: [
                {
                    functionDeclarations: tools,
                }
            ]
        }
    })
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
