import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
    if (!prisma) {
        prisma = new PrismaClient({
            log:
                process.env.NODE_ENV === "development"
                    ? ["query", "error", "warn"]
                    : ["error"],
        });
    }
    return prisma;
}

export function getPrismaOptional(): PrismaClient | null {
    if (!process.env.DATABASE_URL) {
        return null;
    }
    return getPrisma();
}

export async function disconnectPrisma(): Promise<void> {
    if (prisma) {
        await prisma.$disconnect();
        prisma = null;
    }
}
