import type { FastifyRequest, FastifyReply } from "fastify";
import { loadConfig } from "../config";

export const authenticateAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const config = loadConfig();
    const serviceTokenHeader = request.headers['x-service-token'];
    const serviceToken = Array.isArray(serviceTokenHeader) ? serviceTokenHeader[0] : serviceTokenHeader;

    // Check if it's an internal call from the gateway with a valid service token
    if (serviceToken && serviceToken === config.SERVICE_AUTH_TOKEN) {
        const userId = request.headers['x-user-id'] as string;
        const userType = request.headers['x-user-type'] as string;
        const roles = (request.headers['x-user-roles'] as string || '').split(',').filter(Boolean);

        if (userType === 'ADMIN') {
            // Populate request.user with info from headers
            request.user = {
                sub: userId,
                userType: 'ADMIN',
                adminId: userId,
                roles: roles,
                // sessionId is not available from headers usually, but we can set it if needed
            } as any;
            return;
        }
    }

    // fallback to standard JWT verification
    try {
        await request.jwtVerify();
        if (request.user.userType !== "ADMIN") {
            request.log.warn({ user: request.user }, "Non-admin user tried to access admin endpoint");
            throw new Error("Forbidden");
        }
    } catch (err: any) {
        request.log.error({ err: err.message, stack: err.stack }, "Admin authentication failed");
        reply.code(401).send({ error: "Unauthorized", message: err.message });
        throw err; // Stop further execution
    }
};
