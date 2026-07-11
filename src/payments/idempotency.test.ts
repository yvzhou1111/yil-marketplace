import { describe, it, expect } from "vitest";
import {
  stripeIdempotencyKey,
  isSameWebhookEvent,
  isDedupeWindowExpired,
  STRIPE_EVENT_DEDUPE_WINDOW_MS,
} from "./idempotency";

describe("stripeIdempotencyKey", () => {
  it("prefixes the scope", () => {
    expect(stripeIdempotencyKey("intent", "abc")).toBe("pi-create:abc");
    expect(stripeIdempotencyKey("refund", "xyz")).toBe("re-create:xyz");
  });

  it("throws on empty domain id", () => {
    expect(() => stripeIdempotencyKey("intent", "")).toThrow();
  });

  it("produces keys Stripe accepts (≤255 chars)", () => {
    const id = "a".repeat(200);
    const key = stripeIdempotencyKey("intent", id);
    expect(key.length).toBeLessThanOrEqual(255);
  });
});

describe("isSameWebhookEvent", () => {
  it("returns true for matching evt_ ids", () => {
    expect(isSameWebhookEvent("evt_123", "evt_123")).toBe(true);
  });

  it("returns false when ids differ", () => {
    expect(isSameWebhookEvent("evt_123", "evt_456")).toBe(false);
  });

  it("returns false when ids do not start with evt_", () => {
    expect(isSameWebhookEvent("pi_123", "pi_123")).toBe(false);
  });
});

describe("isDedupeWindowExpired", () => {
  const base = new Date("2026-07-11T00:00:00Z");

  it("returns false within the window", () => {
    const receivedAt = new Date(base.getTime());
    const now = new Date(base.getTime() + STRIPE_EVENT_DEDUPE_WINDOW_MS - 1);
    expect(isDedupeWindowExpired(receivedAt, now)).toBe(false);
  });

  it("returns true after the window", () => {
    const receivedAt = new Date(base.getTime());
    const now = new Date(base.getTime() + STRIPE_EVENT_DEDUPE_WINDOW_MS + 1);
    expect(isDedupeWindowExpired(receivedAt, now)).toBe(true);
  });
});