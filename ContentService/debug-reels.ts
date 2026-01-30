
import { getPrisma } from "./src/lib/prisma";

async function main() {
    const prisma = getPrisma();
    const reels = await prisma.reel.findMany({
        include: {
            mediaAsset: true,
            series: true,
            episode: true,
        }
    });

    console.log(`Found ${reels.length} reels in total.`);

    for (const reel of reels) {
        console.log(`--------------------------------------------------`);
        console.log(`Reel ID: ${reel.id}`);
        console.log(`Title: ${reel.title}`);
        console.log(`Status: ${reel.status}`);
        console.log(`Visibility: ${reel.visibility}`);
        console.log(`PublishedAt: ${reel.publishedAt}`);
        console.log(`DeletedAt: ${reel.deletedAt}`);
        console.log(`Series ID: ${reel.seriesId} - Exists: ${!!reel.series}, Deleted: ${reel.series?.deletedAt}`);
        console.log(`Episode ID: ${reel.episodeId} - Exists: ${!!reel.episode}, Deleted: ${reel.episode?.deletedAt}`);

        if (reel.mediaAsset) {
            console.log(`MediaAsset ID: ${reel.mediaAsset.id}`);
            console.log(`MediaAsset Status: ${reel.mediaAsset.status}`);
            console.log(`MediaAsset DeletedAt: ${reel.mediaAsset.deletedAt}`);
        } else {
            console.log(`MediaAsset: NONE`);
        }
    }
}

main()
    .catch((e) => console.error(e))
    .finally(async () => {
        await getPrisma().$disconnect();
    });
