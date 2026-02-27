import type Redis from "ioredis";
import { getRedisOptional } from "../lib/redis";
import { getPrisma } from "../lib/prisma";

const ACTION_QUEUE_KEY = "sync:actions:pending";
const BATCH_SIZE = 100;
const SYNC_INTERVAL_MS = 15 * 1000; // 15 seconds (more frequent than stats)

export function startUserActionSyncWorker() {
    console.log("[UserActionSyncWorker] Starting worker...");

    setInterval(async () => {
        try {
            await syncUserActionsBatch();
        } catch (err) {
            console.error("[UserActionSyncWorker] Error during sync:", err);
        }
    }, SYNC_INTERVAL_MS);
}

async function syncUserActionsBatch() {
    const redis = getRedisOptional();
    const prisma = getPrisma();

    if (!redis || !prisma) return;

    // 1. Fetch a batch of actions from the queue
    const rawActions = await redis.lrange(ACTION_QUEUE_KEY, 0, BATCH_SIZE - 1);
    if (!rawActions || rawActions.length === 0) return;

    console.log(`[UserActionSyncWorker] Processing ${rawActions.length} pending actions...`);

    const actions = rawActions.map(raw => JSON.parse(raw));

    // 2. Process actions into bulk upserts
    // Since we can have multiple actions for the same (user, content, type) in a single batch,
    // we should only process the LATEST state for each unique triple.
    const latestActions = new Map<string, any>();
    for (const action of actions) {
        const key = `${action.userId}:${action.contentType}:${action.contentId}:${action.actionType}`;
        // Map maintains insertion order, so the last one wins if we iterate normally.
        // Actually, actions are LPUSHed, so lrange 0..100 returns newest first.
        // So we should only set if NOT present to keep the LATEST status.
        if (!latestActions.has(key)) {
            latestActions.set(key, action);
        }
    }

    const uniqueActions = Array.from(latestActions.values());

    try {
        await prisma.$transaction(
            uniqueActions.map(a =>
                prisma.userAction.upsert({
                    where: {
                        userId_contentType_contentId_actionType: {
                            userId: a.userId,
                            contentType: a.contentType,
                            contentId: a.contentId,
                            actionType: a.actionType,
                        },
                    },
                    update: { isActive: a.isActive, updatedAt: new Date() },
                    create: {
                        userId: a.userId,
                        contentType: a.contentType,
                        contentId: a.contentId,
                        actionType: a.actionType,
                        isActive: a.isActive,
                    },
                })
            )
        );

        // 3. Trim the queue after successful write
        await redis.ltrim(ACTION_QUEUE_KEY, rawActions.length, -1);
        console.log(`[UserActionSyncWorker] Successfully synced ${uniqueActions.length} unique actions to DB.`);
    } catch (err) {
        console.error("[UserActionSyncWorker] Database write failed:", err);
        // We don't trim the queue, so it will retry. 
        // Note: This could cause partial duplicates if transaction failed halfway, 
        // but $transaction is atomic.
    }
}
