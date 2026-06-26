import { PrismaClient } from "@prisma/client";
import { syncSeriesToSearch } from "../src/services/search-sync";

// One-time backfill: push every existing series into Meilisearch.
// syncSeriesToSearch already applies the PUBLISHED+PUBLIC filter (anything else is
// sent as a delete, which is a safe no-op if it was never indexed). Reuses the exact
// same payload-building logic as normal create/update syncs, so the index ends up
// byte-for-byte consistent with what new syncs would produce.
async function main() {
  const prisma = new PrismaClient();

  const allSeries = await prisma.series.findMany({
    include: { category: true },
  });

  console.log(`Found ${allSeries.length} series. Syncing to Meilisearch...`);

  let synced = 0;
  let failed = 0;

  for (const series of allSeries) {
    try {
      await syncSeriesToSearch("upsert", series);
      synced++;
      if (synced % 25 === 0) console.log(`  ...${synced}/${allSeries.length}`);
    } catch (err) {
      failed++;
      console.error(`FAILED to sync series ${series.id} (${series.title}):`, err);
    }
  }

  console.log(`Done. Synced: ${synced}, Failed: ${failed}, Total: ${allSeries.length}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Backfill script failed:", err);
  process.exit(1);
});
