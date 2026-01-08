import type { Redis } from "ioredis";
import { recordCacheEvent } from "../observability/metrics";

function normalizeCacheKey(key: string) {
  const segments = key.split(":").slice(0, 2);
  return segments.join(":") || key;
}

export async function getCachedJson<T>(
  redis: Redis,
  key: string
): Promise<T | null> {
  const payload = await redis.get(key);
  if (!payload) {
    recordCacheEvent("miss", normalizeCacheKey(key));
    return null;
  }
  try {
    recordCacheEvent("hit", normalizeCacheKey(key));
    return JSON.parse(payload) as T;
  } catch (error) {
    await redis.del(key);
    recordCacheEvent("invalidate", normalizeCacheKey(key));
    return null;
  }
}

export async function setCachedJson(
  redis: Redis,
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  const payload = JSON.stringify(value);
  if (ttlSeconds > 0) {
    await redis.set(key, payload, "EX", ttlSeconds);
    recordCacheEvent("set", normalizeCacheKey(key));
    return;
  }
  await redis.set(key, payload);
  recordCacheEvent("set", normalizeCacheKey(key));
}
