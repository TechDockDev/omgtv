
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const series = await prisma.series.findUnique({
        where: { slug: 'money-heist' }
    });

    if (series) {
        console.log(`Series: ${series.title}`);
        console.log(`isAudioSeries: ${series.isAudioSeries}`);
    } else {
        console.log("Series 'money-heist' not found");
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
