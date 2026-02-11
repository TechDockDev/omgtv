const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    try {
        const count = await prisma.appEvent.count();
        console.log('Total AppEvents:', count);
        if (count > 0) {
            const latest = await prisma.appEvent.findMany({
                take: 5,
                orderBy: { createdAt: 'desc' },
            });
            console.log('Latest 5 events:', JSON.stringify(latest, null, 2));
        }
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

run();
