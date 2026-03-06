import { PubSub } from "@google-cloud/pubsub";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import path from "path";
import { loadConfig } from "../config";

declare module "fastify" {
    interface FastifyInstance {
        pubsub: PubSub;
    }
}

async function pubsubPlugin(fastify: FastifyInstance) {
    const config = loadConfig();
    const projectId = config.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;

    const options: any = { projectId };

    if (config.FIREBASE_CREDENTIALS_B64) {
        try {
            const buffer = Buffer.from(config.FIREBASE_CREDENTIALS_B64, 'base64');
            options.credentials = JSON.parse(buffer.toString('utf8'));
            console.log('✅ PubSub initialized using Base64 credentials');
        } catch (error) {
            console.error('❌ Failed to parse FIREBASE_CREDENTIALS_B64 for PubSub:', error);
        }
    } else {
        const keyFilename = config.FIREBASE_SERVICE_ACCOUNT_PATH ||
            process.env.GOOGLE_APPLICATION_CREDENTIALS ||
            '/app/secrets/firebase/notification-service-account.json';
        options.keyFilename = path.resolve(keyFilename);
        console.log(`ℹ️ PubSub using key file: ${options.keyFilename}`);
    }

    const pubsub = new PubSub(options);

    fastify.decorate("pubsub", pubsub);

    fastify.addHook("onClose", async () => {
        await pubsub.close();
    });
}

export default fp(pubsubPlugin, { name: "pubsub" });