import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("./stripe", () => ({
  getStripeClient: () => ({
    paymentIntents: { create: mockCreate, retrieve: vi.fn() },
  }),
}));

import {
  createIntentForOrder,
  newPendingRecord,
  OrderNotPayableError,
  AmountMismatchError,
} from "./intents";
import type { OrderSnapshot } from "./intents";

const baseOrder: OrderSnapshot = {
  id: "00000000-0000-0000-0000-000000000aaa",
  state: "initiated",
  amountMinor: 2500,
  currency: "USD",
  buyerId: "00000000-0000-0000-0000-000000000bbb",
  sellerId: "00000000-0000-0000-0000-000000000ccc",
};

beforeEach(() => {
  mockCreate.mockReset();
});

describe("createIntentForOrder", () => {
  it("creates a PI on Stripe with the idempotency key and lowercased currency", async () => {
    mockCreate.mockResolvedValue({
      id: "pi_test_xyz",
      client_secret: "pi_test_xyz_secret_42",
    });

    const result = await createIntentForOrder({
      paymentIntentRecordId: "00000000-0000-0000-0000-000000000001",
      order: baseOrder,
    });

    expect(result.stripePaymentIntentId).toBe("pi_test_xyz");
    expect(result.clientSecret).toBe("pi_test_xyz_secret_42");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const [params, options] = mockCreate.mock.calls[0];
    expect(params.amount).toBe(2500);
    expect(params.currency).toBe("usd");
    expect(params.metadata.order_id).toBe(baseOrder.id);
    expect(params.metadata.payment_intent_record_id).toBe(
      "00000000-0000-0000-0000-000000000001"
    );
    expect(options.idempotencyKey).toBe(
      "pi-create:00000000-0000-0000-0000-000000000001"
    );
  });

  it("refuses non-initiated orders with OrderNotPayableError", async () => {
    await expect(
      createIntentForOrder({
        paymentIntentRecordId: "00000000-0000-0000-0000-000000000001",
        order: { ...baseOrder, state: "paid" },
      })
    ).rejects.toBeInstanceOf(OrderNotPayableError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses non-positive amounts", async () => {
    await expect(
      createIntentForOrder({
        paymentIntentRecordId: "00000000-0000-0000-0000-000000000001",
        order: { ...baseOrder, amountMinor: 0 },
      })
    ).rejects.toBeInstanceOf(AmountMismatchError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("attaches buyer_email when provided", async () => {
    mockCreate.mockResolvedValue({ id: "pi_1", client_secret: "sec" });
    await createIntentForOrder({
      paymentIntentRecordId: "00000000-0000-0000-0000-000000000001",
      order: baseOrder,
      buyerEmail: "buyer@example.com",
    });
    expect(mockCreate.mock.calls[0][0].receipt_email).toBe("buyer@example.com");
  });
});

describe("newPendingRecord", () => {
  it("builds a row in pending state with all fields populated", () => {
    const rec = newPendingRecord({
      paymentIntentRecordId: "00000000-0000-0000-0000-000000000001",
      order: baseOrder,
    });
    expect(rec.state).toBe("pending");
    expect(rec.amountCents).toBe(2500);
    expect(rec.currency).toBe("usd");
    expect(rec.refundedAmountCents).toBe(0);
    expect(rec.stripePaymentIntentId).toBeNull();
    expect(rec.orderId).toBe(baseOrder.id);
  });
});