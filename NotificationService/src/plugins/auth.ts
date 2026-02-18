import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
    interface FastifyRequest {
        user?: {
            id: string;
            roles: string[];
            userType: string;
        };
    }
    interface FastifyInstance {
        authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
        requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    }
}

export default fp(async (fastify: FastifyInstance) => {
    fastify.decorateRequest('user', null);

    /**
     * Authenticate: Extracts user identity from headers set by the API Gateway.
     * The APIGW validates the JWT and forwards:
     *   x-user-id       — the authenticated user's ID
     *   x-user-roles    — comma-separated list of roles
     *   x-user-type     — "ADMIN" | "USER"
     */
    fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.headers['x-user-id'] as string;
        const userRoles = request.headers['x-user-roles'] as string;
        const userType = request.headers['x-user-type'] as string;

        if (!userId) {
            return reply.code(401).send({ error: 'Unauthorized: Missing user identity' });
        }

        request.user = {
            id: userId,
            roles: userRoles ? userRoles.split(',').map(r => r.trim()) : [],
            userType: userType || 'USER',
        };
    });

    /**
     * Require Admin: Ensures the request comes from an admin user.
     * Calls authenticate first if not already done, then checks x-user-type.
     */
    fastify.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!request.user) {
            await fastify.authenticate(request, reply);
            if (reply.sent) return;
        }

        if (request.user?.userType !== 'ADMIN') {
            return reply.code(403).send({ error: 'Forbidden: Admin access required' });
        }
    });
});
