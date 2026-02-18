import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { campaignService } from '../services/CampaignService';
import { CampaignRepository } from '../repositories/campaign';
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

const updateCampaignSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    title: z.string().min(1).max(100).optional(),
    body: z.string().min(1).max(500).optional(),
    data: z.record(z.string()).optional(),
    targetCriteria: z.object({
        segment: z.enum(['SUBSCRIBERS', 'ALL']).optional(),
        custom: z.record(z.any()).optional()
    }).optional(),
    type: z.enum(['PUSH', 'EMAIL', 'IN_APP']).optional(),
    scheduledAt: z.string().datetime().nullable().optional(),
});

export default async function campaignRoutes(server: FastifyInstance) {
    // All campaign routes require admin access
    server.addHook('onRequest', server.requireAdmin);

    /**
     * POST /admin/campaigns
     * Create a new campaign. If no scheduledAt is provided, the campaign
     * is executed immediately. If scheduledAt is in the future, it is
     * saved as SCHEDULED and picked up by the scheduler.
     */
    server.post('/', {
        schema: { body: createCampaignSchema },
    }, async (request, reply) => {
        const body = createCampaignSchema.parse(request.body);
        const isScheduled = !!body.scheduledAt;

        const campaign = await campaignService.createCampaign({
            name: body.name,
            title: body.title,
            body: body.body,
            data: body.data || {},
            targetCriteria: body.targetCriteria || {},
            idempotencyKey: body.idempotencyKey,
            type: body.type as NotificationType,
            status: isScheduled ? 'SCHEDULED' : 'DRAFT',
            scheduledAt: isScheduled ? new Date(body.scheduledAt!) : null,
        });

        // If not scheduled, execute immediately
        if (!isScheduled) {
            try {
                const result = await campaignService.executeCampaign(campaign.id);
                const updated = await campaignService.getCampaign(campaign.id);
                return { success: true, campaign: updated, executionResult: result };
            } catch (error: any) {
                server.log.error(error, `Failed to auto-execute campaign ${campaign.id}`);
                return reply.code(500).send({
                    error: `Campaign created but execution failed: ${error.message}`,
                    campaign,
                });
            }
        }

        return { success: true, campaign };
    });

    /**
     * GET /admin/campaigns
     * List campaigns
     */
    server.get('/', async (request) => {
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
    server.get('/:id', async (request, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const campaign = await campaignService.getCampaign(id);

        if (!campaign) {
            return reply.code(404).send({ error: 'Campaign not found' });
        }

        return { success: true, campaign };
    });

    /**
     * PUT /admin/campaigns/:id
     * Update a DRAFT campaign
     */
    server.put('/:id', {
        schema: { body: updateCampaignSchema },
    }, async (request, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = updateCampaignSchema.parse(request.body);

        const existing = await campaignService.getCampaign(id);
        if (!existing) {
            return reply.code(404).send({ error: 'Campaign not found' });
        }

        if (existing.status !== 'DRAFT') {
            return reply.code(400).send({
                error: `Cannot edit a campaign with status "${existing.status}". Only DRAFT campaigns can be edited.`,
            });
        }

        const updateData: Record<string, any> = {};
        if (body.name !== undefined) updateData.name = body.name;
        if (body.title !== undefined) updateData.title = body.title;
        if (body.body !== undefined) updateData.body = body.body;
        if (body.data !== undefined) updateData.data = body.data;
        if (body.targetCriteria !== undefined) updateData.targetCriteria = body.targetCriteria;
        if (body.type !== undefined) updateData.type = body.type;

        // Handle scheduledAt: if provided, set to SCHEDULED; if null, stay DRAFT
        if (body.scheduledAt !== undefined) {
            if (body.scheduledAt) {
                updateData.scheduledAt = new Date(body.scheduledAt);
                updateData.status = 'SCHEDULED';
            } else {
                updateData.scheduledAt = null;
            }
        }

        const updated = await CampaignRepository.update(id, updateData);
        return { success: true, campaign: updated };
    });

    /**
     * DELETE /admin/campaigns/:id
     * Delete a DRAFT or CANCELLED campaign
     */
    server.delete('/:id', async (request, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

        const existing = await campaignService.getCampaign(id);
        if (!existing) {
            return reply.code(404).send({ error: 'Campaign not found' });
        }

        if (existing.status !== 'DRAFT' && existing.status !== 'CANCELLED') {
            return reply.code(400).send({
                error: `Cannot delete a campaign with status "${existing.status}". Only DRAFT or CANCELLED campaigns can be deleted.`,
            });
        }

        await CampaignRepository.delete(id);
        return { success: true };
    });

    /**
     * POST /admin/campaigns/:id/cancel
     * Cancel a SCHEDULED campaign
     */
    server.post('/:id/cancel', async (request, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

        const existing = await campaignService.getCampaign(id);
        if (!existing) {
            return reply.code(404).send({ error: 'Campaign not found' });
        }

        if (existing.status !== 'SCHEDULED') {
            return reply.code(400).send({
                error: `Cannot cancel a campaign with status "${existing.status}". Only SCHEDULED campaigns can be cancelled.`,
            });
        }

        const updated = await CampaignRepository.updateStatus(id, 'CANCELLED');
        return { success: true, campaign: updated };
    });

    /**
     * GET /admin/campaigns/:id/notifications
     * Get per-user delivery logs for a campaign
     */
    server.get('/:id/notifications', async (request) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const { status, limit, offset } = z.object({
            status: z.enum(['SENT', 'FAILED', 'READ', 'PENDING']).optional(),
            limit: z.coerce.number().min(1).max(100).default(20),
            offset: z.coerce.number().min(0).default(0),
        }).parse(request.query);

        const result = await CampaignRepository.findNotifications(id, { status, limit, offset });
        return { success: true, ...result, limit, offset };
    });

    /**
     * POST /admin/campaigns/:id/execute
     * Manually trigger a campaign
     */
    server.post('/:id/execute', async (request, reply) => {
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
