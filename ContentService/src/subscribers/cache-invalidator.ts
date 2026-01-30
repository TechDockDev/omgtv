
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { type Redis } from "ioredis";
import { getRedis } from "../lib/redis";
import { CatalogEvent } from "../services/catalog-events";

async function cacheInvalidationSubscriber(fastify: FastifyInstance) {
    const redis = getRedis().duplicate();

    fastify.addHook("onClose", async () => {
        await redis.quit();
    });

    const streamKey = "catalog_events_stream"; // Must match CatalogEventsPublisher default
    const consumerGroup = "content-service-cache-invalidator";
    const consumerName = `invalidator-${Math.random().toString(36).substring(7)}`;

    // 1. Ensure Group Exists
    try {
        await redis.xgroup("CREATE", streamKey, consumerGroup, "0", "MKSTREAM");
    } catch (error: any) {
        if (!error.message.includes("BUSYGROUP")) {
            fastify.log.error({ err: error }, "Failed to create consumer group for cache invalidator");
        }
    }

    // 2. Consume Loop
    const consume = async () => {
        try {
            const results = await (redis as any).xreadgroup(
                "GROUP",
                consumerGroup,
                consumerName,
                "BLOCK",
                0, // Block indefinitely
                "COUNT",
                10,
                "STREAMS",
                streamKey,
                ">"
            ) as any; // Cast to avoid complex tuple typing issues

            if (!results) return;

            for (const [stream, messages] of results) {
                for (const [id, fields] of messages) {
                    // Normalize fields (ioredis returns array of strings)
                    const data: Record<string, string> = {};
                    for (let i = 0; i < fields.length; i += 2) {
                        data[fields[i]] = fields[i + 1];
                    }

                    try {
                        const event = JSON.parse(data.data) as CatalogEvent;
                        const pipeline = redis.pipeline();
                        const entity = event.entity as string; // Loose check

                        switch (entity) {
                            case "episode": {
                                if (event.payload?.seriesSlug) {
                                    pipeline.del(`catalog:series:${event.payload.seriesSlug}`);
                                    const relatedKeys = await redis.keys(`catalog:related:${event.payload.seriesSlug}:*`);
                                    if (relatedKeys.length > 0) pipeline.del(relatedKeys);
                                }
                                break;
                            }
                            case "series": {
                                if (event.payload?.slug) {
                                    pipeline.del(`catalog:series:${event.payload.slug}`);
                                    const relatedKeys = await redis.keys(`catalog:related:${event.payload.slug}:*`);
                                    if (relatedKeys.length > 0) pipeline.del(relatedKeys);
                                }
                                const homeKeys = await redis.keys("home_series:*");
                                if (homeKeys.length > 0) pipeline.del(homeKeys);
                                const audioKeys = await redis.keys("audio_series:*");
                                if (audioKeys.length > 0) pipeline.del(audioKeys);
                                break;
                            }
                            case "reel": {
                                break;
                            }
                            case "category":
                            case "tag": {
                                const homeKeys = await redis.keys("home_series:*");
                                if (homeKeys.length > 0) pipeline.del(homeKeys);
                                const audioKeys = await redis.keys("audio_series:*");
                                if (audioKeys.length > 0) pipeline.del(audioKeys);
                                break;
                            }
                        }

                        if (pipeline.length > 0) {
                            await pipeline.exec();
                            console.log(`[CacheInvalidator] Processed ${entity} event and cleared keys.`);
                        }
                    } catch (err) {
                        console.error("[CacheInvalidator] Error processing message:", err);
                    }

                    await redis.xack(streamKey, consumerGroup, id);
                }
            }
        } catch (error) {
            fastify.log.error({ err: error }, "Error consuming catalog events for cache invalidation");
            // Wait a bit before retrying to avoid tight loop on error
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }

        // Keep loop running
        if (!fastify.server.listening) return; // Stop if server closing (approximate check)
        setImmediate(consume);
    };

    // Start consuming
    // We intentionally don't await this so it runs in background
    consume();
}

function parseEvent(fields: string[]): CatalogEvent | null {
    try {
        const data: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
            data[fields[i]] = fields[i + 1];
        }

        // Basic validation
        if (!data.type || !data.entity || !data.operation) return null;

        return {
            type: data.type as any,
            entity: data.entity as any,
            entityId: data.entityId,
            operation: data.operation as any,
            timestamp: data.timestamp,
            payload: data.payload ? JSON.parse(data.payload) : {},
        };
    } catch (e) {
        return null;
    }
}

async function invalidateCache(redis: Redis, event: CatalogEvent, log: FastifyInstance["log"]) {
    // Keys to invalidate:
    // 1. Series Detail: catalog:series:<slug>
    // 2. Related Series: catalog:related:<slug>:*
    // 3. Home Feed: home_series:* (brute force clear for simplicity on high level changes)
    // 4. Feed: catalog:feed:* (brute force clear or targeted?) 
    //    Feed is personalized, hard to target. 
    //    For now, we accept feed might be stale for 60s OR we brute force clear.
    //    Let's clear all home_series and catalog:series:<slug> as priority.

    const keysToDelete: string[] = [];

    // Helper to add series keys
    const addSeriesKeys = (slug?: string) => {
        if (!slug) return;
        keysToDelete.push(`catalog:series:${slug}`);
        keysToDelete.push(`catalog:related:${slug}:*`);
    };

    const payload = event.payload || {};

    switch (event.entity) {
        case "series":
            if (payload.slug) {
                addSeriesKeys(payload.slug as string);
                // Also clear home/lists because a series changed
                // Use scan to find or just accept short TTL?
                // Let's rely on pattern matching loop in deletion if needed, 
                // but redis doesn't support 'del pattern'.
                // We will delete specific known keys if possible.
            }
            break;

        case "episode":
            // Episode update affects its Series
            if (payload.seriesSlug) {
                addSeriesKeys(payload.seriesSlug as string);
            } else if (payload.seriesId) {
                // We might need to fetch slug if not in payload?
                // Plan said we'd add slug to payload.
                // If missing, we can't invalidate specific series easily without DB lookup.
                // Assuming payload has it.
            }
            break;

        case "season":
            if (payload.seriesSlug) {
                addSeriesKeys(payload.seriesSlug as string);
            }
            break;
    }

    if (keysToDelete.length > 0) {
        log.info({ keys: keysToDelete, event: event.type }, "Invalidating Cache Keys");

        // Handle wildcards manually if needed, or assume exact keys.
        // Ioredis doesn't auto-expand wildcards in del.
        // For 'catalog:related:<slug>:*', we need to scan.

        for (const keyPattern of keysToDelete) {
            if (keyPattern.includes("*")) {
                const stream = redis.scanStream({ match: keyPattern });
                stream.on("data", (keys) => {
                    if (keys.length) redis.unlink(keys);
                });
            } else {
                await redis.unlink(keyPattern);
            }
        }
    }

    // Always clear Home Feeds on any Create/Delete (and maybe heavy Update)
    // to ensure lists are fresh.
    if (event.operation === "create" || event.operation === "delete") {
        const stream = redis.scanStream({ match: "home_series:*" });
        stream.on("data", (keys) => {
            if (keys.length) redis.unlink(keys);
        });
    }
}

export default fp(cacheInvalidationSubscriber, {
    name: "cache-invalidation-subscriber",
});
