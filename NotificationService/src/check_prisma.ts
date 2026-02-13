import prisma from './prisma';

async function check() {
    try {
        // This line should cause a compilation error if fcmToken is missing
        const count = await prisma.fcmToken.count();
        console.log(`FCM Token count: ${count}`);
        process.exit(0);
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}

check();
