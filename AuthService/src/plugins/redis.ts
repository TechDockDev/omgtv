import { Redis } from "ioredis";
import { loadConfig } from "../config";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const config = loadConfig();

declare module "fastify" {
    interface FastifyInstance {
        redis: Redis;
    }
}

export const redisPlugin: FastifyPluginAsync = fp(async (fastify) => {
    const redis = new Redis(config.REDIS_URL);

    redis.on("error", (err) => {
        fastify.log.error({ err }, "Redis connection error");
    });

    redis.on("connect", () => {
        fastify.log.info("Redis connected");
    });

    fastify.decorate("redis", redis);

    fastify.addHook("onClose", async (instance) => {
        await instance.redis.quit();
    });
});
