
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ads = await prisma.ad.findMany({
    include: {
      episode: { select: { title: true, id: true } },
      series: { select: { title: true, id: true } },
    }
  });

  console.log("TOTAL ADS IN DB:", ads.length);
  ads.forEach(ad => {
    console.log(`Ad ID: ${ad.id}, Type: ${ad.adType}, Episode: ${ad.episode?.title} (${ad.episodeId}), Series: ${ad.series?.title} (${ad.seriesId}), DeletedAt: ${ad.deletedAt}`);
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
