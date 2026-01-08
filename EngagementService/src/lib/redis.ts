import Redis from "ioredis";
import { loadConfig } from "../config";

let cachedRedis: Redis | null = null;

export function getRedisOptional(): Redis | null {
  if (cachedRedis) {
    return cachedRedis;
  }

  const config = loadConfig();
  if (!config.REDIS_URL) {
    return null;
  }

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
  if (!cachedRedis) {
    return;
  }
  const client = cachedRedis;
  cachedRedis = null;
  await client.quit();
}
