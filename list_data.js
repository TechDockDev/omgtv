const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const categories = await prisma.category.findMany({ select: { slug: true, name: true } });
    const tags = await prisma.tag.findMany({ select: { slug: true, name: true } });
    const seriesWithTags = await prisma.series.findMany({
        where: { tags: { isEmpty: false } },
        select: { title: true, tags: true }
    });
    const episodesWithTags = await prisma.episode.findMany({
        where: { tags: { isEmpty: false } },
        select: { title: true, tags: true }
    });

    console.log('Categories:', JSON.stringify(categories, null, 2));
    console.log('Tags:', JSON.stringify(tags, null, 2));
    console.log('Series with Tags:', JSON.stringify(seriesWithTags, null, 2));
    console.log('Episodes with Tags:', JSON.stringify(episodesWithTags, null, 2));
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
