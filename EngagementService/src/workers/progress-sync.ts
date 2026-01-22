import { getRedisOptional } from "../lib/redis";
import { getPrisma } from "../lib/prisma";

const DIRTY_PROGRESS_SET = "view_progress:dirty_set";
const BATCH_SIZE = 100;
const SYNC_INTERVAL_MS = 10 * 1000; // 10 seconds

function viewProgressKey(userId: string, episodeId: string) {
    return `view_progress:${userId}:${episodeId}`;
}

export function startProgressSyncWorker() {
    console.log("[ProgressSyncWorker] Starting worker...");

    setInterval(async () => {
        try {
            await syncProgressBatch();
        } catch (err) {
            console.error("[ProgressSyncWorker] Error during sync:", err);
        }
    }, SYNC_INTERVAL_MS);
}

async function syncProgressBatch() {
    const redis = getRedisOptional();
    const prisma = getPrisma();

    if (!redis || !prisma) {
        // Services might be initializing or shutting down
        return;
    }

    // 1. Pop batch of dirty keys
    const dirtyItems = await redis.spop(DIRTY_PROGRESS_SET, BATCH_SIZE);

    if (!dirtyItems || dirtyItems.length === 0) {
        return; // Nothing to sync
    }

    const items = Array.isArray(dirtyItems) ? dirtyItems : [dirtyItems];
    console.log(`[ProgressSyncWorker] Syncing ${items.length} items to DB...`);

    // 2. Fetch latest state for each item
    const updates = [];

    for (const item of items) {
        const [userId, episodeId] = item.split(":");
        if (!userId || !episodeId) continue;

        const key = viewProgressKey(userId, episodeId);
        const data = await redis.hgetall(key);

        if (data && Object.keys(data).length > 0) {
            updates.push({
                userId,
                episodeId,
                progressSeconds: parseInt(data.progressSeconds),
                durationSeconds: parseInt(data.durationSeconds),
                completedAt: data.completedAt ? new Date(data.completedAt) : null,
                updatedAt: new Date(data.updatedAt),
            });
        }
    }

    // 3. Perform Bulk Upsert (One by one in transaction for simplicity with Prisma upsert)
    // Optimization: Prisma doesn't support bulk upsert easily across different IDs without raw SQL
    // or iterating. For 100 items every 10s, Promise.all is acceptable.

    if (updates.length > 0) {
        await prisma.$transaction(
            updates.map(u =>
                prisma.viewProgress.upsert({
                    where: { userId_episodeId: { userId: u.userId, episodeId: u.episodeId } },
                    update: {
                        progressSeconds: u.progressSeconds,
                        durationSeconds: u.durationSeconds,
                        completedAt: u.completedAt,
                        updatedAt: u.updatedAt
                    },
                    create: {
                        userId: u.userId,
                        episodeId: u.episodeId,
                        progressSeconds: u.progressSeconds,
                        durationSeconds: u.durationSeconds,
                        completedAt: u.completedAt,
                        // createdAt defaults to now
                    }
                })
            )
        );
        console.log(`[ProgressSyncWorker] Successfully synced ${updates.length} records.`);
    }
}
