/**
 * One-time fix: create UserSubscription + Transaction records for users
 * who paid on Razorpay but whose webhook failed to record in our DB.
 *
 * Usage:
 *   cd SubscriptionService
 *   npx tsx scripts/fix-missing-payments.ts --dry-run   # preview only
 *   npx tsx scripts/fix-missing-payments.ts             # apply fix
 */

import dotenv from 'dotenv';
dotenv.config();

import Razorpay from 'razorpay';
import { getPrisma, disconnectPrisma } from '../src/lib/prisma';

const DRY_RUN = process.argv.includes('--dry-run');

// Users who paid on Razorpay but have ZERO subscription record in our DB.
// Script will create UserSubscription (ACTIVE) + Transaction (SUCCESS) for each.
const MISSING_PAYMENTS: Record<string, string> = {
  'pay_SsPmlsqTRgrlZA': '67a48f7d-d4a2-4199-a8f9-370004712c88', // +919895558190  May 22
  'pay_Ss93RWgFjkoI2F': 'd4c35ec7-579e-48ee-8d95-a7ac7d6a504a', // +917984120322  May 22
  'pay_SsxKxSscmRnDj4': 'b3cecff9-385e-4f92-a356-d71e669fd26f', // +919923499860  May 24
  'pay_SruFKPlvMEfebL': '89fe04a1-c114-417a-9b96-3b264f6e36fe', // +919831057307  May 21
  'pay_SrmbOBr8muodYR': 'aa1ddd98-6f4f-469a-8e79-01dc89b43129', // +918955539477  May 21
  'pay_SrkjGWtvSEwVWe': '79d044d5-35fb-4779-ae19-0b5207eeb643', // +919892866437  May 21
  'pay_Srk6zIAKsCBSQK': '03e9514b-b57a-4347-9dc8-ef4527716b93', // +919519286175  May 21 (latest of 3 attempts)
};

// Recurring renewal: user already has an existing EXPIRED subscription for the same
// Razorpay subscription ID. We UPDATE it (extend endsAt) + add a new Transaction.
// Do NOT create a new UserSubscription — Razorpay reuses the same sub ID for renewals.
const RECURRING_RENEWAL = {
  paymentId: 'pay_St1IiI3EcDXNw1',
  userId: '1d641baf-b774-4383-831b-f42a1bb0d0ac', // +918830583634, 3rd renewal May 24
};

async function main() {
  const prisma = getPrisma();
  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!,
  });

  // 3-Month plan (was ₹99, now ₹249 — same row, hardcoded ID to avoid price-mismatch)
  const plan = await prisma.subscriptionPlan.findUnique({
    where: { id: '21310b4b-ba4b-479e-9ba4-205feecfea36' },
  });
  if (!plan) throw new Error('Could not find 3-Month plan in DB');
  console.log(`Using plan: ${plan.name} (${plan.id})`);

  // ── Part 1: New subscriptions (zero DB record) ───────────────────────────
  for (const [paymentId, userId] of Object.entries(MISSING_PAYMENTS)) {
    console.log(`\n--- [NEW] ${paymentId} → user ${userId} ---`);

    let payment: any;
    try {
      payment = await razorpay.payments.fetch(paymentId);
    } catch (err: any) {
      console.error(`  ❌ Razorpay fetch failed: ${err.message}`);
      continue;
    }

    if (payment.status !== 'captured') {
      console.log(`  ⚠️  Payment status is "${payment.status}", skipping`);
      continue;
    }

    const razorpaySubscriptionId: string = payment.invoice_id || payment.subscription_id;
    if (!razorpaySubscriptionId) {
      console.error(`  ❌ No subscription_id on payment:`, JSON.stringify(payment, null, 2));
      continue;
    }

    const amountPaise: number = payment.amount;
    const paidAt = new Date(payment.created_at * 1000);
    const endsAt = new Date(paidAt.getTime() + 30 * 24 * 60 * 60 * 1000);

    console.log(`  sub_id: ${razorpaySubscriptionId}, ₹${amountPaise / 100}, endsAt: ${endsAt.toISOString()}`);

    const existingSub = await prisma.userSubscription.findFirst({ where: { razorpayOrderId: razorpaySubscriptionId } });
    if (existingSub) { console.log(`  ℹ️  Subscription already exists (${existingSub.status}), skipping`); continue; }

    const existingTx = await prisma.transaction.findFirst({ where: { razorpayPaymentId: paymentId } });
    if (existingTx) { console.log(`  ℹ️  Transaction already exists, skipping`); continue; }

    if (DRY_RUN) { console.log(`  ✅ [DRY RUN] Would create subscription + transaction`); continue; }

    await prisma.$transaction([
      prisma.userSubscription.create({
        data: { userId, planId: plan.id, razorpayOrderId: razorpaySubscriptionId, status: 'ACTIVE', startsAt: paidAt, endsAt },
      }),
      prisma.transaction.create({
        data: { userId, subscriptionId: razorpaySubscriptionId, razorpayPaymentId: paymentId, amountPaise, status: 'SUCCESS', createdAt: paidAt },
      }),
    ]);
    console.log(`  ✅ Created subscription ACTIVE until ${endsAt.toISOString()}`);
  }

  // ── Part 2: Recurring renewal (existing sub, just extend endsAt) ─────────
  console.log(`\n--- [RENEWAL] ${RECURRING_RENEWAL.paymentId} → user ${RECURRING_RENEWAL.userId} ---`);
  {
    const { paymentId, userId } = RECURRING_RENEWAL;

    let payment: any;
    try {
      payment = await razorpay.payments.fetch(paymentId);
    } catch (err: any) {
      console.error(`  ❌ Razorpay fetch failed: ${err.message}`);
    }

    if (payment && payment.status === 'captured') {
      const razorpaySubscriptionId: string = payment.invoice_id || payment.subscription_id;
      const amountPaise: number = payment.amount;
      const paidAt = new Date(payment.created_at * 1000);
      const newEndsAt = new Date(paidAt.getTime() + 30 * 24 * 60 * 60 * 1000);

      console.log(`  sub_id: ${razorpaySubscriptionId}, ₹${amountPaise / 100}, newEndsAt: ${newEndsAt.toISOString()}`);

      const existingSub = await prisma.userSubscription.findFirst({ where: { razorpayOrderId: razorpaySubscriptionId } });
      if (!existingSub) {
        console.error(`  ❌ No existing subscription found for ${razorpaySubscriptionId} — cannot update`);
      } else {
        const existingTx = await prisma.transaction.findFirst({ where: { razorpayPaymentId: paymentId } });
        if (existingTx) {
          console.log(`  ℹ️  Renewal already recorded, skipping`);
        } else if (DRY_RUN) {
          console.log(`  ✅ [DRY RUN] Would update sub to ACTIVE endsAt=${newEndsAt.toISOString()} + create renewal tx`);
        } else {
          await prisma.$transaction([
            prisma.userSubscription.update({
              where: { id: existingSub.id },
              data: { status: 'ACTIVE', endsAt: newEndsAt },
            }),
            prisma.transaction.create({
              data: { userId, subscriptionId: razorpaySubscriptionId, razorpayPaymentId: paymentId, amountPaise, status: 'SUCCESS', createdAt: paidAt },
            }),
          ]);
          console.log(`  ✅ Renewed subscription ACTIVE until ${newEndsAt.toISOString()}`);
        }
      }
    }
  }

  console.log('\nDone.');
  await disconnectPrisma();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
