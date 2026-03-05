
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

async function main() {
    const prisma = new PrismaClient();
    try {
        console.log("Connecting to DB...");
        const count = await prisma.adminCredential.count();
        console.log(`Total Admin Credentials: ${count}`);

        if (count > 0) {
            const admins = await prisma.adminCredential.findMany({
                select: {
                    email: true,
                    isActive: true,
                }
            });
            console.log("Admin Credentials:");
            console.log(JSON.stringify(admins, null, 2));
        }
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
