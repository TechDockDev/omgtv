import { google } from "googleapis";
import path from "path";
import fs from "fs";

/**
 * SCRATCH SCRIPT: Test Google Play Connection
 * Run with: npx ts-node src/scratch/test_google_play.ts
 */
async function testConnection() {
    const packageName = "com.pocket.pocketLol";
    const keyPath = path.join(__dirname, "..", "..", "secrets", "google-play-key.json");

    console.log("--- Testing Google Play Connection ---");
    console.log("Package Name:", packageName);
    console.log("Key Path:", keyPath);

    if (!fs.existsSync(keyPath)) {
        console.error("❌ ERROR: Key file not found! Please place your JSON key at secrets/google-play-key.json");
        return;
    }

    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: keyPath,
            scopes: ["https://www.googleapis.com/auth/androidpublisher"],
        });

        const publisher = google.androidpublisher({ version: "v3", auth });

        // Try to fetch app details to verify permissions
        console.log("Fetching app details...");
        const res = await publisher.reviews.list({
            packageName: packageName,
            maxResults: 1
        });

        console.log("✅ SUCCESS: Connected to Google Play Store!");
        console.log("Permissions are working. We can fetch data.");
    } catch (error: any) {
        console.error("❌ CONNECTION FAILED!");
        console.error("Error Detail:", error.message);
        if (error.message.includes("403")) {
            console.error("Suggestion: Check if you invited the service account in Play Console with 'View Financial Data' permissions.");
        }
    }
}

testConnection();
