import { getPrisma } from "../lib/prisma";
import { getPhonePe } from "../lib/phonepe";
import { activatePhonePeSetupOrder } from "./phonePeActivation";

interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

// matches createSubscriptionOrderToken's expireAfter: 900s
const ORDER_VALIDITY_MS = 15 * 60 * 1000;

export type IntentGuardResult =
  | { kind: "mint_new" }
  | { kind: "already_paid" }
  | {
      kind: "resume";
      transactionId: string;
      orderToken: string;
      phonePeOrderId?: string;
      merchantOrderId: string;
      merchantSubscriptionId: string;
      amountPaise: number;
      currency: string;
    };

/**
 * Double-charge guard for POST /purchase/intent (PhonePe).
 *
 * Scope: this ONLY handles in-flight orders (the window between starting a payment and it
 * being confirmed). The "user already has an active/trial subscription" case — including the
 * trial→paid upgrade exception — is handled by the existing top-level check in the route,
 * which runs BEFORE this guard. We must NOT re-block active subscribers here or we'd break
 * legitimate upgrades.
 *
 * The in-flight lookup is scoped to the SAME offer (planId + trialPlanId) so that, e.g., a
 * pending TRIAL order is never resumed for a PAID purchase (an upgrade), and vice-versa.
 *
 * Every decision about an in-flight order is gated on PhonePe's LIVE Order Status — never our
 * local guess. The server is the only thing that can mint a PhonePe order token, so refusing
 * to mint a second one for the same offer is a complete guarantee against double charges.
 *
 *   already_paid → in-flight order is COMPLETED on PhonePe; activated, don't issue a new order
 *   resume       → in-flight order still PENDING+unpaid; return the SAME token (no 2nd mandate)
 *   mint_new     → no in-flight order, or it FAILED, or PhonePe unreachable; mint a fresh order
 */
export async function evaluatePhonePeIntentGuard(params: {
  userId: string;
  planId: string;
  trialPlanId: string | null;
  log: Logger;
}): Promise<IntentGuardResult> {
  const { userId, planId, trialPlanId, log } = params;
  const prisma = getPrisma();

  // Recent in-flight PENDING order for this EXACT offer (same plan + same trial-ness)?
  const inFlight = await prisma.transaction.findFirst({
    where: {
      userId,
      provider: "phonepe",
      status: "PENDING",
      planId,
      trialPlanId, // null for paid, the trial id for trial — keeps upgrades separate
      createdAt: { gt: new Date(Date.now() - ORDER_VALIDITY_MS) },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!inFlight) return { kind: "mint_new" };

  const m = (inFlight.metadata ?? {}) as Record<string, unknown>;
  const flightOrderId = typeof m.merchantOrderId === "string" ? m.merchantOrderId : undefined;
  const flightSubId =
    (typeof m.merchantSubscriptionId === "string" ? m.merchantSubscriptionId : undefined) ??
    inFlight.subscriptionId ??
    undefined;
  const flightToken = typeof m.orderToken === "string" ? m.orderToken : undefined;

  // No identifiers to check against PhonePe — safest to mint a fresh order.
  if (!flightOrderId || !flightSubId) return { kind: "mint_new" };

  // Build the "resume the same order" result once (used for PENDING and for the
  // can't-confirm fallback). Resuming the SAME order can never double-charge.
  const resumeResult: IntentGuardResult | null = flightToken
    ? {
        kind: "resume",
        transactionId: inFlight.id,
        orderToken: flightToken,
        phonePeOrderId: typeof m.phonePeOrderId === "string" ? m.phonePeOrderId : undefined,
        merchantOrderId: flightOrderId,
        merchantSubscriptionId: flightSubId,
        amountPaise: inFlight.amountPaise,
        currency: inFlight.currency,
      }
    : null;

  let flightStatus;
  try {
    flightStatus = await getPhonePe().getRedemptionStatus(flightOrderId, userId);
  } catch (err: any) {
    // We could NOT confirm the order state. We must not assume it's unpaid — if it was
    // actually paid, minting a new order would double-charge. So prefer to RESUME the same
    // order (same mandate = impossible to double-charge); only mint fresh if we have no
    // token to resume with. The cron/webhook will still reconcile the order independently.
    log.warn({ msg: "phonepe intent guard: status check failed", txId: inFlight.id, error: err?.message });
    return resumeResult ?? { kind: "mint_new" };
  }

  if (flightStatus.state === "COMPLETED") {
    // PAID. Activate best-effort, but ALWAYS return already_paid — NEVER mint a new order for
    // a user who has already paid, even if activation throws here. If activation fails, the
    // webhook / setup-reconciliation cron will retry it (idempotent). Issuing a new payable
    // order in this state is the one thing we must never do.
    try {
      await activatePhonePeSetupOrder({
        transaction: inFlight,
        merchantOrderId: flightOrderId,
        merchantSubscriptionId: flightSubId,
        log,
      });
    } catch (activateErr: any) {
      log.error({ msg: "phonepe intent guard: activation failed for already-paid order; cron/webhook will retry", txId: inFlight.id, merchantOrderId: flightOrderId, error: activateErr?.message });
    }
    return { kind: "already_paid" };
  }

  if (flightStatus.state === "PENDING" && resumeResult) {
    // Still open and unpaid — resume the SAME checkout (no second mandate).
    return resumeResult;
  }

  // FAILED, or PENDING with no stored token → mint a fresh order.
  // An unpaid order carries no mandate, so a fresh order cannot double-charge.
  return { kind: "mint_new" };
}
