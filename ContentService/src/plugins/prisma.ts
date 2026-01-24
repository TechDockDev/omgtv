import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { getPrisma, disconnectPrisma } from "../lib/prisma";
import { PrismaClient } from "@prisma/client";

declare module "fastify" {
    interface FastifyInstance {
        prisma: PrismaClient;
    }
}

async function prismaPlugin(fastify: FastifyInstance) {
    const prisma = getPrisma();

    fastify.decorate("prisma", prisma);

    fastify.addHook("onClose", async () => {
        await disconnectPrisma();
    });
}

export default fp(prismaPlugin, { name: "prisma" });
