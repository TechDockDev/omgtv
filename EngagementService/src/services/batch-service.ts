import type Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";
import type { ContentType, Action } from "../schemas/batch";

type EntityType = "reel" | "series";

interface BatchActionItem {
    contentType: ContentType;
    contentId: string;
    action: Action;
}

interface BatchServiceDeps {
    redis: Redis | null;
    prisma: PrismaClient | null;
}

// Redis key helpers
function redisLikesKey(entityType: EntityType, entityId: string) {
    return `eng:${entityType}:${entityId}:likes`;
}

function redisViewsKey(entityType: EntityType, entityId: string) {
    return `eng:${entityType}:${entityId}:views`;
}

function redisUserLikedKey(entityType: EntityType, userId: string) {
    return `eng:user:${userId}:${entityType}:liked`;
}

function redisUserSavedKey(entityType: EntityType, userId: string) {
    return `eng:user:${userId}:${entityType}:saved`;
}

/**
 * Process a batch of interaction actions.
 * Writes to Redis immediately, then persists to DB asynchronously.
 */
export async function processBatchInteractions(
    deps: BatchServiceDeps,
    userId: string,
    actions: BatchActionItem[]
): Promise<{ processed: number; failed: number }> {
    const { redis, prisma } = deps;
    let processed = 0;
    let failed = 0;

    for (const item of actions) {
        try {
            const entityType = item.contentType as EntityType;

            switch (item.action) {
                case "like":
                    await handleLike(redis, prisma, userId, entityType, item.contentId);
                    break;
                case "unlike":
                    await handleUnlike(redis, prisma, userId, entityType, item.contentId);
                    break;
                case "save":
                    await handleSave(redis, prisma, userId, entityType, item.contentId);
                    break;
                case "unsave":
                    await handleUnsave(redis, prisma, userId, entityType, item.contentId);
                    break;
                case "view":
                    await handleView(redis, prisma, entityType, item.contentId);
                    break;
            }
            processed++;
        } catch (error) {
            failed++;
            console.error("Batch action failed:", error);
        }
    }

    return { processed, failed };
}

async function handleLike(
    redis: Redis | null,
    prisma: PrismaClient | null,
    userId: string,
    entityType: EntityType,
    contentId: string
): Promise<void> {
    // Redis: atomic like
    if (redis) {
        const added = await redis.sadd(redisUserLikedKey(entityType, userId), contentId);
        if (added === 1) {
            await redis.incr(redisLikesKey(entityType, contentId));
        }
    }

    // DB: async write-through (fire and forget)
    if (prisma) {
        void prisma.userAction
            .upsert({
                where: {
                    userId_contentType_contentId_actionType: {
                        userId,
                        contentType: entityType.toUpperCase() as "REEL" | "SERIES",
                        contentId,
                        actionType: "LIKE",
                    },
                },
                create: {
                    userId,
                    contentType: entityType.toUpperCase() as "REEL" | "SERIES",
                    contentId,
                    actionType: "LIKE",
                    isActive: true,
                },
                update: {
                    isActive: true,
                },
            })
            .catch((err) => console.error("DB like write failed:", err));
    }
}

async function handleUnlike(
    redis: Redis | null,
    prisma: PrismaClient | null,
    userId: string,
    entityType: EntityType,
    contentId: string
): Promise<void> {
    if (redis) {
        const removed = await redis.srem(redisUserLikedKey(entityType, userId), contentId);
        if (removed === 1) {
            const newCount = await redis.decr(redisLikesKey(entityType, contentId));
            if (newCount < 0) {
                await redis.set(redisLikesKey(entityType, contentId), "0");
            }
        }
    }

    if (prisma) {
        void prisma.userAction
            .updateMany({
                where: {
                    userId,
                    contentType: entityType.toUpperCase() as "REEL" | "SERIES",
                    contentId,
                    actionType: "LIKE",
                },
                data: { isActive: false },
            })
            .catch((err) => console.error("DB unlike write failed:", err));
    }
}

async function handleSave(
    redis: Redis | null,
    prisma: PrismaClient | null,
    userId: string,
    entityType: EntityType,
    contentId: string
): Promise<void> {
    if (redis) {
        await redis.sadd(redisUserSavedKey(entityType, userId), contentId);
    }

    if (prisma) {
        void prisma.userAction
            .upsert({
                where: {
                    userId_contentType_contentId_actionType: {
                        userId,
                        contentType: entityType.toUpperCase() as "REEL" | "SERIES",
                        contentId,
                        actionType: "SAVE",
                    },
                },
                create: {
                    userId,
                    contentType: entityType.toUpperCase() as "REEL" | "SERIES",
                    contentId,
                    actionType: "SAVE",
                    isActive: true,
                },
                update: {
                    isActive: true,
                },
            })
            .catch((err) => console.error("DB save write failed:", err));
    }
}

async function handleUnsave(
    redis: Redis | null,
    prisma: PrismaClient | null,
    userId: string,
    entityType: EntityType,
    contentId: string
): Promise<void> {
    if (redis) {
        await redis.srem(redisUserSavedKey(entityType, userId), contentId);
    }

    if (prisma) {
        void prisma.userAction
            .updateMany({
                where: {
                    userId,
                    contentType: entityType.toUpperCase() as "REEL" | "SERIES",
                    contentId,
                    actionType: "SAVE",
                },
                data: { isActive: false },
            })
            .catch((err) => console.error("DB unsave write failed:", err));
    }
}

async function handleView(
    redis: Redis | null,
    prisma: PrismaClient | null,
    entityType: EntityType,
    contentId: string
): Promise<void> {
    if (redis) {
        await redis.incr(redisViewsKey(entityType, contentId));
    }

    // For views, we update the aggregate stats table (not per-user action)
    if (prisma) {
        void prisma.contentStats
            .upsert({
                where: {
                    contentType_contentId: {
                        contentType: entityType.toUpperCase() as "REEL" | "SERIES",
                        contentId,
                    },
                },
                create: {
                    contentType: entityType.toUpperCase() as "REEL" | "SERIES",
                    contentId,
                    viewCount: 1,
                },
                update: {
                    viewCount: { increment: 1 },
                    lastSyncedAt: new Date(),
                },
            })
            .catch((err) => console.error("DB view write failed:", err));
    }
}

/**
 * Get user state for multiple content items.
 * Used by ContentService to enrich responses.
 */
export async function getUserStates(
    deps: BatchServiceDeps,
    userId: string,
    items: Array<{ contentType: ContentType; contentId: string }>
): Promise<Record<string, { isLiked: boolean; isSaved: boolean; likeCount: number; viewCount: number }>> {
    const { redis, prisma } = deps;
    const result: Record<string, { isLiked: boolean; isSaved: boolean; likeCount: number; viewCount: number }> = {};

    if (items.length === 0) {
        return result;
    }

    // Group by content type for efficient Redis queries
    const reels = items.filter((i) => i.contentType === "reel");
    const series = items.filter((i) => i.contentType === "series");

    // Get user's liked/saved sets from Redis
    let reelLikedSet: Set<string> = new Set();
    let reelSavedSet: Set<string> = new Set();
    let seriesLikedSet: Set<string> = new Set();
    let seriesSavedSet: Set<string> = new Set();

    if (redis) {
        const [reelLiked, reelSaved, seriesLiked, seriesSaved] = await Promise.all([
            reels.length > 0 ? redis.smembers(redisUserLikedKey("reel", userId)) : [],
            reels.length > 0 ? redis.smembers(redisUserSavedKey("reel", userId)) : [],
            series.length > 0 ? redis.smembers(redisUserLikedKey("series", userId)) : [],
            series.length > 0 ? redis.smembers(redisUserSavedKey("series", userId)) : [],
        ]);
        reelLikedSet = new Set(reelLiked);
        reelSavedSet = new Set(reelSaved);
        seriesLikedSet = new Set(seriesLiked);
        seriesSavedSet = new Set(seriesSaved);
    }

    // Get counts from Redis
    const countKeys: string[] = [];
    for (const item of items) {
        countKeys.push(redisLikesKey(item.contentType as EntityType, item.contentId));
        countKeys.push(redisViewsKey(item.contentType as EntityType, item.contentId));
    }

    let countValues: (string | null)[] = [];
    if (redis && countKeys.length > 0) {
        countValues = await redis.mget(countKeys);
    }

    // Build result
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const key = `${item.contentType}:${item.contentId}`;
        const likeCount = parseInt(countValues[i * 2] ?? "0", 10) || 0;
        const viewCount = parseInt(countValues[i * 2 + 1] ?? "0", 10) || 0;

        let isLiked = false;
        let isSaved = false;

        if (item.contentType === "reel") {
            isLiked = reelLikedSet.has(item.contentId);
            isSaved = reelSavedSet.has(item.contentId);
        } else {
            isLiked = seriesLikedSet.has(item.contentId);
            isSaved = seriesSavedSet.has(item.contentId);
        }

        result[key] = { isLiked, isSaved, likeCount, viewCount };
    }

    // Fallback to DB if Redis is not available
    if (!redis && prisma) {
        // Get user actions from DB
        const userActions = await prisma.userAction.findMany({
            where: {
                userId,
                isActive: true,
                OR: items.map((item) => ({
                    contentType: item.contentType.toUpperCase() as "REEL" | "SERIES",
                    contentId: item.contentId,
                })),
            },
        });

        // Get stats from DB
        const stats = await prisma.contentStats.findMany({
            where: {
                OR: items.map((item) => ({
                    contentType: item.contentType.toUpperCase() as "REEL" | "SERIES",
                    contentId: item.contentId,
                })),
            },
        });

        for (const item of items) {
            const key = `${item.contentType}:${item.contentId}`;
            const contentType = item.contentType.toUpperCase() as "REEL" | "SERIES";

            const isLiked = userActions.some(
                (a) => a.contentId === item.contentId && a.contentType === contentType && a.actionType === "LIKE"
            );
            const isSaved = userActions.some(
                (a) => a.contentId === item.contentId && a.contentType === contentType && a.actionType === "SAVE"
            );
            const stat = stats.find((s) => s.contentId === item.contentId && s.contentType === contentType);

            result[key] = {
                isLiked,
                isSaved,
                likeCount: stat?.likeCount ?? 0,
                viewCount: stat?.viewCount ?? 0,
            };
        }
    }

    return result;
}
