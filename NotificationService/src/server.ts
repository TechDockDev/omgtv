import 'dotenv/config';
import fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { initializeFirebase } from './config/firebase';


const server = fastify({
    logger: {
        level: process.env.LOG_LEVEL || 'info',
        transport: {
            target: 'pino-pretty',
        },
    },
});

// Zod validation
server.setValidatorCompiler(validatorCompiler);
server.setSerializerCompiler(serializerCompiler);

// Plugins
server.register(cors);
server.register(helmet);
server.register(sensible);
server.register(import('./plugins/pubsub'));

// Routes
server.register(import('./routes/notifications'), { prefix: '/api/v1/notifications' });
server.register(import('./routes/preferences'), { prefix: '/api/v1/preferences' });
server.register(import('./routes/push'), { prefix: '/api/v1/notifications/push' }); // Changed to nest properly
server.register(import('./routes/admin'), { prefix: '/api/v1/admin/notifications' });

// Health check
server.get('/health', async () => {
    return { status: 'ok', service: 'notification-service' };
});

import { startUserEventListeners } from './listeners/user-events';
import { startGrpcServer } from './grpc';

const start = async () => {
    try {
        // Initialize Firebase Admin SDK
        initializeFirebase();

        await server.ready();

        // Start Listeners
        startUserEventListeners(server);
        const port = parseInt(process.env.HTTP_PORT || '5200');
        const host = process.env.HTTP_HOST || '0.0.0.0';

        const grpcPort = process.env.GRPC_BIND_ADDRESS?.split(':')[1] || '50072';
        startGrpcServer(grpcPort);

        await server.listen({ port, host });
        console.log(`Notification Service running at http://${host}:${port}`);
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();

