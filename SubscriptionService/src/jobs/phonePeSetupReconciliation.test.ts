import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks: no DB, no PhonePe, no network ────────────────────────────────────
// Defined via vi.hoisted so they exist when the (hoisted) vi.mock factories run.
const { mockTransaction, mockUserSubscription, mockGetRedemptionStatus, mockActivate } = vi.hoisted(() => ({
  mockTransaction: { findMany: vi.fn(), update: vi.fn() },
  mockUserSubscription: { findFirst: vi.fn() },
  mockGetRedemptionStatus: vi.fn(),
  mockActivate: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  getPrisma: () => ({
    transaction: mockTransaction,
    userSubscription: mockUserSubscription,
  }),
}));
vi.mock("../lib/phonepe", () => ({
  getPhonePe: () => ({ getRedemptionStatus: mockGetRedemptionStatus }),
}));
vi.mock("../services/phonePeActivation", () => ({
  activatePhonePeSetupOrder: mockActivate,
}));
vi.mock("../lib/analytics", () => ({
  trackSubscriptionEvent: vi.fn(),
}));

import { runPhonePeSetupReconciliationPass } from "./phonePeSetupReconciliation";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// A FAILED "superseded" transaction — the false-negative case we want to recover safely
function supersededFailedTx() {
  return {
    id: "tx-1",
    userId: "user-1",
    status: "FAILED",
    failureReason: "Superseded by new purchase intent",
    provider: "phonepe",
    subscriptionId: "OMGTV_SUB_test",
    planId: "plan-1",
    trialPlanId: "trial-1",
    amountPaise: 9900,
    createdAt: new Date(),
    metadata: { merchantOrderId: "OMGTV_ORD_test", merchantSubscriptionId: "OMGTV_SUB_test" },
  };
}

// findMany is called twice: once for the PENDING scan, once for the FAILED scan.
// Route by the where.status the cron passes.
function wireFindMany(opts: { pending?: any[]; failed?: any[] }) {
  mockTransaction.findMany.mockImplementation(async ({ where }: any) => {
    if (where.status === "PENDING") return opts.pending ?? [];
    if (where.status === "FAILED") return opts.failed ?? [];
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUserSubscription.findFirst.mockResolvedValue(null); // no existing active sub by default
  mockActivate.mockResolvedValue({ kind: "activated" });
});

describe("Layer 2 — FAILED order recovery safety", () => {
  it("RECOVERS a FAILED order when PhonePe says COMPLETED", async () => {
    wireFindMany({ failed: [supersededFailedTx()] });
    mockGetRedemptionStatus.mockResolvedValue({ state: "COMPLETED" });

    await runPhonePeSetupReconciliationPass(log);

    expect(mockActivate).toHaveBeenCalledTimes(1);
    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({ merchantOrderId: "OMGTV_ORD_test", merchantSubscriptionId: "OMGTV_SUB_test" })
    );
  });

  it("DOES NOT recover when PhonePe says FAILED (real failure stays failed)", async () => {
    wireFindMany({ failed: [supersededFailedTx()] });
    mockGetRedemptionStatus.mockResolvedValue({ state: "FAILED", errorCode: "INVALID_MPIN" });

    await runPhonePeSetupReconciliationPass(log);

    expect(mockActivate).not.toHaveBeenCalled();
  });

  it("DOES NOT recover when PhonePe says PENDING", async () => {
    wireFindMany({ failed: [supersededFailedTx()] });
    mockGetRedemptionStatus.mockResolvedValue({ state: "PENDING" });

    await runPhonePeSetupReconciliationPass(log);

    expect(mockActivate).not.toHaveBeenCalled();
  });

  it("SKIPS recovery if the user already has an active subscription (no redundant call)", async () => {
    wireFindMany({ failed: [supersededFailedTx()] });
    mockUserSubscription.findFirst.mockResolvedValue({ id: "sub-existing", status: "TRIAL" });

    await runPhonePeSetupReconciliationPass(log);

    expect(mockGetRedemptionStatus).not.toHaveBeenCalled();
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it("does not blow up when a FAILED tx is missing merchantOrderId", async () => {
    const tx = supersededFailedTx();
    tx.metadata = {} as any;
    tx.subscriptionId = null as any;
    wireFindMany({ failed: [tx] });

    await runPhonePeSetupReconciliationPass(log);

    expect(mockGetRedemptionStatus).not.toHaveBeenCalled();
    expect(mockActivate).not.toHaveBeenCalled();
  });
});

describe("Layer 1 — PENDING scan still works", () => {
  it("activates a PENDING order PhonePe reports COMPLETED", async () => {
    const pendingTx = { ...supersededFailedTx(), id: "tx-pending", status: "PENDING", failureReason: null };
    wireFindMany({ pending: [pendingTx] });
    mockGetRedemptionStatus.mockResolvedValue({ state: "COMPLETED" });

    await runPhonePeSetupReconciliationPass(log);

    expect(mockActivate).toHaveBeenCalledTimes(1);
  });
});
