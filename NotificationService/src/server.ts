import 'dotenv/config';
import fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { initializeFirebase } from './config/firebase';
import prisma from './prisma';


const server = fastify({
    logger: {
        level: process.env.LOG_LEVEL || 'info',
        transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
    },
});

// Zod validation
server.setValidatorCompiler(validatorCompiler);
server.setSerializerCompiler(serializerCompiler);

// Plugins
server.register(cors);
server.register(helmet);
server.register(sensible);
server.register(import('./plugins/auth'));
server.register(import('./plugins/pubsub'));

// Routes
server.register(import('./routes/notifications'), { prefix: '/api/v1/notifications' });
server.register(import('./routes/preferences'), { prefix: '/api/v1/notifications/preferences' });
server.register(import('./routes/push'), { prefix: '/api/v1/notifications/push' });
server.register(import('./routes/admin'), { prefix: '/api/v1/notifications/admin' });
server.register(import('./routes/campaigns'), { prefix: '/api/v1/notifications/admin/campaigns' });

// Health check
server.get('/health', async (request, reply) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return {
            status: 'ok',
            service: 'notification-service',
            timestamp: new Date().toISOString(),
            checks: {
                database: 'healthy'
            }
        };
    } catch (error) {
        server.log.error(error, 'Health check failed');
        return reply.status(503).send({
            status: 'unhealthy',
            reason: 'Database connectivity issue'
        });
    }
});

import { startUserEventListeners } from './listeners/user-events';
import { startGrpcServer } from './grpc';
import { campaignService } from './services/CampaignService';

const start = async () => {
    try {
        // Initialize Firebase Admin SDK (non-fatal — service can still serve other routes)
        try {
            initializeFirebase();
        } catch (err) {
            server.log.warn('Firebase initialization failed — push notifications will be unavailable');
        }

        await server.ready();

        // Start Listeners
        startUserEventListeners(server);

        const port = parseInt(process.env.HTTP_PORT || '5200');
        const host = process.env.HTTP_HOST || '0.0.0.0';

        const grpcPort = process.env.GRPC_BIND_ADDRESS?.split(':')[1] || '50072';
        startGrpcServer(grpcPort);

        await server.listen({ port, host });
        console.log(`Notification Service running at http://${host}:${port}`);

        // Start Campaign Scheduler (Check every minute)
        setInterval(() => {
            campaignService.processScheduledCampaigns().catch(err => {
                server.log.error(err, 'Campaign scheduler error');
            });
        }, 60 * 1000);
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();
