import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PreferenceRepository } from '../repositories/preference';

export default async function preferenceRoutes(server: FastifyInstance) {
    // All routes in this module require authentication
    server.addHook('onRequest', server.authenticate);

    // GET /preferences
    server.get('/', async (request) => {
        const userId = request.user!.id;
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
    }, async (request) => {
        const userId = request.user!.id;
        const body = request.body as any;
        const updated = await PreferenceRepository.update(userId, body);
        return updated;
    });
}
