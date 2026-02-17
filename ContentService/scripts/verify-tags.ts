
import { getPrisma, disconnectPrisma } from "../src/lib/prisma";
import { CatalogRepository } from "../src/repositories/catalog-repository";
import { PublicationStatus, Visibility } from "@prisma/client";

async function main() {
    const prisma = getPrisma();
    const repo = new CatalogRepository(prisma);

    console.log("--- Verifying Tag Filtering in CatalogRepository ---");

    // 1. List some categories and tags to pick from
    const categories = await prisma.category.findMany({
        take: 3,
        select: { slug: true, name: true }
    });
    const seriesWithTags = await prisma.series.findFirst({
        where: { tags: { isEmpty: false } },
        select: { tags: true }
    });

    console.log("Available Categories:", categories);
    console.log("Sample Series Tags:", seriesWithTags?.tags);

    const testTag = seriesWithTags?.tags?.[0] || categories[0]?.slug;

    if (!testTag) {
        console.error("No tags or categories found to test with.");
        return;
    }

    console.log(`\nTesting filtering with tag: "${testTag}"`);

    // 2. Query listHomeSeries with the tag
    const result = await repo.listHomeSeries({
        limit: 10,
        tag: testTag
    });

    console.log(`Found ${result.items.length} items.`);

    // 3. Verify results
    let allMatch = true;
    for (const item of result.items) {
        const catMatch = item.category?.slug === testTag || item.category?.name === testTag;
        const tagMatch = item.tags.includes(testTag);

        if (!catMatch && !tagMatch) {
            console.error(`FAILURE: Item "${item.title}" (ID: ${item.id}) does NOT match tag "${testTag}".`);
            console.log("Item Details:", JSON.stringify({
                title: item.title,
                category: item.category,
                tags: item.tags
            }, null, 2));
            allMatch = false;
        }
    }

    if (allMatch && result.items.length > 0) {
        console.log("SUCCESS: All returned items match the tag.");
    } else if (result.items.length === 0) {
        console.warn("WARNING: No items returned. Cannot verify filtering logic (but it didn't crash).");
    } else {
        console.error("FAILURE: Some items did not match the tag.");
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await disconnectPrisma();
    });
