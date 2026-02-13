import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
    interface FastifyRequest {
        user?: {
            id: string;
            role: string;
        };
    }
}

export default fp(async (fastify: FastifyInstance) => {
    fastify.decorateRequest('user', null);

    fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.headers['x-user-id'] as string;
        const userRole = request.headers['x-user-role'] as string;

        if (!userId) {
            return reply.code(401).send({ error: 'Unauthorized: Missing x-user-id' });
        }

        request.user = {
            id: userId,
            role: userRole || 'user',
        };
    });

    fastify.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
        // Ensure authenticate was called first or call it here
        if (!request.user) {
            await (fastify as any).authenticate(request, reply);
            if (reply.sent) return;
        }

        if (request.user?.role !== 'admin') {
            return reply.code(403).send({ error: 'Forbidden: Admin access required' });
        }
    });
});
