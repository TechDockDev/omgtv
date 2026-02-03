
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { syncProgressToDb } from "../services/collection-engagement";
import { getRedisOptional } from "../lib/redis";
import { getPrismaOptional } from "../lib/prisma";

export class ProgressSyncWorker {
    private redis: Redis | null;
    private prisma: PrismaClient | null;
    private intervalMs: number;
    private timer: NodeJS.Timeout | null = null;
    private isRunning = false;

    constructor(intervalMs = 10000) {
        this.redis = getRedisOptional();
        this.prisma = getPrismaOptional();
        this.intervalMs = intervalMs;
    }

    start() {
        if (this.timer) return;
        console.log("[ProgressSyncWorker] Starting worker...");
        this.timer = setInterval(() => this.run(), this.intervalMs);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            console.log("[ProgressSyncWorker] Stopped.");
        }
    }

    async run() {
        if (this.isRunning) {
            // console.log("[ProgressSyncWorker] Skip run, previous job still running.");
            return;
        }

        if (!this.redis || !this.prisma) {
            // Dependencies not ready yet (startup race)
            return;
        }

        this.isRunning = true;
        try {
            const count = await syncProgressToDb(this.redis, this.prisma);
            if (count > 0) {
                console.log(`[ProgressSyncWorker] Synced ${count} progress items to DB.`);
            }
        } catch (err) {
            console.error("[ProgressSyncWorker] Error syncing progress:", err);
        } finally {
            this.isRunning = false;
        }
    }
}

let workerInstance: ProgressSyncWorker | null = null;

export function startProgressSyncWorker() {
    if (!workerInstance) {
        workerInstance = new ProgressSyncWorker();
        workerInstance.start();
    }
}
