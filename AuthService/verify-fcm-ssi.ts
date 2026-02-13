import { PrismaClient } from "@prisma/client";
import fetch from "node-fetch";

// Setup Prisma clients
const authPrisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pocketlol_auth?schema=public" } }
});
// For integration testing we need the other DB URL too
const userPrisma = new PrismaClient({
    datasources: { db: { url: process.env.USER_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pocketlol_users?schema=public" } }
});

const AUTH_URL = process.env.BASE_URL || "http://localhost:4000";
const DEVICE_ID = "test-device-ssi-001";
const FCM_TOKEN_1 = "fcm-token-initial";
const FCM_TOKEN_2 = "fcm-token-rotated";

async function runTest() {
    console.log("🚀 Starting FCM/SSI Best Practice Verification...");

    try {
        // 1. Sync device WITHOUT login
        console.log("Step 1: Syncing device token without login...");
        const res1 = await fetch(`${AUTH_URL}/api/v1/auth/device/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                deviceId: DEVICE_ID,
                deviceInfo: {
                    os: "android",
                    fcmToken: FCM_TOKEN_1,
                },
            }),
        });

        if (!res1.ok) {
            throw new Error(`Sync failed: ${res1.status} ${await res1.text()}`);
        }

        let results: any = await userPrisma.$queryRaw`SELECT "fcmToken" FROM "DeviceIdentity" WHERE "deviceId" = ${DEVICE_ID}`;
        let fcmTokenFound = results[0]?.fcmToken;

        if (fcmTokenFound === FCM_TOKEN_1) {
            console.log("✅ Device sync success: Token stored correctly.");
        } else {
            throw new Error(`Device sync verification failed: Expected ${FCM_TOKEN_1}, got ${fcmTokenFound}`);
        }

        // 2. Token Rotation
        console.log("Step 2: Syncing token AGAIN to simulate rotation...");
        const res2 = await fetch(`${AUTH_URL}/api/v1/auth/device/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                deviceId: DEVICE_ID,
                deviceInfo: {
                    os: "android",
                    fcmToken: FCM_TOKEN_2,
                },
            }),
        });

        if (!res2.ok) {
            throw new Error(`Rotation sync failed: ${res2.status} ${await res2.text()}`);
        }

        results = await userPrisma.$queryRaw`SELECT "fcmToken" FROM "DeviceIdentity" WHERE "deviceId" = ${DEVICE_ID}`;
        fcmTokenFound = results[0]?.fcmToken;

        if (fcmTokenFound === FCM_TOKEN_2) {
            console.log("✅ Device sync rotation success: Token updated correctly without login.");
        } else {
            throw new Error(`Device sync rotation failed: Expected ${FCM_TOKEN_2}, got ${fcmTokenFound}`);
        }

        console.log("\n✨ Verification Complete!");

    } catch (error: any) {
        console.error("❌ Test failed:", error.message);
    } finally {
        await authPrisma.$disconnect();
        await userPrisma.$disconnect();
    }
}

runTest();
