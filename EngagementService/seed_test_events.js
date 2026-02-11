const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedEvents() {
    console.log('Seeding sample analytics events...');

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const events = [
        // Unique user 1
        { eventType: 'app_open', userId: 'user_1', deviceId: 'dev_1', createdAt: now },
        { eventType: 'screen_view', userId: 'user_1', deviceId: 'dev_1', eventData: { screen: 'home' }, createdAt: now },
        { eventType: 'screen_view', userId: 'user_1', deviceId: 'dev_1', eventData: { screen: 'series_detail' }, createdAt: now },

        // Unique user 2
        { eventType: 'app_open', userId: 'user_2', deviceId: 'dev_2', createdAt: now },
        { eventType: 'screen_view', userId: 'user_2', deviceId: 'dev_2', eventData: { screen: 'home' }, createdAt: now },

        // Guest user 1 (deviceId only)
        { eventType: 'app_open', userId: null, deviceId: 'dev_3', createdAt: now },
        { eventType: 'screen_view', userId: null, deviceId: 'dev_3', eventData: { screen: 'home' }, createdAt: now },

        // Old events (should not be in current DAU if range is small, but for testing range)
        { eventType: 'app_open', userId: 'user_1', deviceId: 'dev_1', createdAt: yesterday },
    ];

    try {
        const count = await prisma.appEvent.createMany({ data: events });
        console.log(`Created ${count.count} events.`);
    } catch (error) {
        console.error('Error seeding events:', error);
    } finally {
        await prisma.$disconnect();
    }
}

seedEvents();
