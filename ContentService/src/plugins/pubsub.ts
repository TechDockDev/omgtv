import { PubSub } from "@google-cloud/pubsub";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { loadConfig } from "../config";

declare module "fastify" {
    interface FastifyInstance {
        pubsub: PubSub;
    }
}

async function pubsubPlugin(fastify: FastifyInstance) {
    const config = loadConfig();
    const pubsub = new PubSub({
        projectId: config.GCP_PROJECT_ID,
    });

    fastify.decorate("pubsub", pubsub);

    fastify.addHook("onClose", async () => {
        await pubsub.close();
    });
}

export default fp(pubsubPlugin, { name: "pubsub" });
