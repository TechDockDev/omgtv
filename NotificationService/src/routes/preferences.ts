import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PreferenceRepository } from '../repositories/preference';

export default async function preferenceRoutes(server: FastifyInstance) {
    // GET /preferences
    server.get('/', async (request, reply) => {
        const userId = request.headers['x-user-id'] as string;

        if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized: Missing x-user-id' });
        }

        const preferences = await PreferenceRepository.get(userId);
        return preferences;
    });

    // PATCH /preferences
    server.patch('/', {
        schema: {
            body: z.object({
                emailEnabled: z.boolean().optional(),
                pushEnabled: z.boolean().optional(),
                inAppEnabled: z.boolean().optional(),
                allowMarketing: z.boolean().optional(),
                allowTransactional: z.boolean().optional(),
                allowNewContent: z.boolean().optional(),
            }),
        }
    }, async (request, reply) => {
        const userId = request.headers['x-user-id'] as string;
        if (!userId) {
            return reply.status(401).send({ error: 'Unauthorized: Missing x-user-id' });
        }

        const body = request.body as any;
        const updated = await PreferenceRepository.update(userId, body);
        return updated;
    });
}
