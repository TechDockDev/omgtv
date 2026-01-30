
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const seriesId = "d454856a-2d72-4429-ac91-35d817ed4ee1";
    console.log(`Checking Visibility for Series: ${seriesId}`);

    const series = await prisma.series.findUnique({
        where: { id: seriesId },
        include: {
            episodes: {
                where: { deletedAt: null },
            },
            seasons: {
                include: {
                    episodes: { where: { deletedAt: null } }
                }
            }
        },
    });

    if (!series) {
        console.log("Series not found");
        return;
    }

    console.log("Standalone Episodes:");
    series.episodes.forEach(ep => {
        console.log(`  - ID: ${ep.id}`);
        console.log(`    Title: ${ep.title}`);
        console.log(`    Status: ${ep.status}`);
        console.log(`    Visibility: ${ep.visibility}`); // This is what we want to see
        console.log(`    PublishedAt: ${ep.publishedAt}`);
    });

    console.log("Seasons:");
    series.seasons.forEach(s => {
        console.log(`  Season ${s.sequenceNumber}:`);
        s.episodes.forEach(ep => {
            console.log(`  - ID: ${ep.id}`);
            console.log(`    Visibility: ${ep.visibility}`);
        });
    });
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
