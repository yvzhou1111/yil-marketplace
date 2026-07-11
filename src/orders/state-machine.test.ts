import { describe, expect, it } from "vitest";
import {
  ORDER_STATES,
  actionsAvailableFrom,
  canTransition,
  isPaymentDisputable,
  isReviewable,
  isTerminal,
  lookupRule,
  nextStates,
  parseOrderState,
  parseOrderTransitionActor,
  parseTransitionAction,
  validateTransition,
  type OrderForTransition,
  type OrderTransitionAction,
  type OrderTransitionActor,
} from "./state-machine";

const BUYER_ID = "11111111-1111-1111-1111-111111111111";
const SELLER_ID = "22222222-2222-2222-2222-222222222222";
const ADMIN_ID = "33333333-3333-3333-3333-333333333333";

function makeOrder(
  state: OrderForTransition["state"] = "initiated"
): OrderForTransition {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    state,
    buyerId: BUYER_ID,
    sellerId: SELLER_ID,
  };
}

describe("ORDER_STATES", () => {
  it("matches the YIL-14 contract", () => {
    expect(ORDER_STATES).toEqual([
      "initiated",
      "paid",
      "fulfilled",
      "completed",
      "disputed",
      "cancelled",
    ]);
  });
});

describe("parseOrderState", () => {
  it("accepts known states", () => {
    for (const s of ORDER_STATES) {
      expect(parseOrderState(s)).toBe(s);
    }
  });

  it("rejects unknown values", () => {
    expect(parseOrderState("shipped")).toBeNull();
    expect(parseOrderState("")).toBeNull();
    expect(parseOrderState(null)).toBeNull();
    expect(parseOrderState(42)).toBeNull();
    expect(parseOrderState({ state: "paid" })).toBeNull();
  });
});

describe("parseOrderTransitionActor", () => {
  it("accepts known roles", () => {
    const roles: OrderTransitionActor[] = [
      "buyer",
      "seller",
      "admin",
      "system",
    ];
    for (const r of roles) {
      expect(parseOrderTransitionActor(r)).toBe(r);
    }
  });

  it("rejects unknown roles", () => {
    expect(parseOrderTransitionActor("guest")).toBeNull();
    expect(parseOrderTransitionActor(undefined)).toBeNull();
  });
});

describe("parseTransitionAction", () => {
  it("accepts known actions", () => {
    const actions: OrderTransitionAction[] = [
      "pay",
      "fulfill",
      "complete",
      "open_dispute",
      "resolve_dispute_favor_buyer",
      "resolve_dispute_favor_seller",
      "cancel",
    ];
    for (const a of actions) {
      expect(parseTransitionAction(a)).toBe(a);
    }
  });

  it("rejects unknown actions", () => {
    expect(parseTransitionAction("ship")).toBeNull();
    expect(parseTransitionAction("")).toBeNull();
    expect(parseTransitionAction(0)).toBeNull();
  });
});

describe("canTransition", () => {
  it("allows the happy path", () => {
    expect(canTransition("initiated", "paid")).toBe(true);
    expect(canTransition("paid", "fulfilled")).toBe(true);
    expect(canTransition("fulfilled", "completed")).toBe(true);
  });

  it("allows the dispute path from multiple states", () => {
    expect(canTransition("paid", "disputed")).toBe(true);
    expect(canTransition("fulfilled", "disputed")).toBe(true);
    expect(canTransition("completed", "disputed")).toBe(true);
  });

  it("allows admin to resolve a dispute either way", () => {
    expect(canTransition("disputed", "completed")).toBe(true);
    expect(canTransition("disputed", "cancelled")).toBe(true);
  });

  it("rejects illegal edges", () => {
    expect(canTransition("initiated", "fulfilled")).toBe(false);
    expect(canTransition("paid", "completed")).toBe(false);
    expect(canTransition("cancelled", "paid")).toBe(false);
    expect(canTransition("completed", "paid")).toBe(false);
    expect(canTransition("completed", "fulfilled")).toBe(false);
  });

  it("does not allow transitions out of cancelled", () => {
    for (const target of ORDER_STATES) {
      expect(canTransition("cancelled", target)).toBe(false);
    }
  });
});

describe("nextStates", () => {
  it("returns the right set per state", () => {
    expect(nextStates("initiated")).toEqual(["paid", "cancelled"]);
    expect(nextStates("paid")).toEqual(["fulfilled", "disputed", "cancelled"]);
    expect(nextStates("fulfilled")).toEqual(["completed", "disputed"]);
    expect(nextStates("completed")).toEqual(["disputed"]);
    expect(nextStates("disputed")).toEqual(["completed", "cancelled"]);
    expect(nextStates("cancelled")).toEqual([]);
  });
});

describe("isTerminal", () => {
  it("only cancelled is terminal in the strict sense", () => {
    expect(isTerminal("cancelled")).toBe(true);
    // completed can be reopened via disputed (post-fulfilment dispute window).
    expect(isTerminal("completed")).toBe(false);
    expect(isTerminal("disputed")).toBe(false);
    expect(isTerminal("initiated")).toBe(false);
    expect(isTerminal("paid")).toBe(false);
    expect(isTerminal("fulfilled")).toBe(false);
  });
});

describe("isReviewable / isPaymentDisputable", () => {
  it("isReviewable is only true for completed", () => {
    for (const s of ORDER_STATES) {
      expect(isReviewable(s)).toBe(s === "completed");
    }
  });

  it("isPaymentDisputable is only true for paid", () => {
    for (const s of ORDER_STATES) {
      expect(isPaymentDisputable(s)).toBe(s === "paid");
    }
  });
});

describe("actionsAvailableFrom", () => {
  it("returns the right actions per source state", () => {
    expect(new Set(actionsAvailableFrom("initiated"))).toEqual(
      new Set(["pay", "cancel"])
    );
    expect(new Set(actionsAvailableFrom("paid"))).toEqual(
      new Set(["fulfill", "open_dispute", "cancel"])
    );
    expect(new Set(actionsAvailableFrom("fulfilled"))).toEqual(
      new Set(["complete", "open_dispute"])
    );
    expect(new Set(actionsAvailableFrom("completed"))).toEqual(
      new Set(["open_dispute"])
    );
    expect(new Set(actionsAvailableFrom("disputed"))).toEqual(
      new Set(["resolve_dispute_favor_buyer", "resolve_dispute_favor_seller"])
    );
    expect(actionsAvailableFrom("cancelled")).toEqual([]);
  });
});

describe("lookupRule", () => {
  it("finds cancel from both initiated and paid", () => {
    expect(lookupRule("cancel", "initiated")).not.toBeNull();
    expect(lookupRule("cancel", "paid")).not.toBeNull();
  });

  it("does not find cancel from fulfilled", () => {
    expect(lookupRule("cancel", "fulfilled")).toBeNull();
  });

  it("finds open_dispute from paid, fulfilled, and completed", () => {
    expect(lookupRule("open_dispute", "paid")).not.toBeNull();
    expect(lookupRule("open_dispute", "fulfilled")).not.toBeNull();
    expect(lookupRule("open_dispute", "completed")).not.toBeNull();
  });

  it("does not find open_dispute from initiated", () => {
    // An initiated order has no money in escrow yet; nothing to dispute.
    expect(lookupRule("open_dispute", "initiated")).toBeNull();
  });
});

describe("validateTransition — happy paths", () => {
  it("lets the buyer pay", () => {
    const r = validateTransition(
      makeOrder("initiated"),
      { role: "buyer", userId: BUYER_ID },
      "pay",
      null
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule.to).toBe("paid");
  });

  it("lets the system mark paid (Stripe webhook)", () => {
    const r = validateTransition(
      makeOrder("initiated"),
      { role: "system", userId: null },
      "pay",
      null
    );
    expect(r.ok).toBe(true);
  });

  it("lets the seller fulfill", () => {
    const r = validateTransition(
      makeOrder("paid"),
      { role: "seller", userId: SELLER_ID },
      "fulfill",
      "Shipped via UPS"
    );
    expect(r.ok).toBe(true);
  });

  it("lets the buyer confirm completion", () => {
    const r = validateTransition(
      makeOrder("fulfilled"),
      { role: "buyer", userId: BUYER_ID },
      "complete",
      null
    );
    expect(r.ok).toBe(true);
  });

  it("lets the system auto-complete", () => {
    const r = validateTransition(
      makeOrder("fulfilled"),
      { role: "system", userId: null },
      "complete",
      null
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateTransition — failures", () => {
  it("rejects an illegal edge", () => {
    const r = validateTransition(
      makeOrder("initiated"),
      { role: "buyer", userId: BUYER_ID },
      "fulfill",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("no_rule_for_action_from_state");
  });

  it("rejects the wrong role", () => {
    const r = validateTransition(
      makeOrder("initiated"),
      { role: "seller", userId: SELLER_ID },
      "pay",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.reason).toBe("wrong_role");
      if (r.failure.reason === "wrong_role") {
        expect(r.failure.actorRole).toBe("seller");
        expect(r.failure.allowed).toContain("buyer");
      }
    }
  });

  it("rejects a buyer who isn't a party to this order", () => {
    const strangerId = "99999999-9999-9999-9999-999999999999";
    const r = validateTransition(
      makeOrder("initiated"),
      { role: "buyer", userId: strangerId },
      "pay",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("not_a_party");
  });

  it("rejects a seller who isn't the seller on this order", () => {
    const strangerId = "99999999-9999-9999-9999-999999999999";
    const r = validateTransition(
      makeOrder("paid"),
      { role: "seller", userId: strangerId },
      "fulfill",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("not_a_party");
  });

  it("rejects a system actor with a userId", () => {
    const r = validateTransition(
      makeOrder("initiated"),
      { role: "system", userId: ADMIN_ID },
      "pay",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.reason).toBe("system_actor_requires_null_user_id");
    }
  });

  it("rejects a non-system actor without a userId", () => {
    const r = validateTransition(
      makeOrder("initiated"),
      { role: "buyer", userId: null },
      "pay",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.reason).toBe("non_system_actor_requires_user_id");
    }
  });

  it("rejects an open_dispute without a reason", () => {
    const r = validateTransition(
      makeOrder("paid"),
      { role: "buyer", userId: BUYER_ID },
      "open_dispute",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("missing_reason");
  });

  it("rejects an open_dispute with a whitespace-only reason", () => {
    const r = validateTransition(
      makeOrder("paid"),
      { role: "buyer", userId: BUYER_ID },
      "open_dispute",
      "   \t  "
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("missing_reason");
  });

  it("rejects an open_dispute with an empty string reason", () => {
    const r = validateTransition(
      makeOrder("paid"),
      { role: "buyer", userId: BUYER_ID },
      "open_dispute",
      ""
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("missing_reason");
  });
});

describe("validateTransition — disputes and admin resolution", () => {
  it("lets a buyer open a dispute on a paid order with a reason", () => {
    const r = validateTransition(
      makeOrder("paid"),
      { role: "buyer", userId: BUYER_ID },
      "open_dispute",
      "Item not as described"
    );
    expect(r.ok).toBe(true);
  });

  it("lets a seller open a dispute on a fulfilled order", () => {
    const r = validateTransition(
      makeOrder("fulfilled"),
      { role: "seller", userId: SELLER_ID },
      "open_dispute",
      "Buyer claims non-delivery, but tracking shows delivered"
    );
    expect(r.ok).toBe(true);
  });

  it("lets the admin resolve a dispute in the buyer's favor", () => {
    const r = validateTransition(
      makeOrder("disputed"),
      { role: "admin", userId: ADMIN_ID },
      "resolve_dispute_favor_buyer",
      "Photos confirm item matches description; release to seller"
    );
    expect(r.ok).toBe(true);
  });

  it("lets the admin resolve a dispute in the seller's favor (refund buyer)", () => {
    const r = validateTransition(
      makeOrder("disputed"),
      { role: "admin", userId: ADMIN_ID },
      "resolve_dispute_favor_seller",
      "Item clearly not as described; refunding buyer"
    );
    expect(r.ok).toBe(true);
  });

  it("does not let a buyer resolve their own dispute", () => {
    const r = validateTransition(
      makeOrder("disputed"),
      { role: "buyer", userId: BUYER_ID },
      "resolve_dispute_favor_buyer",
      "I want to withdraw"
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("wrong_role");
  });

  it("requires a reason for admin dispute resolution", () => {
    const r = validateTransition(
      makeOrder("disputed"),
      { role: "admin", userId: ADMIN_ID },
      "resolve_dispute_favor_buyer",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("missing_reason");
  });
});

describe("validateTransition — cancel paths", () => {
  it("lets the buyer cancel an initiated order", () => {
    const r = validateTransition(
      makeOrder("initiated"),
      { role: "buyer", userId: BUYER_ID },
      "cancel",
      null
    );
    expect(r.ok).toBe(true);
  });

  it("lets the admin cancel a paid order with a reason", () => {
    const r = validateTransition(
      makeOrder("paid"),
      { role: "admin", userId: ADMIN_ID },
      "cancel",
      "Fraud signal; refunding via Stripe"
    );
    expect(r.ok).toBe(true);
  });

  it("requires a reason when cancelling a paid order (refund path)", () => {
    const r = validateTransition(
      makeOrder("paid"),
      { role: "buyer", userId: BUYER_ID },
      "cancel",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("missing_reason");
  });

  it("does not allow cancelling a fulfilled order (must dispute or complete)", () => {
    const r = validateTransition(
      makeOrder("fulfilled"),
      { role: "buyer", userId: BUYER_ID },
      "cancel",
      null
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toBe("no_rule_for_action_from_state");
  });
});

describe("regression — complete graph snapshot", () => {
  it("matches the documented graph exactly", () => {
    // This snapshot is the contract. If it changes, ADR 0002 must change.
    const expected: Record<OrderForTransition["state"], ReadonlyArray<OrderForTransition["state"]>> = {
      initiated: ["paid", "cancelled"],
      paid: ["fulfilled", "disputed", "cancelled"],
      fulfilled: ["completed", "disputed"],
      completed: ["disputed"],
      disputed: ["completed", "cancelled"],
      cancelled: [],
    };
    for (const from of ORDER_STATES) {
      const targets = nextStates(from);
      const expectedTargets = expected[from];
      expect(new Set(targets)).toEqual(new Set(expectedTargets));
    }
  });
});