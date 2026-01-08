import fp from "fastify-plugin";
import Redis from "ioredis";
import { loadConfig } from "../config";

export default fp(
  async function redisPlugin(fastify) {
    const config = loadConfig();

    const client = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
    });

    fastify.decorate("redis", client);

    fastify.addHook("onReady", async () => {
      if (config.NODE_ENV === "test") {
        fastify.log.debug(
          { component: "redis" },
          "Skipping Redis connection in test environment"
        );
        return;
      }

      try {
        await client.connect();
        fastify.log.info(
          { component: "redis" },
          "Redis connection established"
        );
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to connect to Redis");
        throw error;
      }
    });

    fastify.addHook("onClose", async () => {
      await client.quit();
    });
  },
  { name: "redis" }
);
