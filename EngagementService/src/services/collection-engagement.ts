import type Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";

type EntityType = "reel" | "series";

type Stats = {
  likes: number;
  views: number;
};

type InMemoryState = {
  likes: Map<string, number>;
  views: Map<string, number>;
  userLiked: Map<string, Set<string>>;
  userSaved: Map<string, Set<string>>;
  reviews: Map<string, Array<{
    id: string;
    userId: string;
    userName: string;
    rating: number;
    title: string;
    comment: string;
    createdAt: string;
  }>>;
};

const memory: Record<EntityType, InMemoryState> = {
  reel: {
    likes: new Map(),
    views: new Map(),
    userLiked: new Map(),
    userSaved: new Map(),
    reviews: new Map(),
  },
  series: {
    likes: new Map(),
    views: new Map(),
    userLiked: new Map(),
    userSaved: new Map(),
    reviews: new Map(),
  },
};

function entityKey(entityType: EntityType, entityId: string) {
  return `${entityType}:${entityId}`;
}

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

function redisReviewListKey(entityType: EntityType, entityId: string) {
  return `eng:${entityType}:${entityId}:reviews:list`;
}

function redisReviewStatsKey(entityType: EntityType, entityId: string) {
  return `eng:${entityType}:${entityId}:reviews:stats`;
}

function redisUserReviewKey(entityType: EntityType, userId: string) {
  return `eng:user:${userId}:${entityType}:reviews`;
}

function clampNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function parseRedisInt(value: string | null) {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getOrCreateSet(map: Map<string, Set<string>>, userId: string) {
  const existing = map.get(userId);
  if (existing) return existing;
  const created = new Set<string>();
  map.set(userId, created);
  return created;
}

async function getStatsRedis(
  redis: Redis,
  entityType: EntityType,
  entityId: string
): Promise<Stats> {
  const [likesRaw, viewsRaw] = await redis.mget(
    redisLikesKey(entityType, entityId),
    redisViewsKey(entityType, entityId)
  );
  return {
    likes: clampNonNegative(parseRedisInt(likesRaw)),
    views: clampNonNegative(parseRedisInt(viewsRaw)),
  };
}

function getStatsMemory(entityType: EntityType, entityId: string): Stats {
  const state = memory[entityType];
  return {
    likes: clampNonNegative(
      state.likes.get(entityKey(entityType, entityId)) ?? 0
    ),
    views: clampNonNegative(
      state.views.get(entityKey(entityType, entityId)) ?? 0
    ),
  };
}

export async function likeEntity(params: {
  redis: Redis | null;
  prisma: PrismaClient | null;
  entityType: EntityType;
  entityId: string;
  userId: string;
}): Promise<Stats & { liked: boolean }> {
  const { redis, prisma, entityType, entityId, userId } = params;

  if (!redis) {
    const state = memory[entityType];
    const likedSet = getOrCreateSet(state.userLiked, userId);
    const already = likedSet.has(entityId);
    if (!already) {
      likedSet.add(entityId);
      const key = entityKey(entityType, entityId);
      state.likes.set(key, (state.likes.get(key) ?? 0) + 1);
    }
    const stats = getStatsMemory(entityType, entityId);
    return { ...stats, liked: true };
  }

  const userKey = redisUserLikedKey(entityType, userId);
  const added = await redis.sadd(userKey, entityId);
  if (added === 1) {
    await redis.incr(redisLikesKey(entityType, entityId));
  }

  if (prisma) {
    void prisma.$transaction([
      prisma.userAction.upsert({
        where: {
          userId_contentType_contentId_actionType: {
            userId,
            contentType: entityType.toUpperCase() as "REEL" | "SERIES",
            contentId: entityId,
            actionType: "LIKE",
          },
        },
        create: {
          userId,
          contentType: entityType.toUpperCase() as "REEL" | "SERIES",
          contentId: entityId,
          actionType: "LIKE",
          isActive: true,
        },
        update: {
          isActive: true,
        },
      }),
      prisma.contentStats.upsert({
        where: {
          contentType_contentId: {
            contentType: entityType.toUpperCase() as "REEL" | "SERIES",
            contentId: entityId,
          },
        },
        create: {
          contentType: entityType.toUpperCase() as "REEL" | "SERIES",
          contentId: entityId,
          likeCount: 1,
        },
        update: {
          likeCount: { increment: 1 },
          lastSyncedAt: new Date(),
        },
      }),
    ]).catch((err) => console.error("DB like write failed:", err));
  }

  const stats = await getStatsRedis(redis, entityType, entityId);
  return { ...stats, liked: true };
}

export async function unlikeEntity(params: {
  redis: Redis | null;
  prisma: PrismaClient | null;
  entityType: EntityType;
  entityId: string;
  userId: string;
}): Promise<Stats & { liked: boolean }> {
  const { redis, prisma, entityType, entityId, userId } = params;

  if (!redis) {
    const state = memory[entityType];
    const likedSet = getOrCreateSet(state.userLiked, userId);
    const removed = likedSet.delete(entityId);
    if (removed) {
      const key = entityKey(entityType, entityId);
      state.likes.set(key, Math.max(0, (state.likes.get(key) ?? 0) - 1));
    }
    const stats = getStatsMemory(entityType, entityId);
    return { ...stats, liked: false };
  }

  const userKey = redisUserLikedKey(entityType, userId);
  const removed = await redis.srem(userKey, entityId);
  if (removed === 1) {
    const newCount = await redis.decr(redisLikesKey(entityType, entityId));
    if (newCount < 0) {
      await redis.set(redisLikesKey(entityType, entityId), "0");
    }
  }

  if (prisma) {
    void prisma.$transaction([
      prisma.userAction.updateMany({
        where: {
          userId,
          contentType: entityType.toUpperCase() as "REEL" | "SERIES",
          contentId: entityId,
          actionType: "LIKE",
        },
        data: { isActive: false },
      }),
      prisma.contentStats.update({
        where: {
          contentType_contentId: {
            contentType: entityType.toUpperCase() as "REEL" | "SERIES",
            contentId: entityId,
          },
        },
        data: {
          likeCount: { decrement: 1 },
          lastSyncedAt: new Date(),
        },
      }),
    ]).catch((err) => console.error("DB unlike write failed:", err));
  }

  const stats = await getStatsRedis(redis, entityType, entityId);
  return { ...stats, liked: false };
}

export async function saveEntity(params: {
  redis: Redis | null;
  prisma: PrismaClient | null;
  entityType: EntityType;
  entityId: string;
  userId: string;
}): Promise<{ saved: boolean }> {
  const { redis, prisma, entityType, entityId, userId } = params;

  if (!redis) {
    const state = memory[entityType];
    const savedSet = getOrCreateSet(state.userSaved, userId);
    savedSet.add(entityId);
    return { saved: true };
  }

  if (prisma) {
    void prisma.$transaction([
      prisma.userAction.upsert({
        where: {
          userId_contentType_contentId_actionType: {
            userId,
            contentType: entityType.toUpperCase() as "REEL" | "SERIES",
            contentId: entityId,
            actionType: "SAVE",
          },
        },
        create: {
          userId,
          contentType: entityType.toUpperCase() as "REEL" | "SERIES",
          contentId: entityId,
          actionType: "SAVE",
          isActive: true,
        },
        update: {
          isActive: true,
        },
      }),
      prisma.contentStats.upsert({
        where: {
          contentType_contentId: {
            contentType: entityType.toUpperCase() as "REEL" | "SERIES",
            contentId: entityId,
          },
        },
        create: {
          contentType: entityType.toUpperCase() as "REEL" | "SERIES",
          contentId: entityId,
          saveCount: 1,
        },
        update: {
          saveCount: { increment: 1 },
          lastSyncedAt: new Date(),
        },
      }),
    ]).catch((err) => console.error("DB save write failed:", err));
  }

  await redis.sadd(redisUserSavedKey(entityType, userId), entityId);
  return { saved: true };
}

export async function unsaveEntity(params: {
  redis: Redis | null;
  prisma: PrismaClient | null;
  entityType: EntityType;
  entityId: string;
  userId: string;
}): Promise<{ saved: boolean }> {
  const { redis, prisma, entityType, entityId, userId } = params;

  if (!redis) {
    const state = memory[entityType];
    const savedSet = getOrCreateSet(state.userSaved, userId);
    savedSet.delete(entityId);
    return { saved: false };
  }

  if (prisma) {
    void prisma.$transaction([
      prisma.userAction.updateMany({
        where: {
          userId,
          contentType: entityType.toUpperCase() as "REEL" | "SERIES",
          contentId: entityId,
          actionType: "SAVE",
        },
        data: { isActive: false },
      }),
      prisma.contentStats.update({
        where: {
          contentType_contentId: {
            contentType: entityType.toUpperCase() as "REEL" | "SERIES",
            contentId: entityId,
          },
        },
        data: {
          saveCount: { decrement: 1 },
          lastSyncedAt: new Date(),
        },
      }),
    ]).catch((err) => console.error("DB unsave write failed:", err));
  }

  await redis.srem(redisUserSavedKey(entityType, userId), entityId);
  return { saved: false };
}

export async function addView(params: {
  redis: Redis | null;
  prisma: PrismaClient | null;
  entityType: EntityType;
  entityId: string;
}): Promise<{ views: number }> {
  const { redis, prisma, entityType, entityId } = params;

  if (!redis) {
    const state = memory[entityType];
    const key = entityKey(entityType, entityId);
    state.views.set(key, (state.views.get(key) ?? 0) + 1);
    return { views: getStatsMemory(entityType, entityId).views };
  }

  if (prisma) {
    void prisma.contentStats
      .upsert({
        where: {
          contentType_contentId: {
            contentType: entityType.toUpperCase() as "REEL" | "SERIES",
            contentId: entityId,
          },
        },
        create: {
          contentType: entityType.toUpperCase() as "REEL" | "SERIES",
          contentId: entityId,
          viewCount: 1,
        },
        update: {
          viewCount: { increment: 1 },
          lastSyncedAt: new Date(),
        },
      })
      .catch((err) => console.error("DB view write failed:", err));
  }

  const views = await redis.incr(redisViewsKey(entityType, entityId));
  return { views: clampNonNegative(views) };
}

export async function getStats(params: {
  redis: Redis | null;
  entityType: EntityType;
  entityId: string;
}): Promise<Stats> {
  const { redis, entityType, entityId } = params;
  if (!redis) {
    return getStatsMemory(entityType, entityId);
  }
  return getStatsRedis(redis, entityType, entityId);
}

export async function listUserEntities(params: {
  redis: Redis | null;
  entityType: EntityType;
  collection: "liked" | "saved";
  userId: string;
}): Promise<string[]> {
  const { redis, entityType, collection, userId } = params;

  console.log(`[DEBUG listUserEntities] redis=${!!redis}, entityType=${entityType}, collection=${collection}, userId=${userId}`);

  if (!redis) {
    const state = memory[entityType];
    const map = collection === "liked" ? state.userLiked : state.userSaved;
    const set = map.get(userId);
    const result = set ? Array.from(set.values()) : [];
    console.log(`[DEBUG listUserEntities] Using memory, result:`, result);
    return result;
  }

  const key =
    collection === "liked"
      ? redisUserLikedKey(entityType, userId)
      : redisUserSavedKey(entityType, userId);

  console.log(`[DEBUG listUserEntities] Redis key:`, key);
  const members = await redis.smembers(key);
  console.log(`[DEBUG listUserEntities] Redis members:`, members);
  return members;
}

export async function getStatsBatch(params: {
  redis: Redis | null;
  entityType: EntityType;
  entityIds: string[];
}): Promise<Record<string, Stats>> {
  const { redis, entityType, entityIds } = params;

  if (entityIds.length === 0) {
    return {};
  }

  if (!redis) {
    return entityIds.reduce<Record<string, Stats>>((acc, id) => {
      acc[id] = getStatsMemory(entityType, id);
      return acc;
    }, {});
  }

  const keys: string[] = [];
  entityIds.forEach((id) => {
    keys.push(redisLikesKey(entityType, id));
    keys.push(redisViewsKey(entityType, id));
  });

  const values = await redis.mget(keys);

  const result: Record<string, Stats> = {};
  for (let i = 0; i < entityIds.length; i += 1) {
    const likesRaw = values[i * 2] ?? null;
    const viewsRaw = values[i * 2 + 1] ?? null;
    result[entityIds[i]] = {
      likes: clampNonNegative(parseRedisInt(likesRaw)),
      views: clampNonNegative(parseRedisInt(viewsRaw)),
    };
  }

  return result;
}

export async function addReview(params: {
  redis: Redis | null;
  entityType: EntityType;
  entityId: string;
  userId: string;
  userName: string;
  rating: number;
  title: string;
  comment: string;
}): Promise<{ reviewId: string }> {
  const {
    redis,
    entityType,
    entityId,
    userId,
    userName,
    rating,
    title,
    comment,
  } = params;
  const reviewId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const reviewData = {
    review_id: reviewId,
    user_id: userId,
    user_name: userName,
    rating,
    title,
    comment,
    created_at: createdAt,
  };

  if (!redis) {
    const state = memory[entityType];
    const reviews = state.reviews.get(entityKey(entityType, entityId)) ?? [];
    reviews.unshift({
      id: reviewId,
      userId,
      userName,
      rating,
      title,
      comment,
      createdAt,
    });
    state.reviews.set(entityKey(entityType, entityId), reviews);
    return { reviewId };
  }

  // Use a transaction to update list and stats
  const multi = redis.multi();
  const listKey = redisReviewListKey(entityType, entityId);
  const statsKey = redisReviewStatsKey(entityType, entityId);

  // Push to front of list
  multi.lpush(listKey, JSON.stringify(reviewData));

  // Update stats
  // We store total_count and sum_ratings in a hash
  multi.hincrby(statsKey, "count", 1);
  multi.hincrby(statsKey, "sum", rating);

  await multi.exec();

  return { reviewId };
}

export async function getReviews(params: {
  redis: Redis | null;
  entityType: EntityType;
  entityId: string;
  limit?: number;
  cursor?: string;
}): Promise<{
  reviews: Array<any>;
  averageRating: number;
  totalReviews: number;
  nextCursor: string | null;
}> {
  const { redis, entityType, entityId, limit = 20 } = params;

  if (!redis) {
    const state = memory[entityType];
    const allReviews = state.reviews.get(entityKey(entityType, entityId)) ?? [];

    // Calculate stats
    const totalReviews = allReviews.length;
    const sumRatings = allReviews.reduce((sum, r) => sum + r.rating, 0);
    const averageRating = totalReviews > 0 ? sumRatings / totalReviews : 0;

    // Slice for pagination
    const startIndex = params.cursor ? parseInt(params.cursor, 10) : 0;
    const reviews = allReviews.slice(startIndex, startIndex + limit).map(r => ({
      review_id: r.id,
      user_id: r.userId,
      user_name: r.userName,
      rating: r.rating,
      title: r.title,
      comment: r.comment,
      created_at: r.createdAt
    }));

    const nextIndex = startIndex + limit;
    const nextCursor = nextIndex < totalReviews ? nextIndex.toString() : null;

    return { reviews, averageRating, totalReviews, nextCursor };
  }

  const listKey = redisReviewListKey(entityType, entityId);
  const statsKey = redisReviewStatsKey(entityType, entityId);

  const startIndex = params.cursor ? parseInt(params.cursor, 10) : 0;
  const stopIndex = startIndex + limit - 1;

  const [rawReviews, stats] = await Promise.all([
    redis.lrange(listKey, startIndex, stopIndex),
    redis.hmget(statsKey, "count", "sum")
  ]);

  const totalReviews = parseRedisInt(stats?.[0] ?? "0");
  const sumRatings = parseRedisInt(stats?.[1] ?? "0");
  const averageRating = totalReviews > 0 ? sumRatings / totalReviews : 0;

  const reviews = rawReviews.map(r => JSON.parse(r));
  const nextCursor = (startIndex + reviews.length) < totalReviews ? (startIndex + reviews.length).toString() : null;

  return {
    reviews,
    averageRating,
    totalReviews,
    nextCursor
  };
}

// User state batch query for content enrichment
export type UserStateEntry = {
  likeCount: number;
  viewCount: number;
  isLiked: boolean;
  isSaved: boolean;
};

export async function getUserStateBatch(params: {
  redis: Redis | null;
  prisma: PrismaClient | null;
  userId: string;
  items: Array<{ contentType: "reel" | "series"; contentId: string }>;
}): Promise<Record<string, UserStateEntry>> {
  const { redis, prisma, userId, items } = params;

  if (items.length === 0) {
    return {};
  }

  // Group items by entity type
  const reelIds = items
    .filter((item) => item.contentType === "reel")
    .map((item) => item.contentId);
  const seriesIds = items
    .filter((item) => item.contentType === "series")
    .map((item) => item.contentId);

  if (!redis) {
    // In-memory fallback
    const result: Record<string, UserStateEntry> = {};

    const reelState = memory.reel;
    const seriesState = memory.series;

    const userLikedReels = reelState.userLiked.get(userId) ?? new Set();
    const userSavedReels = reelState.userSaved.get(userId) ?? new Set();
    const userLikedSeries = seriesState.userLiked.get(userId) ?? new Set();
    const userSavedSeries = seriesState.userSaved.get(userId) ?? new Set();

    for (const id of reelIds) {
      result[`reel:${id}`] = {
        ...getStatsMemory("reel", id),
        likeCount: getStatsMemory("reel", id).likes,
        viewCount: getStatsMemory("reel", id).views,
        isLiked: userLikedReels.has(id),
        isSaved: userSavedReels.has(id),
      };
    }

    for (const id of seriesIds) {
      result[`series:${id}`] = {
        ...getStatsMemory("series", id),
        likeCount: getStatsMemory("series", id).likes,
        viewCount: getStatsMemory("series", id).views,
        isLiked: userLikedSeries.has(id),
        isSaved: userSavedSeries.has(id),
      };
    }

    return result;
  }

  // Redis optimized batch query using pipeline
  const pipeline = redis.pipeline();

  // Get stats for all items (likes & views)
  for (const item of items) {
    pipeline.get(redisLikesKey(item.contentType, item.contentId));
    pipeline.get(redisViewsKey(item.contentType, item.contentId));
  }

  // Check if user liked/saved each item
  for (const id of reelIds) {
    pipeline.sismember(redisUserLikedKey("reel", userId), id);
    pipeline.sismember(redisUserSavedKey("reel", userId), id);
  }
  for (const id of seriesIds) {
    pipeline.sismember(redisUserLikedKey("series", userId), id);
    pipeline.sismember(redisUserSavedKey("series", userId), id);
  }

  const results = await pipeline.exec();
  if (!results) {
    return {};
  }

  const result: Record<string, UserStateEntry> = {};
  let idx = 0;

  // Parse stats results
  for (const item of items) {
    const likesRaw = results[idx]?.[1] as string | null;
    const viewsRaw = results[idx + 1]?.[1] as string | null;
    result[`${item.contentType}:${item.contentId}`] = {
      likeCount: clampNonNegative(parseRedisInt(likesRaw)),
      viewCount: clampNonNegative(parseRedisInt(viewsRaw)),
      isLiked: false,
      isSaved: false,
    };
    idx += 2;
  }

  // Parse isLiked/isSaved for reels
  for (const id of reelIds) {
    const isLiked = (results[idx]?.[1] as number) === 1;
    const isSaved = (results[idx + 1]?.[1] as number) === 1;
    result[`reel:${id}`].isLiked = isLiked;
    result[`reel:${id}`].isSaved = isSaved;
    idx += 2;
  }

  // Parse isLiked/isSaved for series
  for (const id of seriesIds) {
    const isLiked = (results[idx]?.[1] as number) === 1;
    const isSaved = (results[idx + 1]?.[1] as number) === 1;
    result[`series:${id}`].isLiked = isLiked;
    result[`series:${id}`].isSaved = isSaved;
    idx += 2;
  }

  // 2. Database Fallback / Enrichment
  if (prisma) {
    try {
      // Fetch stats from DB
      const dbStats = await prisma.contentStats.findMany({
        where: {
          OR: items.map((item) => ({
            contentType: item.contentType.toUpperCase() as any,
            contentId: item.contentId,
          })),
        },
      });

      for (const stat of dbStats) {
        const key = `${stat.contentType.toLowerCase()}:${stat.contentId}`;
        const entry = result[key];
        if (entry) {
          // Use DB values if Redis is 0 or if we want to take the max
          entry.likeCount = Math.max(entry.likeCount, stat.likeCount);
          entry.viewCount = Math.max(entry.viewCount, stat.viewCount);
        }
      }

      // Fetch user actions (liked/saved)
      const userActions = await prisma.userAction.findMany({
        where: {
          userId,
          isActive: true,
          OR: items.map((item) => ({
            contentType: item.contentType.toUpperCase() as any,
            contentId: item.contentId,
          })),
        },
      });

      for (const action of userActions) {
        const key = `${action.contentType.toLowerCase()}:${action.contentId}`;
        const entry = result[key];
        if (entry) {
          if (action.actionType === "LIKE") entry.isLiked = true;
          if (action.actionType === "SAVE") entry.isSaved = true;
        }
      }
    } catch (dbError) {
      // Just log it, don't fail the whole request
      console.error("[EngagementService] DB fallback failed:", dbError);
    }
  }

  return result;
}

// View Progress (Persistent)
export async function upsertViewProgress(params: {
  redis: Redis | null;
  prisma: PrismaClient | null;
  userId: string;
  episodeId: string;
  progressSeconds: number;
  durationSeconds: number;
}): Promise<{
  progressSeconds: number;
  durationSeconds: number;
  completedAt: Date | null;
}> {
  const { prisma, userId, episodeId, progressSeconds, durationSeconds } = params;

  // We only support DB persistence for progress
  if (!prisma) {
    console.warn("[upsertViewProgress] Prisma not available, skipping write");
    return {
      progressSeconds,
      durationSeconds,
      completedAt: null,
    };
  }

  const isCompleted = progressSeconds >= durationSeconds * 0.9; // 90% completion threshold
  const completedAt = isCompleted ? new Date() : null;

  try {
    const result = await prisma.viewProgress.upsert({
      where: {
        userId_episodeId: {
          userId,
          episodeId,
        },
      },
      create: {
        userId,
        episodeId,
        progressSeconds: Math.floor(progressSeconds),
        durationSeconds: Math.floor(durationSeconds),
        completedAt,
      },
      update: {
        progressSeconds: Math.floor(progressSeconds),
        durationSeconds: Math.floor(durationSeconds),
        completedAt: completedAt ? completedAt : undefined, // Only update completedAt if completed now
      },
    });

    return {
      progressSeconds: result.progressSeconds,
      durationSeconds: result.durationSeconds,
      completedAt: result.completedAt,
    };
  } catch (error) {
    console.error("[upsertViewProgress] DB write failed:", error);
    throw error;
  }
}

export async function getViewProgress(params: {
  redis: Redis | null;
  prisma: PrismaClient | null;
  userId: string;
  episodeId: string;
}): Promise<{
  progressSeconds: number;
  durationSeconds: number;
  completedAt: Date | null;
} | null> {
  const { prisma, userId, episodeId } = params;

  if (!prisma) {
    return null;
  }

  const result = await prisma.viewProgress.findUnique({
    where: {
      userId_episodeId: {
        userId,
        episodeId,
      },
    },
  });

  if (!result) {
    return null;
  }

  return {
    progressSeconds: result.progressSeconds,
    durationSeconds: result.durationSeconds,
    completedAt: result.completedAt,
  };
}

export async function getViewProgressBatch(params: {
  prisma: PrismaClient | null;
  userId: string;
  episodeIds: string[];
}) {
  const { prisma, userId, episodeIds } = params;

  if (!prisma) {
    return [];
  }

  const progressList = await prisma.viewProgress.findMany({
    where: {
      userId,
      episodeId: { in: episodeIds },
    },
  });

  return progressList;
}
