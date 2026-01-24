
import { loadConfig } from "./src/config";
import { getRedis } from "./src/lib/redis";

async function main() {
    const config = loadConfig();
    const redis = getRedis();

    console.log("Connecting to Redis...");
    await redis.flushall();
    console.log("Redis flushed completely.");
    process.exit(0);
}

main().catch(console.error);
