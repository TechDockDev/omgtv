import { FastifyInstance } from 'fastify';
import { NotificationManager } from '../services/notification-manager';

const notificationManager = new NotificationManager();

export async function startUserEventListeners(fastify: FastifyInstance) {
    const pubsub = fastify.pubsub;
    const subscriptionName = process.env.USER_EVENTS_SUBSCRIPTION || 'notification-user-events-sub';

    // Verify subscription exists or create it (logic simplified for brevity, assuming standard infra setup)
    // In production, terraform/infra-as-code usually handles topic/sub creation.

    try {
        const subscription = pubsub.subscription(subscriptionName);
        const [exists] = await subscription.exists();

        if (!exists) {
            console.warn(`⚠️ Pub/Sub subscription ${subscriptionName} does not exist. Events will not be processed.`);
            return;
        }

        console.log(`✅ Listening for messages on ${subscriptionName}...`);

        subscription.on('message', async (message) => {
            try {
                const data = JSON.parse(message.data.toString());
                const eventType = message.attributes.type;

                console.log(`Received event: ${eventType}`, data);

                if (eventType === 'user.registered') {
                    // Send Welcome Email
                    await notificationManager.sendNotification(
                        data.userId,
                        'EMAIL',
                        'Welcome to OMGTV!',
                        `Hi ${data.name}, welcome to OMGTV! We are excited to have you.`,
                        {},
                        'HIGH'
                    );
                }

                message.ack();
            } catch (error) {
                console.error('Error processing message:', error);
                message.nack();
            }
        });

        subscription.on('error', (error) => {
            console.error('Received error:', error);
        });

    } catch (error) {
        console.error('Failed to start user event listener:', error);
    }
}
