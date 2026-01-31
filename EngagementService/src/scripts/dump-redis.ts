import Redis from "ioredis";
import * as dotenv from "dotenv";
import path from "path";

// Load environment from root .env
dotenv.config({ path: path.join(__dirname, "../../../.env") });

const redisHost = "localhost";
const redisPort = process.env.REDIS_HOST_PORT || "6380";
const redisUrl = `redis://${redisHost}:${redisPort}/3`;

const redis = new Redis(redisUrl);

async function dump() {
    console.log("--- Redis 'eng:' Key Dump ---");
    try {
        const keys = await redis.keys("eng:*");
        console.log(`Found ${keys.length} keys:\n`);

        for (const key of keys) {
            const type = await redis.type(key);
            let value: any;
            if (type === "string") {
                value = await redis.get(key);
            } else if (type === "set") {
                value = await redis.smembers(key);
            } else if (type === "hash") {
                value = await redis.hgetall(key);
            } else {
                value = "(unsupported type)";
            }
            console.log(`${key.padEnd(50)} | ${type.padEnd(6)} | ${JSON.stringify(value)}`);
        }
    } catch (error) {
        console.error("Dump failed:", error);
    } finally {
        redis.disconnect();
    }
}

dump();
