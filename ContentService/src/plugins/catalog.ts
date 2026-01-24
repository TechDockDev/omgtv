import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { CatalogRepository } from "../repositories/catalog-repository";
import { CatalogService } from "../services/catalog-service";
import { RedisCatalogEventsPublisher } from "../services/catalog-events";
import { getRedis } from "../lib/redis";
import { loadConfig } from "../config";

declare module "fastify" {
    interface FastifyInstance {
        catalogService: CatalogService;
    }
}

async function catalogPlugin(fastify: FastifyInstance) {
    const config = loadConfig();
    const repo = new CatalogRepository();
    const redis = getRedis();
    const events = new RedisCatalogEventsPublisher(
        redis,
        config.CATALOG_EVENT_STREAM_KEY
    );

    const catalogService = new CatalogService({
        defaultOwnerId: config.DEFAULT_OWNER_ID,
        repository: repo,
        eventsPublisher: events,
        pubsub: fastify.pubsub,
        config,
    });

    fastify.decorate("catalogService", catalogService);
}

export default fp(catalogPlugin, {
    name: "catalog",
    dependencies: ["prisma"],
});
