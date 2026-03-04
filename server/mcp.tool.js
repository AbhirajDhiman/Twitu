import { config } from "dotenv"
import { TwitterApi } from "twitter-api-v2"
config();

function getFirstEnvValue(names) {
    for (const name of names) {
        const value = process.env[name];
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }

    return "";
}

const twitterAppKey = getFirstEnvValue(["TWITTER_CONSUMER_KEY", "TWITTER_API_KEY"]);
const twitterAppSecret = getFirstEnvValue(["TWITTER_CONSUMER_KEY_SECRET", "TWITTER_API_SECRET"]);
const twitterAccessToken = process.env.TWITTER_ACCESS_TOKEN;
const twitterAccessSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

if (!twitterAppKey) {
    throw new Error("Missing TWITTER_CONSUMER_KEY (or TWITTER_API_KEY) in environment");
}

if (!twitterAppSecret) {
    throw new Error("Missing TWITTER_CONSUMER_KEY_SECRET (or TWITTER_API_SECRET) in environment");
}

if (!twitterAccessToken) {
    throw new Error("Missing TWITTER_ACCESS_TOKEN in environment");
}

if (!twitterAccessSecret) {
    throw new Error("Missing TWITTER_ACCESS_TOKEN_SECRET in environment");
}

const twitterClient = new TwitterApi({
    appKey: twitterAppKey,
    appSecret: twitterAppSecret,
    accessToken: twitterAccessToken,
    accessSecret: twitterAccessSecret
})

export async function createPost(status) {
    const normalizedStatus = typeof status === "string" ? status.replace(/\s+/g, " ").trim() : "";

    if (!normalizedStatus) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: "Post text is required.",
                }
            ]
        };
    }

    if (normalizedStatus.length > 280) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: "Post text cannot exceed 280 characters.",
                }
            ]
        };
    }

    try {
        const newPost = await twitterClient.v2.tweet(normalizedStatus)
        return {
            content: [
                {
                    type: "text",
                    text: `Tweet posted successfully. Tweet ID: ${newPost.data.id}`
                }
            ]
        }
    } catch (error) {
        console.error("Twitter post failed:", error?.code ?? "unknown_error");

        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: "Failed to create post. Verify Twitter credentials and app permissions."
                }
            ]
        }
    }
}