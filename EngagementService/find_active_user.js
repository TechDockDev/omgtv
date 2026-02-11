const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // Relative to EngagementService dir
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function findActiveUser() {
    try {
        const user = await prisma.viewProgress.findFirst({
            orderBy: { updatedAt: 'desc' },
            select: { userId: true }
        });

        if (user) {
            console.log("Found Active User ID:", user.userId);
        } else {
            console.log("No users with watch history found.");
        }
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

findActiveUser();
