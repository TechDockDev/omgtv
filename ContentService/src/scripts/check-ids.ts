import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";
import path from "path";

// Load environment from root .env
dotenv.config({ path: path.join(__dirname, "../../../.env") });

const dbHost = "localhost";
const dbUser = process.env.POSTGRES_USER || "postgres";
const dbPass = process.env.POSTGRES_PASSWORD || "postgres";
const dbName = process.env.CONTENT_SERVICE_DB || "pocketlol_content";
const dbUrl = `postgresql://${dbUser}:${dbPass}@${dbHost}:5432/${dbName}?schema=public`;

const prisma = new PrismaClient({
    datasources: {
        db: { url: dbUrl }
    }
});

async function check() {
    console.log("--- Content Data Check ---");
    try {
        const series = await prisma.series.findMany({ take: 10, select: { id: true, title: true } });
        console.log("\nSeries IDs in ContentService:");
        series.forEach(s => console.log(`- ${s.id} (${s.title})`));

        const reels = await prisma.reel.findMany({ take: 10, select: { id: true, title: true } });
        console.log("\nReel IDs in ContentService:");
        reels.forEach(r => console.log(`- ${r.id} (${r.title})`));
    } catch (error) {
        console.error("Check failed:", error);
    } finally {
        await prisma.$disconnect();
    }
}

check();
