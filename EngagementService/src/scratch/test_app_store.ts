import jwt from "jsonwebtoken";
import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * SCRATCH SCRIPT: Test App Store Connect Connection
 * Run with: npx ts-node src/scratch/test_app_store.ts
 */
async function testAppleConnection() {
    console.log("--- Testing App Store Connect Connection ---");

    const issuerId = process.env.APPLE_ISSUER_ID;
    const keyId = process.env.APPLE_KEY_ID;
    const keyPath = path.join(__dirname, "..", "..", "secrets", "app-store-key.p8");

    if (!issuerId || !keyId) {
        console.error("❌ ERROR: Missing APPLE_ISSUER_ID or APPLE_KEY_ID in .env");
        return;
    }

    if (!fs.existsSync(keyPath)) {
        console.error("❌ ERROR: Key file not found at secrets/app-store-key.p8");
        return;
    }

    try {
        const privateKey = fs.readFileSync(keyPath);

        // Apple requires a JWT for authentication
        const token = jwt.sign(
            {
                iss: issuerId,
                exp: Math.floor(Date.now() / 1000) + 120, // 2 minutes
                aud: "appstoreconnect-v1",
            },
            privateKey,
            {
                algorithm: "ES256",
                header: {
                    kid: keyId,
                    typ: "JWT",
                    alg: "ES256"
                },
            }
        );

        console.log("JWT Generated. Testing API access...");

        // Try to fetch simple apps list to verify token
        const response = await axios.get("https://api.appstoreconnect.apple.com/v1/apps", {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        const apps = response.data.data;
        console.log(`✅ SUCCESS: Connected to App Store Connect! Found ${apps.length} apps.`);
        
        const myApp = apps.find((a: any) => a.attributes.bundleId === process.env.APPLE_BUNDLE_ID);
        if (myApp) {
            console.log(`✨ Found Target App: ${myApp.attributes.name} (${myApp.attributes.bundleId})`);
        } else {
            console.warn(`⚠️ Warning: Bundle ID ${process.env.APPLE_BUNDLE_ID} not found in this account list.`);
        }

    } catch (error: any) {
        console.error("❌ CONNECTION FAILED!");
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Error Detail:", error.message);
        }
    }
}

testAppleConnection();
