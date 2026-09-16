import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotificationManager } from '../services/notification-manager';

const sendEmailSchema = z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(200),
    html: z.string().min(1),
    text: z.string().optional(),
});

const manager = new NotificationManager();

export default async function internalEmailRoutes(fastify: FastifyInstance) {
    fastify.post('/send', async (request, reply) => {
        const { to, subject, html, text } = sendEmailSchema.parse(request.body);

        try {
            // sendDirectEmail only takes a single body string + an isHtml flag (no
            // separate html/text) — html is required by the schema above, so always
            // send that as the real body. `text` is accepted for API shape parity
            // with EmailPayload but isn't separately deliverable through this helper.
            const result = await manager.sendDirectEmail(to, subject, html, true);
            return reply.send({ success: true, messageId: result.messageId });
        } catch (err: any) {
            console.error(`[internal-email] Failed to send email to ${to}:`, err?.message);
            return reply.status(502).send({ success: false, reason: 'email_provider_error' });
        }
    });
}
