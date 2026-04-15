import Redis from "ioredis";
import { loadConfig } from "../config";

let cachedRedis: Redis | null = null;

export function getRedis(): Redis {
  if (cachedRedis) {
    return cachedRedis;
  }

  const config = loadConfig();
  const client = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });

  client.on("error", (error) => {
    console.error("Redis connection error", error);
  });

  cachedRedis = client;
  return cachedRedis;
}

export async function shutdownRedis() {
  if (!cachedRedis) return;
  const client = cachedRedis;
  cachedRedis = null;
  await client.quit();
}

export function buildEntitlementCacheKeys(userId: string): string[] {
  return [
    `entitlement:v2:${userId}:EPISODE`,
    `entitlement:v2:${userId}:REEL`,
  ];
}

export async function invalidateEntitlementCache(userId: string): Promise<void> {
  const redis = getRedis();
  const keys = buildEntitlementCacheKeys(userId);
  await redis.del(...keys).catch(() => {});
}
