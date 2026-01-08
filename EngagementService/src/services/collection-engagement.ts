import type Redis from "ioredis";

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
};

const memory: Record<EntityType, InMemoryState> = {
  reel: {
    likes: new Map(),
    views: new Map(),
    userLiked: new Map(),
    userSaved: new Map(),
  },
  series: {
    likes: new Map(),
    views: new Map(),
    userLiked: new Map(),
    userSaved: new Map(),
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
  entityType: EntityType;
  entityId: string;
  userId: string;
}): Promise<Stats & { liked: boolean }> {
  const { redis, entityType, entityId, userId } = params;

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

  const stats = await getStatsRedis(redis, entityType, entityId);
  return { ...stats, liked: true };
}

export async function unlikeEntity(params: {
  redis: Redis | null;
  entityType: EntityType;
  entityId: string;
  userId: string;
}): Promise<Stats & { liked: boolean }> {
  const { redis, entityType, entityId, userId } = params;

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

  const stats = await getStatsRedis(redis, entityType, entityId);
  return { ...stats, liked: false };
}

export async function saveEntity(params: {
  redis: Redis | null;
  entityType: EntityType;
  entityId: string;
  userId: string;
}): Promise<{ saved: boolean }> {
  const { redis, entityType, entityId, userId } = params;

  if (!redis) {
    const state = memory[entityType];
    const savedSet = getOrCreateSet(state.userSaved, userId);
    savedSet.add(entityId);
    return { saved: true };
  }

  await redis.sadd(redisUserSavedKey(entityType, userId), entityId);
  return { saved: true };
}

export async function unsaveEntity(params: {
  redis: Redis | null;
  entityType: EntityType;
  entityId: string;
  userId: string;
}): Promise<{ saved: boolean }> {
  const { redis, entityType, entityId, userId } = params;

  if (!redis) {
    const state = memory[entityType];
    const savedSet = getOrCreateSet(state.userSaved, userId);
    savedSet.delete(entityId);
    return { saved: false };
  }

  await redis.srem(redisUserSavedKey(entityType, userId), entityId);
  return { saved: false };
}

export async function addView(params: {
  redis: Redis | null;
  entityType: EntityType;
  entityId: string;
}): Promise<{ views: number }> {
  const { redis, entityType, entityId } = params;

  if (!redis) {
    const state = memory[entityType];
    const key = entityKey(entityType, entityId);
    state.views.set(key, (state.views.get(key) ?? 0) + 1);
    return { views: getStatsMemory(entityType, entityId).views };
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

  if (!redis) {
    const state = memory[entityType];
    const map = collection === "liked" ? state.userLiked : state.userSaved;
    const set = map.get(userId);
    return set ? Array.from(set.values()) : [];
  }

  const key =
    collection === "liked"
      ? redisUserLikedKey(entityType, userId)
      : redisUserSavedKey(entityType, userId);

  const members = await redis.smembers(key);
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
