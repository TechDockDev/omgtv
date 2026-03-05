
import { PrismaClient } from "@prisma/client";

async function main() {
    const prisma = new PrismaClient();
    try {
        const admins = await prisma.adminCredential.findMany({
            select: {
                email: true,
                isActive: true,
            }
        });
        console.log("Admin Credentials in DB:");
        console.log(JSON.stringify(admins, null, 2));
    } catch (error) {
        console.error("Error fetching admins:", error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
