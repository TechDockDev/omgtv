import { PrismaClient } from "@prisma/client";

// Creates the single audience_config row (id = 1) with sample values.
//
//   npm run seed:audience
//
// Safe to re-run: an existing row is left untouched, so it never overwrites
// what an admin has configured. The sample is deliberately NOT live (banner off,
// registration closed) - an admin turns it on via PATCH /admin/config.
const prisma = new PrismaClient();

async function main() {
  const row = await prisma.audienceConfig.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      bannerEnabled: false,
      registrationOpen: false,
      bannerImageUrl: "https://cdn.example.com/banners/audience.jpg",
      title: "Be in the audience of India's Funniest Family",
      subtitle: "Groups of 5 or more. First come, first served.",
      ctaLabel: "Register now",
      startsAt: new Date("2026-10-01T00:00:00+05:30"),
      endsAt: new Date("2026-10-20T23:59:59+05:30"),
    },
  });
  console.log(
    `audience_config ready (banner ${row.bannerEnabled ? "ON" : "off"}, registration ${
      row.registrationOpen ? "open" : "closed"
    })`
  );
}

main()
  .catch((err) => {
    console.error("seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
