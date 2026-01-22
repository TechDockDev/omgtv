import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

export default fp(async function swaggerPlugin(fastify: FastifyInstance) {
    await fastify.register(swagger, {
        transform: jsonSchemaTransform,
        openapi: {
            info: {
                title: "EngagementService API",
                description: "API for user interactions (likes, saves, views) and content engagement",
                version: "1.0.0",
            },
            servers: [
                {
                    url: "http://localhost:4700",
                    description: "Local development",
                },
            ],
            tags: [
                { name: "Batch", description: "Batch operations for syncing interactions" },
                { name: "User State", description: "Get user engagement state for content" },
                { name: "Interactions", description: "Individual interaction endpoints" },
                { name: "Progress", description: "Video progress tracking" },
            ],
            components: {
                securitySchemes: {
                    serviceAuth: {
                        type: "apiKey",
                        name: "x-service-auth",
                        in: "header",
                        description: "Service authentication token",
                    },
                    userId: {
                        type: "apiKey",
                        name: "x-user-id",
                        in: "header",
                        description: "User ID (UUID)",
                    },
                },
            },
        },
    });

    // Serve OpenAPI JSON at /openapi.json for APIGW aggregation
    fastify.get("/openapi.json", { config: { rateLimit: false } }, async () => {
        return fastify.swagger();
    });

    await fastify.register(swaggerUI, {
        routePrefix: "/docs",
        uiConfig: {
            docExpansion: "list",
            deepLinking: true,
        },
    });
});
