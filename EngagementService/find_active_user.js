const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function findActiveUser() {
    try {
        const action = await prisma.userAction.findFirst({
            where: { isActive: true },
            select: { userId: true }
        });
        console.log('Active User (Likes/Saves):', action?.userId);

        const progress = await prisma.viewProgress.findFirst({
            select: { userId: true }
        });
        console.log('Active User (Progress):', progress?.userId);

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

findActiveUser();
