/**
 * One-off script to cancel all active/trial subscriptions in prod,
 * except for a specific user (identified by EXCLUDE_USER_ID env var).
 *
 * Usage:
 *   EXCLUDE_USER_ID=<uuid> DATABASE_URL=<prod_url> RAZORPAY_KEY_ID=<live_key> RAZORPAY_KEY_SECRET=<live_secret> \
 *   npx ts-node scripts/cancel-all-subscriptions.ts
 *
 * Set DRY_RUN=true to preview without making changes.
 */

import { getPrisma, disconnectPrisma } from "../src/lib/prisma";
import { getRazorpay } from "../src/lib/razorpay";

const EXCLUDE_USER_ID = process.env.EXCLUDE_USER_ID;
const DRY_RUN = process.env.DRY_RUN === "true";

if (!EXCLUDE_USER_ID) {
    console.error("ERROR: EXCLUDE_USER_ID env var is required.");
    console.error("Run: SELECT id FROM users WHERE phone_number = '7500075001' in your auth/user DB to get it.");
    process.exit(1);
}

async function cancelAll() {
    const prisma = getPrisma();
    const razorpay = getRazorpay();

    console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE"}`);
    console.log(`Excluding userId: ${EXCLUDE_USER_ID}`);
    console.log("---");

    const activeSubs = await prisma.userSubscription.findMany({
        where: {
            status: { in: ["ACTIVE", "TRIAL", "PENDING"] },
            userId: { not: EXCLUDE_USER_ID },
        },
        select: {
            id: true,
            userId: true,
            status: true,
            razorpayOrderId: true,
        },
    });

    console.log(`Found ${activeSubs.length} subscriptions to cancel (excluding userId ${EXCLUDE_USER_ID})`);

    if (activeSubs.length === 0) {
        console.log("Nothing to do.");
        await disconnectPrisma();
        process.exit(0);
    }

    let razorpayCancelled = 0;
    let razorpaySkipped = 0;
    let razorpayErrors = 0;
    let dbCancelled = 0;

    for (const sub of activeSubs) {
        console.log(`\nProcessing sub ${sub.id} (userId: ${sub.userId}, status: ${sub.status})`);

        // Cancel on Razorpay if there's a subscription ID
        if (sub.razorpayOrderId) {
            if (DRY_RUN) {
                console.log(`  [DRY RUN] Would cancel Razorpay subscription: ${sub.razorpayOrderId}`);
                razorpaySkipped++;
            } else {
                try {
                    await razorpay.subscriptions.cancel(sub.razorpayOrderId, { cancel_at_cycle_end: 0 } as any);
                    console.log(`  Cancelled Razorpay subscription: ${sub.razorpayOrderId}`);
                    razorpayCancelled++;
                } catch (err: any) {
                    // Test subscription IDs won't exist in live mode - that's expected
                    console.warn(`  Razorpay cancel failed for ${sub.razorpayOrderId}: ${err?.error?.description || err?.message || err}`);
                    razorpayErrors++;
                }
            }
        } else {
            console.log(`  No razorpayOrderId - skipping Razorpay cancel`);
            razorpaySkipped++;
        }

        // Cancel in DB
        if (DRY_RUN) {
            console.log(`  [DRY RUN] Would mark DB subscription ${sub.id} as CANCELED`);
        } else {
            await prisma.userSubscription.update({
                where: { id: sub.id },
                data: { status: "CANCELED" },
            });
            console.log(`  Marked DB subscription ${sub.id} as CANCELED`);
            dbCancelled++;
        }
    }

    console.log("\n--- Summary ---");
    console.log(`Total subscriptions processed: ${activeSubs.length}`);
    console.log(`Razorpay cancelled: ${razorpayCancelled}`);
    console.log(`Razorpay skipped/no-id: ${razorpaySkipped}`);
    console.log(`Razorpay errors (likely test IDs): ${razorpayErrors}`);
    console.log(`DB marked CANCELED: ${dbCancelled}`);

    // Show the excluded user's subscriptions for confirmation
    const keptSubs = await prisma.userSubscription.findMany({
        where: { userId: EXCLUDE_USER_ID },
        select: { id: true, status: true, endsAt: true },
    });
    console.log(`\nKept subscriptions for userId ${EXCLUDE_USER_ID}: ${keptSubs.length}`);
    keptSubs.forEach(s => console.log(`  ${s.id} - ${s.status} - ends ${s.endsAt}`));

    await disconnectPrisma();
    process.exit(0);
}

cancelAll().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
