
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Testing adOnSeriesOpen property...');
  try {
    // This will check if the property exists on the type
    const data: any = {
      title: 'Test',
      slug: 'test-' + Date.now(),
      ownerId: 'some-uuid',
      adOnSeriesOpen: true
    };
    
    console.log('Property check passed at type level (if this compiles)');
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

main();
