import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTransaction, mockGetRedemptionStatus, mockActivate } = vi.hoisted(() => ({
  mockTransaction: { findFirst: vi.fn() },
  mockGetRedemptionStatus: vi.fn(),
  mockActivate: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  getPrisma: () => ({ transaction: mockTransaction }),
}));
vi.mock("../lib/phonepe", () => ({
  getPhonePe: () => ({ getRedemptionStatus: mockGetRedemptionStatus }),
}));
vi.mock("./phonePeActivation", () => ({
  activatePhonePeSetupOrder: mockActivate,
}));

import { evaluatePhonePeIntentGuard } from "./phonePeIntentGuard";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const args = { userId: "user-1", planId: "plan-1", trialPlanId: "trial-1", log };

function inFlightTx() {
  return {
    id: "tx-1",
    userId: "user-1",
    amountPaise: 9900,
    currency: "INR",
    subscriptionId: "OMGTV_SUB_x",
    metadata: { merchantOrderId: "OMGTV_ORD_x", merchantSubscriptionId: "OMGTV_SUB_x", orderToken: "TOKEN_ABC", phonePeOrderId: "OMO_x" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction.findFirst.mockResolvedValue(null);
  mockActivate.mockResolvedValue({ kind: "activated" });
});

describe("evaluatePhonePeIntentGuard — double-charge guard", () => {
  it("MINT_NEW when there is no in-flight order (normal first-time flow, upgrades unaffected)", async () => {
    const r = await evaluatePhonePeIntentGuard(args);
    expect(r.kind).toBe("mint_new");
    expect(mockGetRedemptionStatus).not.toHaveBeenCalled();
  });

  it("ALREADY_PAID (and activates) when the in-flight order is COMPLETED on PhonePe", async () => {
    mockTransaction.findFirst.mockResolvedValue(inFlightTx());
    mockGetRedemptionStatus.mockResolvedValue({ state: "COMPLETED" });

    const r = await evaluatePhonePeIntentGuard(args);

    expect(r.kind).toBe("already_paid");
    expect(mockActivate).toHaveBeenCalledTimes(1);
    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({ merchantOrderId: "OMGTV_ORD_x", merchantSubscriptionId: "OMGTV_SUB_x" })
    );
  });

  it("RESUME (returns the SAME token, no new order) when the in-flight order is still PENDING", async () => {
    mockTransaction.findFirst.mockResolvedValue(inFlightTx());
    mockGetRedemptionStatus.mockResolvedValue({ state: "PENDING" });

    const r = await evaluatePhonePeIntentGuard(args);

    expect(r.kind).toBe("resume");
    if (r.kind === "resume") {
      expect(r.orderToken).toBe("TOKEN_ABC");
      expect(r.merchantOrderId).toBe("OMGTV_ORD_x");
    }
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it("MINT_NEW when the in-flight order FAILED on PhonePe (genuine retry allowed)", async () => {
    mockTransaction.findFirst.mockResolvedValue(inFlightTx());
    mockGetRedemptionStatus.mockResolvedValue({ state: "FAILED", errorCode: "INVALID_MPIN" });

    const r = await evaluatePhonePeIntentGuard(args);

    expect(r.kind).toBe("mint_new");
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it("ALREADY_PAID even when activation throws (NEVER mints a new order for a paid user)", async () => {
    // The critical double-charge guard: PhonePe says COMPLETED but activation hits an error.
    // We must still return already_paid (no new order) and let the cron/webhook retry.
    mockTransaction.findFirst.mockResolvedValue(inFlightTx());
    mockGetRedemptionStatus.mockResolvedValue({ state: "COMPLETED" });
    mockActivate.mockRejectedValue(new Error("transient DB error"));

    const r = await evaluatePhonePeIntentGuard(args);

    expect(r.kind).toBe("already_paid"); // NOT mint_new — would double-charge
  });

  it("RESUMES (not mint_new) when status check throws but we have a token — avoids double charge", async () => {
    // If we can't confirm the order state, resuming the SAME order can't double-charge,
    // whereas minting a new one could (if the order was actually paid).
    mockTransaction.findFirst.mockResolvedValue(inFlightTx());
    mockGetRedemptionStatus.mockRejectedValue(new Error("network"));

    const r = await evaluatePhonePeIntentGuard(args);

    expect(r.kind).toBe("resume");
  });

  it("MINT_NEW when status check throws and there is NO token to resume", async () => {
    const tx = inFlightTx();
    tx.metadata = { merchantOrderId: "OMGTV_ORD_x", merchantSubscriptionId: "OMGTV_SUB_x" } as any;
    mockTransaction.findFirst.mockResolvedValue(tx);
    mockGetRedemptionStatus.mockRejectedValue(new Error("network"));

    const r = await evaluatePhonePeIntentGuard(args);

    expect(r.kind).toBe("mint_new");
  });

  it("RESUME is skipped (MINT_NEW) when the in-flight order has no stored token", async () => {
    const tx = inFlightTx();
    tx.metadata = { merchantOrderId: "OMGTV_ORD_x", merchantSubscriptionId: "OMGTV_SUB_x" } as any;
    mockTransaction.findFirst.mockResolvedValue(tx);
    mockGetRedemptionStatus.mockResolvedValue({ state: "PENDING" });

    const r = await evaluatePhonePeIntentGuard(args);

    expect(r.kind).toBe("mint_new");
  });
});
