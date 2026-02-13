import { initializeFirebase } from './src/config/firebase';
import prisma from './src/prisma';

async function test() {
    console.log('Testing environment...');
    try {
        initializeFirebase();
        console.log('✅ Firebase initialized');

        const count = await prisma.notification.count();
        console.log(`✅ Prisma connected. Notification count: ${count}`);

        console.log('✅ Environment test passed!');
    } catch (error) {
        console.error('❌ Environment test failed:', error);
        process.exit(1);
    }
}

test();
