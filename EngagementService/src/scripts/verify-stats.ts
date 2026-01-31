import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import * as dotenv from "dotenv";
import path from "path";

// Load environment from root .env
dotenv.config({ path: path.join(__dirname, "../../../.env") });

const dbHost = "localhost";
const dbUser = process.env.POSTGRES_USER || "postgres";
const dbPass = process.env.POSTGRES_PASSWORD || "postgres";
const dbName = process.env.ENGAGEMENT_SERVICE_DB || "pocketlol_engagement";
const dbUrl = `postgresql://${dbUser}:${dbPass}@${dbHost}:5432/${dbName}?schema=public`;

const redisHost = "localhost";
const redisPort = process.env.REDIS_HOST_PORT || "6380";
const redisUrl = `redis://${redisHost}:${redisPort}/3`;

const prisma = new PrismaClient({
    datasources: {
        db: { url: dbUrl }
    }
});
const redis = new Redis(redisUrl);

async function verify() {
    console.log("--- Engagement Data Verification (DB 3) ---");
    console.log("DB URL:", dbUrl.split("@")[1]);
    console.log("Redis URL:", redisUrl);

    try {
        // 1. Fetch some stats from DB
        const dbStats = await prisma.contentStats.findMany({
            take: 20,
            orderBy: { updatedAt: "desc" },
        });

        if (dbStats.length === 0) {
            console.log("\n[!] No records found in ContentStats table.");
        } else {
            console.log(`\nFound ${dbStats.length} records in ContentStats table:\n`);
            console.log("Type | ID | Likes (DB) | Views (DB) | Saves (DB) | Last Synced");
            console.log("------------------------------------------------------------------");
            for (const stat of dbStats) {
                // 2. Check Redis for each
                const type = stat.contentType.toLowerCase();
                const id = stat.contentId;

                const likesKey = `eng:${type}:${id}:likes`;
                const viewsKey = `eng:${type}:${id}:views`;
                const savesKey = `eng:${type}:${id}:saves`;

                const [rLikes, rViews, rSaves] = await Promise.all([
                    redis.get(likesKey),
                    redis.get(viewsKey),
                    redis.get(savesKey),
                ]);

                console.log(
                    `${stat.contentType.padEnd(6)} | ${id.slice(0, 8)} | ` +
                    `${String(stat.likeCount).padEnd(10)} | ${String(stat.viewCount).padEnd(10)} | ${String(stat.saveCount).padEnd(10)} | ` +
                    `${stat.lastSyncedAt.toISOString()}`
                );
                console.log(
                    `       | Redis    | ${String(rLikes || "nil").padEnd(10)} | ${String(rViews || "nil").padEnd(10)} | ${String(rSaves || "nil").padEnd(10)} |`
                );
                console.log("------------------------------------------------------------------");
            }
        }

        // 3. Look for "Dirty" items in Redis
        const dirtyCount = await redis.scard("stats:dirty_set");
        console.log(`\nItems waiting to be synced (Dirty Set): ${dirtyCount}`);

        // 4. Check for UserActions
        const actionCount = await prisma.userAction.count({ where: { isActive: true } });
        console.log(`\nTotal Active UserActions in DB: ${actionCount}`);

    } catch (error) {
        console.error("Verification failed:", error);
    } finally {
        await prisma.$disconnect();
        redis.disconnect();
    }
}

verify();
