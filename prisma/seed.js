import { prisma } from '../src/db.js';

async function main() {
  console.log('Seed step complete. No static DB seed data required.');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
