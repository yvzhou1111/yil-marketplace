import { describe, it, expect } from "vitest";
import {
  listingDraftInput,
  listingPatchInput,
  validatePublishable,
} from "./validation";

const validInput = {
  title: "Walnut side table",
  description: "Solid walnut, mid-century.",
  amountCents: 24500,
  currency: "USD",
  location: "Brooklyn, NY",
};

describe("listingDraftInput", () => {
  it("accepts a well-formed payload", () => {
    const r = listingDraftInput.safeParse(validInput);
    expect(r.success).toBe(true);
  });

  it("uppercases currency", () => {
    const r = listingDraftInput.safeParse({ ...validInput, currency: "usd" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.currency).toBe("USD");
  });

  it("rejects empty title", () => {
    const r = listingDraftInput.safeParse({ ...validInput, title: "" });
    expect(r.success).toBe(false);
  });

  it("rejects title shorter than 3 chars", () => {
    const r = listingDraftInput.safeParse({ ...validInput, title: "ab" });
    expect(r.success).toBe(false);
  });

  it("rejects title longer than 140 chars", () => {
    const r = listingDraftInput.safeParse({
      ...validInput,
      title: "x".repeat(141),
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative amount", () => {
    const r = listingDraftInput.safeParse({
      ...validInput,
      amountCents: -1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-integer amount", () => {
    const r = listingDraftInput.safeParse({
      ...validInput,
      amountCents: 1.5,
    });
    expect(r.success).toBe(false);
  });

  it("accepts zero amount (free pickup)", () => {
    const r = listingDraftInput.safeParse({
      ...validInput,
      amountCents: 0,
    });
    expect(r.success).toBe(true);
  });

  it("rejects bad currency", () => {
    const r = listingDraftInput.safeParse({
      ...validInput,
      currency: "dollars",
    });
    expect(r.success).toBe(false);
  });

  it("rejects currency that's not 3 letters", () => {
    const r = listingDraftInput.safeParse({
      ...validInput,
      currency: "USDD",
    });
    expect(r.success).toBe(false);
  });

  it("defaults description and location when omitted", () => {
    const r = listingDraftInput.safeParse({
      title: validInput.title,
      amountCents: validInput.amountCents,
      currency: validInput.currency,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.description).toBe("");
      expect(r.data.location).toBe("");
    }
  });
});

describe("listingPatchInput", () => {
  it("accepts an empty patch (no-op)", () => {
    const r = listingPatchInput.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts a partial title-only patch", () => {
    const r = listingPatchInput.safeParse({ title: "Renamed" });
    expect(r.success).toBe(true);
  });

  it("refuses status changes other than archived", () => {
    const r = listingPatchInput.safeParse({ status: "published" });
    expect(r.success).toBe(false);
  });

  it("allows transitioning to archived via PATCH", () => {
    const r = listingPatchInput.safeParse({ status: "archived" });
    expect(r.success).toBe(true);
  });
});

describe("validatePublishable", () => {
  it("accepts a complete listing", () => {
    expect(
      validatePublishable({
        title: "Walnut table",
        amountCents: 100,
        imageCount: 1,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects an empty title", () => {
    const r = validatePublishable({
      title: "ab",
      amountCents: 100,
      imageCount: 1,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects zero images", () => {
    const r = validatePublishable({
      title: "Walnut table",
      amountCents: 100,
      imageCount: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/image/);
  });

  it("rejects negative price", () => {
    const r = validatePublishable({
      title: "Walnut table",
      amountCents: -1,
      imageCount: 1,
    });
    expect(r.ok).toBe(false);
  });
});