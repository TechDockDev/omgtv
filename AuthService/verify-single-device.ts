
import { loadConfig } from "./src/config";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import fetch from "node-fetch";

// Load config first
const config = loadConfig();

// Overwrite redis URL if needed for local testing with docker-compose mapping
if (process.env.REDIS_URL) {
    config.REDIS_URL = process.env.REDIS_URL;
}

const BASE_URL = process.env.BASE_URL || "http://localhost:4000"; // Target AuthService directly
const TEST_EMAIL = "test-single-device@example.com";
const TEST_PASSWORD = "Password123!";

async function run() {
    console.log("Starting Single Device Login Verification...");

    // 1. Setup: Create/Ensure Admin Account
    const redis = new Redis(config.REDIS_URL);

    // Note: Just using the API to register/login. 
    // If the user already exists, we login. If not, we register.

    let tokenA = "";
    let tokenB = "";

    // LOGIN DEVICE A
    console.log("\n[1] Logging in Device A...");
    let res = await fetch(`${BASE_URL}/api/v1/auth/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });

    if (res.status === 401 || res.status === 404 || res.status === 500) {
        // Try Registering if login fails (first run)
        console.log("Login failed, attempting registration...");
        res = await fetch(`${BASE_URL}/api/v1/auth/admin/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
        });
    }

    if (!res.ok) {
        const text = await res.text();
        console.error("Failed to login/register Device A:", res.status, text);
        process.exit(1);
    }

    const dataA: any = await res.json();
    tokenA = dataA.accessToken;
    console.log("Device A Login Success. Token stored.");

    // Verify Device A is valid
    console.log("[2] Verifying Device A session...");
    res = await fetch(`${BASE_URL}/api/v1/auth/session/verify`, {
        headers: { Authorization: `Bearer ${tokenA}` }
    });
    if (res.ok) {
        console.log("Device A is VALID (Expected)");
    } else {
        console.error("Device A verification failed (Unexpected)", res.status, await res.text());
    }

    // LOGIN DEVICE B
    console.log("\n[3] Logging in Device B (Same User)...");
    res = await fetch(`${BASE_URL}/api/v1/auth/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    if (!res.ok) {
        console.error("Failed to login Device B:", res.status, await res.text());
        process.exit(1);
    }
    const dataB: any = await res.json();
    tokenB = dataB.accessToken;
    console.log("Device B Login Success. Token stored.");

    // Verify Device B is valid
    console.log("[4] Verifying Device B session...");
    res = await fetch(`${BASE_URL}/api/v1/auth/session/verify`, {
        headers: { Authorization: `Bearer ${tokenB}` }
    });
    if (res.ok) {
        console.log("Device B is VALID (Expected)");
    } else {
        console.error("Device B verification failed (Unexpected)", res.status, await res.text());
    }

    // VERIFY DEVICE A IS NOW INVALID
    console.log("\n[5] Verifying Device A session (Should be INVALID)...");
    res = await fetch(`${BASE_URL}/api/v1/auth/session/verify`, {
        headers: { Authorization: `Bearer ${tokenA}` }
    });

    if (res.status === 401) {
        console.log("PASS: Device A is INVALID (Expected 401)");
    } else {
        console.error("FAIL: Device A is still valid! Status:", res.status);
    }

    redis.quit();
}

run().catch(console.error);
