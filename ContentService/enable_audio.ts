
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const series = await prisma.series.update({
        where: { slug: 'money-heist' },
        data: { isAudioSeries: true }
    });

    if (series) {
        console.log(`Series: ${series.title}`);
        console.log(`isAudioSeries: ${series.isAudioSeries}`);
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
