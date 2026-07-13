import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config";

// Single shared client for cross-DB reads from the Auth database.
// AUTH_DATABASE_URL carries connection_limit — every additional PrismaClient
// instance opens its own pool of that size, so this must stay the only one.
export const authPrisma = new PrismaClient({
    datasources: {
        db: {
            url: loadConfig().AUTH_DATABASE_URL,
        },
    },
});
