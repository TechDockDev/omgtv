import { PubSub } from "@google-cloud/pubsub";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
    interface FastifyInstance {
        pubsub: PubSub;
    }
}

async function pubsubPlugin(fastify: FastifyInstance) {
    const projectId = process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;

    // Check if we have credentials for local dev
    // If running in cloud, it picks up automatically. 
    // If local and GOOGLE_APPLICATION_CREDENTIALS is set, it also picks up automatically.

    const pubsub = new PubSub({
        projectId,
    });

    fastify.decorate("pubsub", pubsub);

    fastify.addHook("onClose", async () => {
        await pubsub.close();
    });
}

export default fp(pubsubPlugin, { name: "pubsub" });
