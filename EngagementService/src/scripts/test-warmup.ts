import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import * as dotenv from "dotenv";
import path from "path";
import { getStats } from "../services/collection-engagement";

// Load environment from root .env
dotenv.config({ path: path.join(__dirname, "../../../.env") });

const dbHost = "localhost";
const dbUser = process.env.POSTGRES_USER || "postgres";
const dbPass = process.env.POSTGRES_PASSWORD || "postgres";
const dbName = process.env.ENGAGEMENT_SERVICE_DB || "pocketlol_engagement";
const dbUrl = `postgresql://${dbUser}:${dbPass}@${dbHost}:5432/${dbName}?schema=public`;

const redisHost = "localhost";
const redisPort = process.env.REDIS_HOST_PORT || "6380";
const redisUrl = `redis://${redisHost}:${redisPort}`;

const prisma = new PrismaClient({
    datasources: {
        db: { url: dbUrl }
    }
});
const redis = new Redis(redisUrl);

async function test() {
    const entityType = "series";
    const entityId = "de2afbf6-a548-41ec-8541-907e2383cf38"; // Money Heist ID

    console.log(`--- Testing Warm-up for ${entityType}:${entityId} ---`);

    try {
        // 1. Clear Redis stats for this ID
        const keys = [
            `eng:${entityType}:${entityId}:likes`,
            `eng:${entityType}:${entityId}:views`,
            `eng:${entityType}:${entityId}:saves`,
        ];
        // 1. Partial delete: Only delete saves to simulate partial hit
        await redis.del(keys[2]);
        console.log("Redis 'saves' key cleared (Partial Hit scenario).");

        // 2. Call getStats with prisma
        console.log("Calling getStats (should trigger warm-up)...");
        const stats = await getStats({
            redis,
            prisma,
            entityType,
            entityId,
        });

        console.log("Resulting Stats:", stats);

        // 3. Verify Redis now has the data
        const [rLikes, rViews, rSaves] = await redis.mget(...keys);
        console.log("Redis Values:", { rLikes, rViews, rSaves });

        if (rLikes !== null && rViews !== null && rSaves !== null) {
            console.log("[SUCCESS] Redis has been warmed up!");
        } else {
            console.log("[FAILURE] Redis is still empty.");
        }

    } catch (error) {
        console.error("Test failed:", error);
    } finally {
        await prisma.$disconnect();
        redis.disconnect();
    }
}

test();
