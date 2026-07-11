import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";

// Mock the stripe SDK so we don't need real keys.
const mockConstructEvent = vi.fn();
const mockRetrieve = vi.fn();
vi.mock("./stripe", () => ({
  getStripeClient: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    paymentIntents: { retrieve: mockRetrieve },
  }),
  getStripeWebhookSecret: () => "whsec_test",
  STRIPE_API_VERSION: "2024-06-20",
}));

import {
  handleWebhook,
  WebhookSignatureError,
  isHandledEventType,
  type WebhookRowStore,
  type WebhookOutcome,
} from "./webhooks";

function fakeStore(
  overrides: Partial<WebhookRowStore> = {}
): WebhookRowStore {
  const seen = new Set<string>();
  return {
    hasSeenEvent: vi.fn(async (id: string) => seen.has(id)),
    recordEventSeen: vi.fn(async (id: string) => {
      seen.add(id);
    }),
    findByStripePaymentIntentId: vi.fn(async () => null),
    applyTransition: vi.fn(async (record) => record),
    markOrderState: vi.fn(async () => undefined),
    ...overrides,
  };
}

const fakePaymentIntent = (id = "pi_test_abc") =>
  ({
    id,
    object: "payment_intent",
    status: "succeeded",
    amount: 1000,
    currency: "usd",
  } as unknown as Stripe.PaymentIntent);

const fakeCharge = (id = "ch_test_abc", piId = "pi_test_abc", refunded = 1000) =>
  ({
    id,
    object: "charge",
    payment_intent: piId,
    amount: 1000,
    amount_refunded: refunded,
  } as unknown as Stripe.Charge);

function fakeEvent(
  type: string,
  data: object = {},
  id = "evt_test_1"
): Stripe.Event {
  return {
    id,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: data as unknown as Stripe.Event.Data.Object },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  mockConstructEvent.mockReset();
  mockRetrieve.mockReset();
});

describe("isHandledEventType", () => {
  it("accepts the documented set", () => {
    for (const t of [
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "payment_intent.canceled",
      "charge.refunded",
      "charge.dispute.created",
    ]) {
      expect(isHandledEventType(t)).toBe(true);
    }
  });

  it("rejects unknown types", () => {
    expect(isHandledEventType("payment_intent.requires_action")).toBe(false);
    expect(isHandledEventType("customer.created")).toBe(false);
  });
});

describe("handleWebhook", () => {
  it("rejects invalid signatures with a thrown error", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });
    const store = fakeStore();
    await expect(handleWebhook("{}", "bad", store)).rejects.toBeInstanceOf(
      WebhookSignatureError
    );
  });

  it("returns duplicate on replayed events", async () => {
    mockConstructEvent.mockReturnValue(fakeEvent("payment_intent.succeeded", fakePaymentIntent(), "evt_replay"));
    const store = fakeStore({
      hasSeenEvent: vi.fn(async () => true),
    });
    const out = await handleWebhook("{}", "ok", store);
    expect(out.status).toBe("duplicate");
    expect(store.applyTransition).not.toHaveBeenCalled();
  });

  it("applies payment_intent.succeeded", async () => {
    const apply = vi.fn(async (rec) => ({ ...rec, state: "captured" }));
    mockConstructEvent.mockReturnValue(
      fakeEvent("payment_intent.succeeded", fakePaymentIntent(), "evt_succ")
    );
    const store = fakeStore({
      findByStripePaymentIntentId: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000001",
        orderId: "00000000-0000-0000-0000-000000000002",
        stripePaymentIntentId: "pi_test_abc",
        amountCents: 1000,
        currency: "usd",
        state: "pending" as const,
        refundedAmountCents: 0,
        lastErrorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      applyTransition: apply,
      markOrderState: vi.fn(async () => undefined),
    });
    const out = await handleWebhook("{}", "ok", store);
    expect(out.status).toBe("applied");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.markOrderState).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000002",
      "paid"
    );
  });

  it("applies charge.refunded and updates refunded_amount_cents", async () => {
    const apply = vi.fn(async (rec, _next, refunded) => ({
      ...rec,
      state: "refunded" as const,
      refundedAmountCents: refunded ?? rec.refundedAmountCents,
    }));
    mockConstructEvent.mockReturnValue(
      fakeEvent("charge.refunded", fakeCharge("ch_1", "pi_test_abc", 1000), "evt_ref")
    );
    const store = fakeStore({
      findByStripePaymentIntentId: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000001",
        orderId: "00000000-0000-0000-0000-000000000002",
        stripePaymentIntentId: "pi_test_abc",
        amountCents: 1000,
        currency: "usd",
        state: "captured" as const,
        refundedAmountCents: 0,
        lastErrorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      applyTransition: apply,
    });
    const out: WebhookOutcome = await handleWebhook("{}", "ok", store);
    expect(out.status).toBe("applied");
    expect(apply).toHaveBeenCalledWith(expect.anything(), "refunded", 1000);
  });

  it("ignores unknown event types without raising", async () => {
    mockConstructEvent.mockReturnValue(
      fakeEvent("customer.created", { id: "cus_1" }, "evt_cust")
    );
    const store = fakeStore();
    const out = await handleWebhook("{}", "ok", store);
    expect(out.status).toBe("ignored");
    expect(store.applyTransition).not.toHaveBeenCalled();
  });

  it("ignores events with no matching local row", async () => {
    mockConstructEvent.mockReturnValue(
      fakeEvent("payment_intent.succeeded", fakePaymentIntent("pi_unknown"), "evt_unknown")
    );
    const store = fakeStore({
      findByStripePaymentIntentId: vi.fn(async () => null),
    });
    const out = await handleWebhook("{}", "ok", store);
    expect(out.status).toBe("ignored");
    expect(store.applyTransition).not.toHaveBeenCalled();
  });

  it("returns no_op on out-of-order illegal transition", async () => {
    // Captured -> pending is illegal. Stripe sends `payment_intent.succeeded`
    // twice (replay after deploy). The second time we're already captured.
    mockConstructEvent.mockReturnValue(
      fakeEvent("payment_intent.succeeded", fakePaymentIntent(), "evt_oof")
    );
    const store = fakeStore({
      findByStripePaymentIntentId: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000001",
        orderId: "00000000-0000-0000-0000-000000000002",
        stripePaymentIntentId: "pi_test_abc",
        amountCents: 1000,
        currency: "usd",
        state: "captured" as const,
        refundedAmountCents: 0,
        lastErrorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    });
    const out = await handleWebhook("{}", "ok", store);
    expect(out.status).toBe("no_op");
    expect(store.applyTransition).not.toHaveBeenCalled();
  });

  it("applies charge.dispute.created and marks order disputed", async () => {
    mockConstructEvent.mockReturnValue(
      fakeEvent(
        "charge.dispute.created",
        fakeCharge("ch_1", "pi_test_abc", 0),
        "evt_disp"
      )
    );
    const markOrderState = vi.fn(async () => undefined);
    const store = fakeStore({
      findByStripePaymentIntentId: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000001",
        orderId: "00000000-0000-0000-0000-000000000002",
        stripePaymentIntentId: "pi_test_abc",
        amountCents: 1000,
        currency: "usd",
        state: "captured" as const,
        refundedAmountCents: 0,
        lastErrorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      markOrderState,
    });
    const out = await handleWebhook("{}", "ok", store);
    expect(out.status).toBe("applied");
    expect(markOrderState).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000002",
      "disputed"
    );
  });
});