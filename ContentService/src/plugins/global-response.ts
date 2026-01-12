
import fp from "fastify-plugin";
import { FastifyPluginAsync } from "fastify";

const GlobalResponsePlugin: FastifyPluginAsync = async (fastify) => {
    // 1. Wrap successful responses
    fastify.addHook("onSend", async (request, reply, payload) => {
        const { statusCode } = reply;

        // Skip wrapping if it's already wrapped or not a JSON response we want to touch
        const contentType = reply.getHeader("content-type");
        if (typeof contentType === 'string' && !contentType.includes("application/json")) {
            return payload;
        }

        // Try parsing existing payload
        let data;
        try {
            data = JSON.parse(payload as string);
        } catch {
            data = payload; // If string plain text
        }

        // Attempt to avoid double wrapping if the data already looks like our structure
        // This is a naive check but helpful
        if (data && typeof data === 'object' && 'success' in data && 'statusCode' in data) {
            return payload;
        }

        const wrapped = {
            success: statusCode >= 200 && statusCode < 300,
            statusCode,
            userMessage: statusCode >= 200 && statusCode < 300 ? "Success" : "Operation completed",
            developerMessage: "Success",
            data: data ?? {},
        };

        return JSON.stringify(wrapped);
    });

    // 2. Wrap Errors
    fastify.setErrorHandler((error, request, reply) => {
        const statusCode = error.statusCode ?? 500;

        // Log error (normally fastify default logger handles this, but we ensure it)
        if (statusCode >= 500) {
            request.log.error(error);
        }

        const wrapped = {
            success: false,
            statusCode,
            userMessage: error.message || "An unexpected error occurred",
            developerMessage: error.stack ?? error.name ?? "Unknown Error",
            data: {}
        };

        reply.status(statusCode).send(wrapped);
    });
};

export default fp(GlobalResponsePlugin);
