import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import jwt from "jsonwebtoken";
import axios from "axios";
import fs from "fs";
import path from "path";
import zlib from "zlib";

/**
 * Service to handle official Store Analytics (Play Store & App Store)
 */
export class StoreAnalyticsService {
    private prisma: PrismaClient;

    constructor(prisma: PrismaClient) {
        this.prisma = prisma;
    }

    /**
     * Sync data from Google Play Console
     */
    async syncGooglePlay() {
        try {
            const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME || "com.pocket.pocketLol";
            console.log(`[Google] Syncing full stats for ${packageName}...`);
            
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(0, 0, 0, 0);

            // 1. Installs Proxy (Internal App Events)
            const installCount = await this.prisma.appEvent.count({
                where: {
                    eventType: "app_open",
                    createdAt: {
                        gte: yesterday,
                        lt: new Date(yesterday.getTime() + 24 * 60 * 60 * 1000)
                    }
                }
            });

            // 2. Placeholder for Play Vitals (Crashes/ANRs)
            // In a full prod setup, use 'playdeveloperreporting' API here.
            const crashes = 0; 
            const anrs = 0;

            await this.prisma.storeAnalytics.upsert({
                where: { platform_date: { platform: "android", date: yesterday } },
                update: { 
                    installs: installCount, 
                    crashes, 
                    anrs,
                    lastSyncedAt: new Date() 
                },
                create: { 
                    platform: "android", 
                    date: yesterday, 
                    installs: installCount,
                    crashes,
                    anrs
                }
            });

            console.log(`[Google] Synced Android stats for ${yesterday.toDateString()}`);
        } catch (error) {
            console.error("Error syncing Google Play:", error);
        }
    }

    /**
     * Sync data from App Store Connect
     */
    async syncAppStore() {
        try {
            const issuerId = process.env.APPLE_ISSUER_ID;
            const keyId = process.env.APPLE_KEY_ID;
            const vendorNumber = process.env.APPLE_VENDOR_NUMBER;

            if (!issuerId || !keyId || !vendorNumber) return;

            const keyPath = path.join(process.cwd(), "secrets", "app-store-key.p8");
            if (!fs.existsSync(keyPath)) return;

            const privateKey = fs.readFileSync(keyPath);
            const generateToken = () => jwt.sign(
                { iss: issuerId, exp: Math.floor(Date.now() / 1000) + 120, aud: "appstoreconnect-v1" },
                privateKey,
                { algorithm: "ES256", header: { kid: keyId, typ: "JWT", alg: "ES256" } }
            );

            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const dateStr = yesterday.toISOString().split("T")[0];

            console.log(`[Apple] Syncing official reports for ${dateStr}...`);
            
            // 1. Sales & Financial Report
            const salesResponse = await axios.get("https://api.appstoreconnect.apple.com/v1/salesReports", {
                params: {
                    "filter[reportType]": "SALES",
                    "filter[reportSubType]": "SUMMARY",
                    "filter[frequency]": "DAILY",
                    "filter[vendorNumber]": vendorNumber,
                    "filter[reportDate]": dateStr,
                },
                headers: { Authorization: `Bearer ${generateToken()}` },
                responseType: "arraybuffer"
            });

            const salesData = zlib.gunzipSync(salesResponse.data).toString().split("\n");
            let installs = 0;

            if (salesData.length > 1) {
                for (const line of salesData.slice(1)) {
                    const cols = line.split("\t");
                    if (cols.length > 10) {
                        const units = parseInt(cols[7]) || 0;
                        if (units > 0) installs += units;
                    }
                }
            }

            // 2. App Usage Report (Impressions, Page Views, Sessions)
            // Note: This often requires a separate 'Usage' permission in the key
            let impressions = 0, pageViews = 0, sessions = 0;
            try {
                const usageResponse = await axios.get("https://api.appstoreconnect.apple.com/v1/salesReports", {
                    params: {
                        "filter[reportType]": "APP_USAGE",
                        "filter[reportSubType]": "SUMMARY",
                        "filter[frequency]": "DAILY",
                        "filter[vendorNumber]": vendorNumber,
                        "filter[reportDate]": dateStr,
                    },
                    headers: { Authorization: `Bearer ${generateToken()}` },
                    responseType: "arraybuffer"
                });
                const usageData = zlib.gunzipSync(usageResponse.data).toString().split("\n");
                if (usageData.length > 1) {
                    for (const line of usageData.slice(1)) {
                        const cols = line.split("\t");
                        // Usage Columns vary, but common indices are: Impressions: 7, Page Views: 8, Sessions: 9
                        if (cols.length > 9) {
                            impressions += parseInt(cols[7]) || 0;
                            pageViews += parseInt(cols[8]) || 0;
                            sessions += parseInt(cols[9]) || 0;
                        }
                    }
                }
            } catch (e) {
                console.warn("[Apple] Usage report not available (permission or data lag)");
            }

            await this.prisma.storeAnalytics.upsert({
                where: { platform_date: { platform: "ios", date: yesterday } },
                update: { 
                    installs,
                    impressions, pageViews, sessions,
                    lastSyncedAt: new Date() 
                },
                create: { 
                    platform: "ios", date: yesterday, 
                    installs,
                    impressions, pageViews, sessions
                }
            });

            console.log(`[Apple] Sync complete for ${dateStr}`);
        } catch (error: any) {
            console.error("Error syncing App Store:", error.message);
        }
    }

    /**
     * Start the 12-hour background sync worker
     */
    static startScheduler(prisma: PrismaClient) {
        console.log("[StoreAnalytics] Initializing 12-hour sync scheduler...");
        const service = new StoreAnalyticsService(prisma);
        
        // Initial sync on startup
        service.syncAll().catch(e => console.error("Initial sync failed:", e));

        // Repeat every 12 hours
        setInterval(() => {
            console.log("[StoreAnalytics] Running scheduled 12-hour sync...");
            service.syncAll().catch(e => console.error("Scheduled sync failed:", e));
        }, 12 * 60 * 60 * 1000);
    }

    /**
     * Sync both stores
     */
    async syncAll() {
        await Promise.all([
            this.syncGooglePlay(),
            this.syncAppStore()
        ]);
    }

    /**
     * Get aggregated store stats for the dashboard
     */
    async getStoreSummary(startDate: Date, endDate: Date) {
        const stats = await this.prisma.storeAnalytics.findMany({
            where: {
                date: { gte: startDate, lte: endDate }
            }
        });

        const summary = {
            android: { installs: 0, uninstalls: 0, crashes: 0 },
            ios: { installs: 0, uninstalls: 0, crashes: 0 },
            totalInstalls: 0,
            totalUninstalls: 0,
            totalCrashes: 0
        };

        stats.forEach(s => {
            if (s.platform === "android") {
                summary.android.installs += s.installs;
                summary.android.uninstalls += s.uninstalls;
                summary.android.crashes += s.crashes;
            } else {
                summary.ios.installs += s.installs;
                summary.ios.uninstalls += s.uninstalls;
                summary.ios.crashes += s.crashes;
            }
        });

        summary.totalInstalls = summary.android.installs + summary.ios.installs;
        summary.totalUninstalls = summary.android.uninstalls + summary.ios.uninstalls;
        summary.totalCrashes = summary.android.crashes + summary.ios.crashes;

        return summary;
    }
}
