import { PubSub } from "@google-cloud/pubsub";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import path from "path";

declare module "fastify" {
    interface FastifyInstance {
        pubsub: PubSub;
    }
}

async function pubsubPlugin(fastify: FastifyInstance) {
    // Check if we have credentials for local dev
    // If running in cloud, it picks up automatically. 
    // If local and GOOGLE_APPLICATION_CREDENTIALS is set, it also picks up automatically.
    const projectId = process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
    const keyFilename = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        '/app/secrets/firebase/notification-service-account.json';

    const pubsub = new PubSub({
        projectId,
        keyFilename: path.resolve(keyFilename),
    });

    fastify.decorate("pubsub", pubsub);

    fastify.addHook("onClose", async () => {
        await pubsub.close();
    });
}

export default fp(pubsubPlugin, { name: "pubsub" });
