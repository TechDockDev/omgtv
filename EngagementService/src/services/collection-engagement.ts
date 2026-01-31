import type Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";

type EntityType = "reel" | "series";

type Stats = {
  likes: number;
  views: number;
  saves: number;
  reviewCount?: number;
  averageRating?: number;
};

type InMemoryState = {
  likes: Map<string, number>;
  views: Map<string, number>;
  saves: Map<string, number>;
  userLiked: Map<string, Set<string>>;
  userSaved: Map<string, Set<string>>;
  reviews: Map<string, Array<{
    id: string;
    userId: string;
    userName: string;
    userPhone?: string;
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
    saves: new Map(),
    userLiked: new Map(),
    userSaved: new Map(),
    reviews: new Map(),
  },
  series: {
    likes: new Map(),
    views: new Map(),
    saves: new Map(),
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

function redisSavesKey(entityType: EntityType, entityId: string) {
  return `eng:${entityType}:${entityId}:saves`;
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

const DIRTY_STATS_SET = "stats:dirty_set";

function getOrCreateSet(map: Map<string, Set<string>>, userId: string) {
  const existing = map.get(userId);
  if (existing) return existing;
  const created = new Set<string>();
  map.set(userId, created);
  return created;
}

async function markDirty(redis: Redis, entityType: EntityType, entityId: string) {
  await redis.sadd(DIRTY_STATS_SET, `${entityType}:${entityId}`);
}

async function getStatsRedis(
  redis: Redis,
  entityType: EntityType,
  entityId: string,
  prisma?: PrismaClient | null
): Promise<Stats> {
  const keys = [
    redisLikesKey(entityType, entityId),
    redisViewsKey(entityType, entityId),
    redisSavesKey(entityType, entityId),
  ];
  const [likesRaw, viewsRaw, savesRaw] = await redis.mget(...keys);

  // Warm-up logic: if ANY keys are missing from Redis, try loading from DB
  if (prisma && (likesRaw === null || viewsRaw === null || savesRaw === null)) {
    const dbStat = await prisma.contentStats.findUnique({
      where: {
        contentType_contentId: {
          contentType: entityType.toUpperCase() as any,
          contentId: entityId,
        },
      },
    });

    if (dbStat) {
      const stats = {
        likes: dbStat.likeCount,
        views: dbStat.viewCount,
        saves: dbStat.saveCount,
      };
      // Populate Redis
      await redis.pipeline()
        .set(keys[0], stats.likes)
        .set(keys[1], stats.views)
        .set(keys[2], stats.saves)
        .exec();
      return stats;
    }
  }

  return {
    likes: clampNonNegative(parseRedisInt(likesRaw)),
    views: clampNonNegative(parseRedisInt(viewsRaw)),
    saves: clampNonNegative(parseRedisInt(savesRaw)),
    // Review stats not fetched here yet for single entity, defaulting to optional
  };
}

function getStatsMemory(entityType: EntityType, entityId: string): Stats {
  const state = memory[entityType];
  const key = entityKey(entityType, entityId);
  const reviews = state.reviews.get(key) ?? [];
  return {
    likes: clampNonNegative(state.likes.get(key) ?? 0),
    views: clampNonNegative(state.views.get(key) ?? 0),
    saves: clampNonNegative(state.saves.get(key) ?? 0),
    reviewCount: reviews.length,
    averageRating: reviews.length > 0
      ? Number((reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length).toFixed(1))
      : 0,
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
    await markDirty(redis, entityType, entityId);
  }

  if (prisma) {
    // Immediate per-user state (critical for UI)
    void prisma.userAction.upsert({
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
    }).catch((err) => console.error("DB like user-action failed:", err));
  }

  const stats = await getStatsRedis(redis, entityType, entityId, prisma);
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
    await markDirty(redis, entityType, entityId);
  }

  if (prisma) {
    void prisma.userAction.updateMany({
      where: {
        userId,
        contentType: entityType.toUpperCase() as "REEL" | "SERIES",
        contentId: entityId,
        actionType: "LIKE",
      },
      data: { isActive: false },
    }).catch((err) => console.error("DB unlike user-action failed:", err));
  }

  const stats = await getStatsRedis(redis, entityType, entityId, prisma);
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
    const already = savedSet.has(entityId);
    if (!already) {
      savedSet.add(entityId);
      const key = entityKey(entityType, entityId);
      state.saves.set(key, (state.saves.get(key) ?? 0) + 1);
    }
    return { saved: true };
  }

  if (prisma) {
    void prisma.userAction.upsert({
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
    }).catch((err) => console.error("DB save user-action failed:", err));
  }

  await redis.sadd(redisUserSavedKey(entityType, userId), entityId);
  await redis.incr(redisSavesKey(entityType, entityId));
  await markDirty(redis, entityType, entityId);
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
    const removed = savedSet.delete(entityId);
    if (removed) {
      const key = entityKey(entityType, entityId);
      state.saves.set(key, Math.max(0, (state.saves.get(key) ?? 0) - 1));
    }
    return { saved: false };
  }

  if (prisma) {
    void prisma.userAction.updateMany({
      where: {
        userId,
        contentType: entityType.toUpperCase() as "REEL" | "SERIES",
        contentId: entityId,
        actionType: "SAVE",
      },
      data: { isActive: false },
    }).catch((err) => console.error("DB unsave user-action failed:", err));
  }

  const removedCount = await redis.srem(redisUserSavedKey(entityType, userId), entityId);
  if (removedCount === 1) {
    const newCount = await redis.decr(redisSavesKey(entityType, entityId));
    if (newCount < 0) {
      await redis.set(redisSavesKey(entityType, entityId), "0");
    }
    await markDirty(redis, entityType, entityId);
  }
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

  const views = await redis.incr(redisViewsKey(entityType, entityId));
  await markDirty(redis, entityType, entityId);
  return { views: clampNonNegative(views) };
}

export async function getStats(params: {
  redis: Redis | null;
  prisma?: PrismaClient | null;
  entityType: EntityType;
  entityId: string;
}): Promise<Stats> {
  const { redis, prisma, entityType, entityId } = params;
  if (!redis) {
    return getStatsMemory(entityType, entityId);
  }
  return getStatsRedis(redis, entityType, entityId, prisma);
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
  prisma?: PrismaClient | null;
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
  // We won't use mget for mixed types (string + hash) efficiently without pipeline, 
  // and we already have a pipeline implementation below.
  // So removing this old block.

  const pipeline = redis.pipeline();
  for (const id of entityIds) {
    pipeline.get(redisLikesKey(entityType, id));
    pipeline.get(redisViewsKey(entityType, id));
    pipeline.get(redisSavesKey(entityType, id));
    pipeline.hgetall(redisReviewStatsKey(entityType, id));
  }

  const pipelineResults = await pipeline.exec();
  const result: Record<string, Stats> = {};

  if (!pipelineResults) return {};

  for (let i = 0; i < entityIds.length; i++) {
    // Pipeline results structure: [[error, result], [error, result], ...]
    // 4 commands per entity
    const likesRaw = pipelineResults[i * 4]?.[1] as string | null;
    const viewsRaw = pipelineResults[i * 4 + 1]?.[1] as string | null;
    const savesRaw = pipelineResults[i * 4 + 2]?.[1] as string | null;
    const reviewStatsRaw = pipelineResults[i * 4 + 3]?.[1] as Record<string, string> | null;

    if (likesRaw === null || viewsRaw === null || savesRaw === null) {
      result[entityIds[i]] = await getStatsRedis(redis, entityType, entityIds[i], params.prisma);
    } else {
      const count = reviewStatsRaw ? parseInt(reviewStatsRaw.count ?? "0", 10) : 0;
      const sum = reviewStatsRaw ? parseFloat(reviewStatsRaw.sum ?? "0") : 0;
      const avg = count > 0 ? sum / count : 0;

      result[entityIds[i]] = {
        likes: clampNonNegative(parseRedisInt(likesRaw)),
        views: clampNonNegative(parseRedisInt(viewsRaw)),
        saves: clampNonNegative(parseRedisInt(savesRaw)),
        reviewCount: count,
        averageRating: avg
      };
    }
  }

  return result;
}


export async function addReview(params: {
  redis: Redis | null;
  prisma?: PrismaClient | null;
  entityType: EntityType;
  entityId: string;
  userId: string;
  userName: string;
  userPhone?: string;
  rating: number;
  comment: string;
}): Promise<{ reviewId: string }> {
  const {
    redis,
    prisma,
    entityType,
    entityId,
    userId,
    userName,
    userPhone,
    rating,
    comment,
  } = params;

  // Persist to DB
  let reviewId: string = crypto.randomUUID();
  let createdAt = new Date().toISOString();

  if (prisma) {
    const review = await prisma.review.create({
      data: {
        userId,
        userName,
        userPhone,
        contentType: entityType.toUpperCase() as any, // "SERIES" | "REEL"
        contentId: entityId,
        rating,
        comment,
      },
    });
    reviewId = review.id;
    createdAt = review.createdAt.toISOString();
  } else {
    console.warn("Prisma instance missing in addReview, review will not be persisted to DB");
  }

  // Update Redis (cache) if available
  if (redis) {
    const reviewData = {
      review_id: reviewId,
      user_id: userId,
      user_name: userName,
      user_phone: userPhone,
      rating,
      comment, // no title
      created_at: createdAt,
    };

    // Use a transaction to update list and stats
    const multi = redis.multi();
    const listKey = redisReviewListKey(entityType, entityId);
    const statsKey = redisReviewStatsKey(entityType, entityId);

    // Push to front of list
    multi.lpush(listKey, JSON.stringify(reviewData));

    // Update stats
    multi.hincrby(statsKey, "count", 1);
    multi.hincrby(statsKey, "sum", rating);

    await multi.exec();
  } else {
    // Memory fallback
    const state = memory[entityType];
    const reviews = state.reviews.get(entityKey(entityType, entityId)) ?? [];
    reviews.unshift({
      id: reviewId,
      userId,
      userName,
      userPhone,
      rating,
      title: "",
      comment,
      createdAt,
    });
    state.reviews.set(entityKey(entityType, entityId), reviews);
  }

  return { reviewId };
}

export async function getReviews(params: {
  redis: Redis | null;
  prisma?: PrismaClient | null;
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
  const { redis, prisma, entityType, entityId, limit = 20 } = params;

  // Prefer DB for single source of truth, but Redis for speed?
  // User asked for reliability on reviews usually. 
  // Let's implement DB fetch primarily since Redis might lose data if not persistent.
  // But we still return stats from Redis if available for performance? 
  // Let's align with "warm up" strategy: if Redis missing, fetch DB.

  if (prisma) {
    // DB Implementation
    const where = {
      contentType: entityType.toUpperCase() as any,
      contentId: entityId
    };

    // Get stats (agg)
    const agg = await prisma.review.aggregate({
      where,
      _avg: { rating: true },
      _count: { rating: true }
    });

    const averageRating = agg._avg.rating ?? 0;
    const totalReviews = agg._count.rating ?? 0;

    // Get list
    const reviews = await prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {})
    });

    const mappedReviews = reviews.map(r => ({
      review_id: r.id,
      user_id: r.userId,
      user_name: r.userName,
      user_phone: r.userPhone,
      rating: r.rating,
      comment: r.comment,
      created_at: r.createdAt.toISOString()
    }));

    const nextCursor = reviews.length === limit ? reviews[reviews.length - 1].id : null;

    return {
      reviews: mappedReviews,
      averageRating,
      totalReviews,
      nextCursor
    };
  }

  // Fallback to Redis/Memory if Prisma not available (shouldn't happen in prod with DB)
  if (!redis) {
    // ... memory logic same as before ...
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
      user_phone: r.userPhone,
      rating: r.rating,
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
  saveCount: number;
  isLiked: boolean;
  isSaved: boolean;
  averageRating: number;
  reviewCount: number;
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
      const stats = getStatsMemory("reel", id);
      result[`reel:${id}`] = {
        likeCount: stats.likes,
        viewCount: stats.views,
        saveCount: stats.saves,
        averageRating: stats.averageRating ?? 0,
        reviewCount: stats.reviewCount ?? 0,
        isLiked: userLikedReels.has(id),
        isSaved: userSavedReels.has(id),
      };
    }

    for (const id of seriesIds) {
      const stats = getStatsMemory("series", id);
      result[`series:${id}`] = {
        likeCount: stats.likes,
        viewCount: stats.views,
        saveCount: stats.saves,
        averageRating: stats.averageRating ?? 0,
        reviewCount: stats.reviewCount ?? 0,
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
    pipeline.get(redisSavesKey(item.contentType, item.contentId));
    pipeline.hgetall(redisReviewStatsKey(item.contentType, item.contentId));
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
    const savesRaw = results[idx + 2]?.[1] as string | null;
    const reviewStatsRaw = results[idx + 3]?.[1] as Record<string, string> | null;

    const count = reviewStatsRaw ? parseInt(reviewStatsRaw.count ?? "0", 10) : 0;
    const sum = reviewStatsRaw ? parseFloat(reviewStatsRaw.sum ?? "0") : 0;
    const avg = count > 0 ? sum / count : 0;

    result[`${item.contentType}:${item.contentId}`] = {
      likeCount: clampNonNegative(parseRedisInt(likesRaw)),
      viewCount: clampNonNegative(parseRedisInt(viewsRaw)),
      saveCount: clampNonNegative(parseRedisInt(savesRaw)),
      averageRating: Number(avg.toFixed(1)),
      reviewCount: count,
      isLiked: false,
      isSaved: false,
    };
    idx += 4;
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
          entry.saveCount = Math.max(entry.saveCount, stat.saveCount);
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

      // Fetch rating summaries from DB
      const ratings = await prisma.review.groupBy({
        by: ['contentType', 'contentId'],
        where: {
          OR: items.map(item => ({
            contentType: item.contentType.toUpperCase() as any,
            contentId: item.contentId
          }))
        },
        _count: { _all: true },
        _avg: { rating: true }
      });

      for (const rating of ratings) {
        const key = `${rating.contentType.toLowerCase()}:${rating.contentId}`;
        const entry = result[key];
        if (entry) {
          entry.reviewCount = Math.max(entry.reviewCount ?? 0, rating._count._all);
          const dbAvg = rating._avg.rating ?? 0;
          if (dbAvg > 0) {
            entry.averageRating = Number(dbAvg.toFixed(1));
          }
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
