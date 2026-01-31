import type Redis from "ioredis";
import { getRedisOptional } from "../lib/redis";
import { getPrisma } from "../lib/prisma";

const DIRTY_STATS_SET = "stats:dirty_set";
const BATCH_SIZE = 100;
const SYNC_INTERVAL_MS = 30 * 1000; // 30 seconds

export function startStatsSyncWorker() {
    console.log("[StatsSyncWorker] Starting worker...");

    setInterval(async () => {
        try {
            await syncStatsBatch();
        } catch (err) {
            console.error("[StatsSyncWorker] Error during sync:", err);
        }
    }, SYNC_INTERVAL_MS);
}

// Helper keys (matching collection-engagement.ts)
function redisLikesKey(type: string, id: string) { return `eng:${type}:${id}:likes`; }
function redisViewsKey(type: string, id: string) { return `eng:${type}:${id}:views`; }
function redisSavesKey(type: string, id: string) { return `eng:${type}:${id}:saves`; }

async function syncStatsBatch() {
    const redis = getRedisOptional();
    const prisma = getPrisma();

    if (!redis || !prisma) return;

    // 1. Pop a batch of modified content IDs
    const dirtyItems = await redis.spop(DIRTY_STATS_SET, BATCH_SIZE);
    if (!dirtyItems || dirtyItems.length === 0) return;

    const items = Array.isArray(dirtyItems) ? dirtyItems : [dirtyItems];
    console.log(`[StatsSyncWorker] Syncing stats for ${items.length} items...`);

    const updates = [];

    // 2. Fetch latest counts from Redis for each item
    for (const item of items) {
        const [type, id] = item.split(":"); // Format: "series:uuid" or "reel:uuid"
        if (!type || !id) continue;

        const [likes, views, saves] = await redis.mget(
            redisLikesKey(type, id),
            redisViewsKey(type, id),
            redisSavesKey(type, id)
        );

        updates.push({
            type: type.toUpperCase() as "SERIES" | "REEL",
            id,
            likes: parseInt(likes ?? "0", 10) || 0,
            views: parseInt(views ?? "0", 10) || 0,
            saves: parseInt(saves ?? "0", 10) || 0,
        });
    }

    // 3. Bulk Upsert into ContentStats
    if (updates.length > 0) {
        await prisma.$transaction(
            updates.map(u =>
                prisma.contentStats.upsert({
                    where: { contentType_contentId: { contentType: u.type, contentId: u.id } },
                    update: {
                        likeCount: u.likes,
                        viewCount: u.views,
                        saveCount: u.saves,
                        lastSyncedAt: new Date(),
                    },
                    create: {
                        contentType: u.type,
                        contentId: u.id,
                        likeCount: u.likes,
                        viewCount: u.views,
                        saveCount: u.saves,
                    },
                })
            )
        );
        console.log(`[StatsSyncWorker] Successfully synced ${updates.length} stats records.`);
    }
}
