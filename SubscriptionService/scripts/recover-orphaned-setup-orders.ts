import { getPrisma } from "../src/lib/prisma";
import { getPhonePe } from "../src/lib/phonepe";
import { activatePhonePeSetupOrder } from "../src/services/phonePeActivation";

// One-time recovery for setup orders confirmed COMPLETED on PhonePe but stuck
// FAILED ("Superseded by new purchase intent") in our DB — found via manual
// reconciliation against PhonePe's dashboard for 18-22 June.
const TRANSACTION_IDS = [
  "61f248bf-28a3-4f7b-9a5b-2b40b3c25e10", // OMGTV_ORD_9a932bfcc0d54574
  "3881e621-7a5d-43d1-9900-522dc458a562", // OMGTV_ORD_3651bfb1d62e43f6
  "940a9987-d8c5-4daa-8e05-4337f9ee925e", // OMGTV_ORD_e95d44f938a04290
  "02a2a5a1-c7a9-4d13-a822-a2fa411b8f51", // OMGTV_ORD_9ae26be131f34318
];

const log = {
  info: (obj: object | string, msg?: string) => console.log(msg ?? "", obj),
  warn: (obj: object | string, msg?: string) => console.warn(msg ?? "", obj),
  error: (obj: object | string, msg?: string) => console.error(msg ?? "", obj),
};

async function main() {
  const prisma = getPrisma();
  const phonepe = getPhonePe();

  for (const txId of TRANSACTION_IDS) {
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx) {
      console.error(`SKIP ${txId}: transaction not found`);
      continue;
    }

    const meta = (tx.metadata ?? {}) as Record<string, unknown>;
    const merchantOrderId = meta.merchantOrderId as string | undefined;
    const merchantSubscriptionId =
      (meta.merchantSubscriptionId as string | undefined) ?? tx.subscriptionId ?? undefined;

    if (!merchantOrderId || !merchantSubscriptionId) {
      console.error(`SKIP ${txId}: missing merchantOrderId/merchantSubscriptionId`);
      continue;
    }

    // Safety re-check: reconfirm with PhonePe right before activating — never trust a manual list alone
    const orderStatus = await phonepe.getRedemptionStatus(merchantOrderId, tx.userId);
    if (orderStatus.state !== "COMPLETED") {
      console.error(`SKIP ${txId} (${merchantOrderId}): PhonePe state is ${orderStatus.state}, not COMPLETED — not activating`);
      continue;
    }

    const result = await activatePhonePeSetupOrder({
      transaction: tx,
      merchantOrderId,
      merchantSubscriptionId,
      log,
    });

    console.log(`DONE ${txId} (${merchantOrderId}) userId=${tx.userId} → ${result.kind}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Recovery script failed:", err);
  process.exit(1);
});
