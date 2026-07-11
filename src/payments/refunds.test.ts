import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRefundCreate = vi.fn();
vi.mock("./stripe", () => ({
  getStripeClient: () => ({
    refunds: { create: mockRefundCreate },
  }),
}));

import {
  createRefund,
  RefundNotAllowedError,
  type CreateRefundInput,
} from "./refunds";
import type { PaymentIntentRecord } from "./types";

function baseRecord(overrides: Partial<PaymentIntentRecord> = {}): PaymentIntentRecord {
  const now = new Date();
  return {
    id: "00000000-0000-0000-0000-000000000001",
    orderId: "00000000-0000-0000-0000-000000000002",
    stripePaymentIntentId: "pi_test_abc",
    amountCents: 1000,
    currency: "usd",
    state: "captured",
    refundedAmountCents: 0,
    lastErrorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const baseInput: CreateRefundInput = {
  paymentIntentRecord: baseRecord(),
  refundRecordId: "00000000-0000-0000-0000-000000000099",
  reason: "requested_by_customer",
  initiator: "seller",
};

beforeEach(() => {
  mockRefundCreate.mockReset();
});

describe("createRefund", () => {
  it("issues a full refund when amount is omitted and initiator is seller", async () => {
    mockRefundCreate.mockResolvedValue({ id: "re_test_1" });
    const out = await createRefund(baseInput);
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
    const [params, opts] = mockRefundCreate.mock.calls[0];
    expect(params.payment_intent).toBe("pi_test_abc");
    expect(params.amount).toBe(1000); // full remaining
    expect(opts.idempotencyKey).toBe(
      "re-create:00000000-0000-0000-0000-000000000099"
    );
    expect(out.refund.kind).toBe("full");
    expect(out.newPaymentIntentState).toBe("refunded");
    expect(out.newRefundedAmountCents).toBe(1000);
  });

  it("issues a partial refund when amount is given", async () => {
    mockRefundCreate.mockResolvedValue({ id: "re_test_2" });
    const out = await createRefund({
      ...baseInput,
      amountCents: 400,
    });
    expect(out.refund.kind).toBe("partial");
    expect(out.newPaymentIntentState).toBe("partially_refunded");
    expect(out.newRefundedAmountCents).toBe(400);
  });

  it("refuses fraudulent refunds initiated by sellers", async () => {
    await expect(
      createRefund({ ...baseInput, reason: "fraudulent" })
    ).rejects.toBeInstanceOf(RefundNotAllowedError);
    expect(mockRefundCreate).not.toHaveBeenCalled();
  });

  it("allows fraudulent refunds initiated by admins", async () => {
    mockRefundCreate.mockResolvedValue({ id: "re_test_3" });
    const out = await createRefund({
      ...baseInput,
      initiator: "admin",
      reason: "fraudulent",
    });
    expect(out.refund.reason).toBe("fraudulent");
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects refunds that would exceed the captured amount", async () => {
    await expect(
      createRefund({
        ...baseInput,
        amountCents: 1500,
      })
    ).rejects.toThrow();
    expect(mockRefundCreate).not.toHaveBeenCalled();
  });

  it("rejects refunds from non-captured states", async () => {
    mockRefundCreate.mockResolvedValue({ id: "re_test_4" });
    await expect(
      createRefund({
        ...baseInput,
        paymentIntentRecord: baseRecord({ state: "pending" }),
      })
    ).rejects.toThrow();
    expect(mockRefundCreate).not.toHaveBeenCalled();
  });
});