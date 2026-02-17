import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { campaignService } from '../services/CampaignService';
import { NotificationType } from '@prisma/client';

const createCampaignSchema = z.object({
    name: z.string().min(1).max(100),
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
    data: z.record(z.string()).optional(),
    targetCriteria: z.object({
        segment: z.enum(['SUBSCRIBERS', 'ALL']).optional(),
        custom: z.record(z.any()).optional()
    }).optional(),
    idempotencyKey: z.string().optional(),
    type: z.enum(['PUSH', 'EMAIL', 'IN_APP']),
    scheduledAt: z.string().datetime().optional(),
});

export default async function campaignRoutes(server: FastifyInstance) {
    /**
     * POST /admin/campaigns
     * Create a new campaign
     */
    server.post('/', {
        schema: { body: createCampaignSchema },
        preHandler: [(server as any).requireAdmin]
    }, async (request, reply) => {
        const body = createCampaignSchema.parse(request.body);

        const campaign = await campaignService.createCampaign({
            name: body.name,
            title: body.title,
            body: body.body,
            data: body.data || {},
            targetCriteria: body.targetCriteria || {},
            idempotencyKey: body.idempotencyKey,
            type: body.type as NotificationType,
            status: body.scheduledAt ? 'SCHEDULED' : 'DRAFT',
            scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        });

        return { success: true, campaign };
    });

    /**
     * GET /admin/campaigns
     * List campaigns
     */
    server.get('/', {
        preHandler: [(server as any).requireAdmin]
    }, async (request) => {
        const { limit, offset } = z.object({
            limit: z.coerce.number().optional().default(10),
            offset: z.coerce.number().optional().default(0),
        }).parse(request.query);

        const campaigns = await campaignService.listCampaigns(limit, offset);
        return { success: true, campaigns };
    });

    /**
     * GET /admin/campaigns/:id
     * Get campaign details
     */
    server.get('/:id', {
        preHandler: [(server as any).requireAdmin]
    }, async (request, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const campaign = await campaignService.getCampaign(id);

        if (!campaign) {
            return reply.code(404).send({ error: 'Campaign not found' });
        }

        return { success: true, campaign };
    });

    /**
     * POST /admin/campaigns/:id/execute
     * Manually trigger a campaign
     */
    server.post('/:id/execute', {
        preHandler: [(server as any).requireAdmin]
    }, async (request, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const { idempotencyKey } = z.object({ idempotencyKey: z.string().optional() }).parse(request.body || {});

        try {
            const result = await campaignService.executeCampaign(id, idempotencyKey);
            return { success: true, result };
        } catch (error: any) {
            return reply.code(500).send({ error: error.message });
        }
    });
}
