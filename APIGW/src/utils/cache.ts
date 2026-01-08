import type { Redis } from "ioredis";

/**
 * Fetches a cached JSON object by key, returning null if missing or invalid.
 */
export async function getCachedJson<T>(
  redis: Redis,
  key: string
): Promise<T | null> {
  const payload = await redis.get(key);
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    // Avoid serving corrupted cache entries; delete and fall back to fresh data.
    await redis.del(key);
    return null;
  }
}

/**
 * Stores a JSON-serializable value under the provided key with optional TTL seconds.
 */
export async function setCachedJson(
  redis: Redis,
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  const payload = JSON.stringify(value);
  if (ttlSeconds > 0) {
    await redis.set(key, payload, "EX", ttlSeconds);
    return;
  }
  await redis.set(key, payload);
}
