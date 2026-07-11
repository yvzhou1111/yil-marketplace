import { describe, it, expect } from "vitest";
import {
  applySellerAction,
  EDITABLE_FIELDS,
  type ListingStatus,
} from "./state";

describe("listing state machine", () => {
  describe("publish", () => {
    it("draft → published", () => {
      const r = applySellerAction("draft", { type: "publish" });
      expect(r).toEqual({ ok: true, next: "published" });
    });

    it("refuses to publish from published", () => {
      const r = applySellerAction("published", { type: "publish" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/only "draft"/);
    });

    it("refuses to publish from archived", () => {
      const r = applySellerAction("archived", { type: "publish" });
      expect(r.ok).toBe(false);
    });

    it("refuses to publish from sold (terminal)", () => {
      const r = applySellerAction("sold", { type: "publish" });
      expect(r.ok).toBe(false);
    });
  });

  describe("unpublish", () => {
    it("published → draft", () => {
      const r = applySellerAction("published", { type: "unpublish" });
      expect(r).toEqual({ ok: true, next: "draft" });
    });

    it("refuses from draft", () => {
      const r = applySellerAction("draft", { type: "unpublish" });
      expect(r.ok).toBe(false);
    });
  });

  describe("archive", () => {
    it.each<[ListingStatus]>([["draft"], ["published"]])(
      "archives from %s",
      (from) => {
        const r = applySellerAction(from, { type: "archive" });
        expect(r).toEqual({ ok: true, next: "archived" });
      },
    );

    it("refuses to archive sold (terminal)", () => {
      const r = applySellerAction("sold", { type: "archive" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/sold/);
    });

    it("refuses to archive an already-archived listing", () => {
      const r = applySellerAction("archived", { type: "archive" });
      expect(r.ok).toBe(false);
    });
  });

  it("covers every legal/illegal transition through the action matrix", () => {
    const states: ListingStatus[] = ["draft", "published", "sold", "archived"];
    const actions = ["publish", "unpublish", "archive"] as const;

    for (const s of states) {
      for (const a of actions) {
        const r = applySellerAction(s, { type: a });
        // We're not asserting specific outcomes here — this is a smoke
        // check that the function exhaustively handles every (state,
        // action) pair without throwing and never returns next === s.
        expect(typeof r.ok).toBe("boolean");
        if (r.ok) expect(r.next).not.toBe(s);
      }
    }
  });
});

describe("EDITABLE_FIELDS", () => {
  it("does not include sellerId", () => {
    expect(EDITABLE_FIELDS).not.toContain("sellerId");
  });

  it("does not include id", () => {
    expect(EDITABLE_FIELDS).not.toContain("id");
  });

  it("does not include createdAt/updatedAt", () => {
    expect(EDITABLE_FIELDS).not.toContain("createdAt");
    expect(EDITABLE_FIELDS).not.toContain("updatedAt");
  });

  it("includes the canonical content fields", () => {
    expect(EDITABLE_FIELDS).toEqual(
      expect.arrayContaining([
        "title",
        "description",
        "amountCents",
        "currency",
        "location",
        "status",
      ]),
    );
  });
});