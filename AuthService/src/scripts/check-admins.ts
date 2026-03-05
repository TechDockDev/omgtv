import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    try {
        const admins = await prisma.adminCredential.findMany({
            select: {
                email: true,
            },
        });
        if (admins.length === 0) {
            console.log('No admins found in the database.');
        } else {
            console.log('--- REGISTERED ADMIN EMAILS ---');
            admins.forEach(admin => console.log(admin.email));
            console.log('-------------------------------');
        }
    } catch (err) {
        console.error('Error fetching admins:', err);
    } finally {
        await prisma.$disconnect();
    }
}

main();
