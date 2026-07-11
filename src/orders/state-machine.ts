/**
 * Order state machine — the single source of truth for legal transitions
 * and actor-role permissions on `orders.state`.
 *
 * This module is intentionally pure: no DB calls, no network, no Next.
 * It is exercised by:
 *
 *   - API routes that mutate `orders.state`  (yil-9 stripe webhooks,
 *     admin console, seller fulfilment UI).
 *   - The DB-layer guard in `db/migrations/0004_order_state_transitions.sql`,
 *     which mirrors the `TRANSITIONS` map below as a CHECK constraint on
 *     the audit table.
 *   - The reviews module (`src/reviews/state.ts`), which re-exports the
 *     `ORDER_STATES` enum and the `isReviewable` predicate so reviews
 *     don't reinvent the wheel.
 *
 * The five core states from YIL-14 are joined by a sixth terminal `cancelled`
 * state because the natural transition graph requires it: an `initiated`
 * order that the buyer abandons has nowhere to go otherwise, and a `paid`
 * order that the buyer decides to refund-without-fulfilment has no other
 * exit. The "happy path" is initiated → paid → fulfilled → completed; the
 * unhappy paths are cancelled (buyer / seller / admin withdraw or refund
 * before completion) and disputed (either party raises an issue, resolved
 * by admin into either completed or cancelled).
 *
 * --------------------------------------------------------------------------
 * The graph (use this as the canonical diagram):
 *
 *     initiated ──► paid ──► fulfilled ──► completed
 *         │    ╲      │  ╲       │             │
 *         │     ╲     │   ╲      │             │
 *         ▼      ▼    ▼    ╲     ▼             ▼
 *     cancelled  cancelled   disputed      disputed
 *                                 │
 *                                 ▼
 *                       completed | cancelled   (admin resolves)
 *
 * Actor-role permissions on each edge are encoded in
 * `TRANSITIONS[from].action -> { allowedRoles, ... }`.
 *
 * Note: `completed` is technically reopenable into `disputed` to support
 * the post-fulfilment dispute window; `disputed` is its only allowed exit,
 * and the exit goes back to admin for resolution. This is why `completed`
 * is *not* in the `TERMINAL_STATES` set even though the happy path ends
 * there — the data model can record a buyer who returns a week later and
 * claims non-delivery.
 * --------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/*  States                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The five core states from YIL-14 plus a sixth `cancelled` terminal state.
 * Order matters: it is the canonical iteration order for UI affordances
 * ("next state" dropdowns, progress bars, etc.).
 */
export const ORDER_STATES = [
  "initiated",
  "paid",
  "fulfilled",
  "completed",
  "disputed",
  "cancelled",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

/**
 * Coerces an arbitrary value to `OrderState` or returns null. Useful at API
 * boundaries where the value comes from JSON and we want to fail fast on
 * typos rather than rely on a downstream `===` comparison.
 */
export function parseOrderState(value: unknown): OrderState | null {
  return typeof value === "string" && (ORDER_STATES as readonly string[]).includes(value)
    ? (value as OrderState)
    : null;
}

/**
 * States with no outgoing edges under any actor. `completed` is excluded
 * from this set on purpose: it has an outgoing edge to `disputed` (the
 * post-fulfilment dispute window). The set is the source of truth for "is
 * this order done forever?".
 */
const TERMINAL_STATES: ReadonlySet<OrderState> = new Set([
  // `completed` is NOT terminal: it can transition to `disputed` for the
  // post-fulfilment dispute window.
  "cancelled",
]);

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.has(state);
}

/* -------------------------------------------------------------------------- */
/*  Edges                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The authoritative list of edges in the state machine. Mirrors the
 * `orders_status_transition_allowed` CHECK constraint in
 * `db/migrations/0003_order_state_transitions.sql` and the SQL CHECK in
 * `src/db/schema.ts` on `order_state_transitions`. If you change one,
 * change all three.
 */
const TRANSITIONS: Record<OrderState, ReadonlyArray<OrderState>> = {
  initiated: ["paid", "cancelled"],
  paid: ["fulfilled", "disputed", "cancelled"],
  fulfilled: ["completed", "disputed"],
  completed: ["disputed"],
  disputed: ["completed", "cancelled"],
  cancelled: [],
};

/** Pure: is this transition legal in the abstract state machine? */
export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Pure: which states can follow this one? Useful for UI affordances. */
export function nextStates(from: OrderState): ReadonlyArray<OrderState> {
  return TRANSITIONS[from];
}

/* -------------------------------------------------------------------------- */
/*  Actor roles                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Roles that can drive a transition. Mirrors the `order_transition_actor`
 * Postgres enum. `system` is for automated paths (Stripe webhooks,
 * auto-confirm timers, settlement jobs) — it has no associated user.
 */
export const ORDER_TRANSITION_ACTORS = [
  "buyer",
  "seller",
  "admin",
  "system",
] as const;

export type OrderTransitionActor = (typeof ORDER_TRANSITION_ACTORS)[number];

export function parseOrderTransitionActor(
  value: unknown
): OrderTransitionActor | null {
  return typeof value === "string" &&
    (ORDER_TRANSITION_ACTORS as readonly string[]).includes(value)
    ? (value as OrderTransitionActor)
    : null;
}

/* -------------------------------------------------------------------------- */
/*  Named actions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Each legal transition is exposed via a *named action* so the API can
 * carry intent instead of raw state pairs. This gives us a place to put
 * per-action validation (e.g. disputes require a reason and metadata)
 * without sprinkling conditionals across every route handler.
 *
 * `null` from `parseTransitionAction` means the action name is unknown;
 * route handlers should 400 on null.
 *
 * Some actions live on more than one edge (e.g. `cancel` covers both
 * initiated→cancelled and paid→cancelled). The validator picks the right
 * rule from `TRANSITION_RULES[action].from` automatically using the
 * order's current `state`.
 */
export const ORDER_TRANSITION_ACTIONS = [
  "pay", //          initiated → paid
  "fulfill", //      paid → fulfilled
  "complete", //     fulfilled → completed   (and disputed → completed is via resolve_dispute_favor_buyer)
  "open_dispute", // paid/fulfilled/completed → disputed
  "resolve_dispute_favor_buyer", //  disputed → completed
  "resolve_dispute_favor_seller", // disputed → cancelled
  "cancel", //       initiated/paid → cancelled
] as const;

export type OrderTransitionAction =
  (typeof ORDER_TRANSITION_ACTIONS)[number];

export function parseTransitionAction(
  value: unknown
): OrderTransitionAction | null {
  return typeof value === "string" &&
    (ORDER_TRANSITION_ACTIONS as readonly string[]).includes(value)
    ? (value as OrderTransitionAction)
    : null;
}

/**
 * The set of legal source states for an action. One entry per edge that
 * this action can fire. For example, `cancel` is listed twice because it
 * can fire from `initiated` and `paid`.
 */
export interface TransitionRule {
  readonly from: OrderState;
  readonly to: OrderState;
  /** Roles that may invoke this action. See also `validateTransition`. */
  readonly allowedRoles: ReadonlyArray<OrderTransitionActor>;
  /** When true, the caller must supply a non-empty `reason`. */
  readonly requiresReason: boolean;
  /** Documents the expected shape of the `metadata` jsonb field. */
  readonly metadataShape: string;
}

/**
 * All (action, from) pairs we know about. Looked up by
 * `lookupRule(action, fromState)` so the same action name with two
 * different source states (e.g. `cancel` from `initiated` vs from `paid`)
 * resolves to two distinct rules.
 */
const TRANSITION_RULES: ReadonlyArray<
  TransitionRule & { readonly action: OrderTransitionAction }
> = [
  // pay: initiated → paid
  {
    action: "pay",
    from: "initiated",
    to: "paid",
    allowedRoles: ["buyer", "system"],
    requiresReason: false,
    metadataShape:
      "{ stripe_payment_intent_id?: string, stripe_charge_id?: string }",
  },
  // fulfill: paid → fulfilled
  {
    action: "fulfill",
    from: "paid",
    to: "fulfilled",
    allowedRoles: ["seller", "system"],
    requiresReason: false,
    metadataShape:
      "{ carrier?: string, tracking_number?: string, shipped_at?: string }",
  },
  // complete: fulfilled → completed
  {
    action: "complete",
    from: "fulfilled",
    to: "completed",
    allowedRoles: ["buyer", "system", "admin"],
    requiresReason: false,
    metadataShape:
      "{ via: 'buyer_confirm' | 'auto_confirm' | 'admin_resolve' }",
  },
  // open_dispute: paid → disputed
  {
    action: "open_dispute",
    from: "paid",
    to: "disputed",
    allowedRoles: ["buyer", "seller"],
    requiresReason: true,
    metadataShape:
      "{ category: 'not_as_described' | 'not_received' | 'damaged' | 'other', evidence_url?: string }",
  },
  // open_dispute: fulfilled → disputed
  {
    action: "open_dispute",
    from: "fulfilled",
    to: "disputed",
    allowedRoles: ["buyer", "seller"],
    requiresReason: true,
    metadataShape:
      "{ category: 'not_as_described' | 'not_received' | 'damaged' | 'other', evidence_url?: string }",
  },
  // open_dispute: completed → disputed  (post-fulfilment dispute window)
  {
    action: "open_dispute",
    from: "completed",
    to: "disputed",
    allowedRoles: ["buyer", "seller"],
    requiresReason: true,
    metadataShape:
      "{ category: 'not_as_described' | 'not_received' | 'damaged' | 'other', evidence_url?: string }",
  },
  // resolve_dispute_favor_buyer: disputed → completed
  {
    action: "resolve_dispute_favor_buyer",
    from: "disputed",
    to: "completed",
    allowedRoles: ["admin"],
    requiresReason: true,
    metadataShape:
      "{ outcome_for_buyer: 'releases_to_seller', admin_note: string }",
  },
  // resolve_dispute_favor_seller: disputed → cancelled
  {
    action: "resolve_dispute_favor_seller",
    from: "disputed",
    to: "cancelled",
    allowedRoles: ["admin"],
    requiresReason: true,
    metadataShape:
      "{ outcome_for_seller: 'refunds_buyer', admin_note: string }",
  },
  // cancel: initiated → cancelled
  {
    action: "cancel",
    from: "initiated",
    to: "cancelled",
    allowedRoles: ["buyer", "seller", "admin", "system"],
    requiresReason: false,
    metadataShape:
      "{ cancelled_by_side: 'buyer' | 'seller' | 'admin' | 'system' }",
  },
  // cancel: paid → cancelled  (refund-without-fulfilment path; the refund
  // itself is owned by YIL-9, but the state advance is here).
  {
    action: "cancel",
    from: "paid",
    to: "cancelled",
    allowedRoles: ["buyer", "admin", "system"],
    requiresReason: true,
    metadataShape:
      "{ cancelled_by_side: 'buyer' | 'admin' | 'system', refund_intent_id?: string }",
  },
];

/**
 * Look up the rule for `(action, fromState)`. Returns null if no rule
 * applies — for example, asking for `complete` from `paid` has no rule
 * because the edge doesn't exist; or asking for `cancel` from `fulfilled`
 * also returns null because that edge isn't allowed (a `fulfilled` order
 * must be either `completed` or `disputed`).
 */
export function lookupRule(
  action: OrderTransitionAction,
  fromState: OrderState
): TransitionRule | null {
  for (const rule of TRANSITION_RULES) {
    if (rule.action === action && rule.from === fromState) {
      return rule;
    }
  }
  return null;
}

/**
 * Lookup: which named actions are legal *from* a given state? Useful for
 * UI affordances ("what can I do to this order right now?").
 */
export function actionsAvailableFrom(
  state: OrderState
): ReadonlyArray<OrderTransitionAction> {
  const set = new Set<OrderTransitionAction>();
  for (const rule of TRANSITION_RULES) {
    if (rule.from === state) set.add(rule.action);
  }
  return Array.from(set);
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Minimal shape of an `orders` row that the validator needs. We don't take
 * the full Drizzle type because:
 *   1. The validator should be usable from non-DB contexts (webhooks,
 *      tests, replay tools).
 *   2. Drizzle `$inferSelect` couples the public surface to the schema
 *      file's column order — a churn hazard.
 */
export interface OrderForTransition {
  id: string;
  state: OrderState;
  buyerId: string;
  sellerId: string;
}

/**
 * Identity of the caller attempting a transition. `role` is the *role on
 * this order*; `userId` is null for `system`. For an admin acting on
 * behalf of no party, `userId` is the admin's user id and `role` is
 * "admin".
 */
export interface TransitionActor {
  role: OrderTransitionActor;
  userId: string | null;
}

export type TransitionFailure =
  | { reason: "unknown_action" }
  | { reason: "no_rule_for_action_from_state"; action: OrderTransitionAction; from: OrderState }
  | { reason: "wrong_role"; action: OrderTransitionAction; actorRole: OrderTransitionActor; allowed: ReadonlyArray<OrderTransitionActor> }
  | { reason: "not_a_party"; action: OrderTransitionAction; actorRole: "buyer" | "seller" }
  | { reason: "missing_reason"; action: OrderTransitionAction }
  | { reason: "system_actor_requires_null_user_id" }
  | { reason: "non_system_actor_requires_user_id" };

export type TransitionValidationResult =
  | { ok: true; rule: TransitionRule }
  | { ok: false; failure: TransitionFailure };

/**
 * Validate a request to apply `action` to `order` from `actor`.
 *
 * This is the *only* place to write a guard for "can this user transition
 * this order to that state?". Every call site (API route, webhook handler,
 * admin console, replays) routes through here so we never accidentally
 * diverge from the state machine.
 *
 * It does NOT mutate the database — callers are responsible for executing
 * the transition inside a transaction that also writes the
 * `order_state_transitions` row.
 *
 * Steps:
 *   1. Look up the rule for (action, fromState=order.state). If absent,
 *      the edge isn't allowed at all — return a structured failure.
 *   2. Check role permission.
 *   3. Check role / user_id pairing (system ↔ null, others ↔ present).
 *   4. For buyer / seller, check they are a party to *this* order.
 *   5. Check the optional-but-required `reason` field.
 */
export function validateTransition(
  order: OrderForTransition,
  actor: TransitionActor,
  action: OrderTransitionAction,
  reason: string | null
): TransitionValidationResult {
  // 1. Edge lookup.
  const rule = lookupRule(action, order.state);
  if (rule === null) {
    return {
      ok: false,
      failure: {
        reason: "no_rule_for_action_from_state",
        action,
        from: order.state,
      },
    };
  }

  // 2. Role permission.
  if (!rule.allowedRoles.includes(actor.role)) {
    return {
      ok: false,
      failure: {
        reason: "wrong_role",
        action,
        actorRole: actor.role,
        allowed: rule.allowedRoles,
      },
    };
  }

  // 3. Role/user_id pairing.
  if (actor.role === "system") {
    if (actor.userId !== null) {
      return {
        ok: false,
        failure: { reason: "system_actor_requires_null_user_id" },
      };
    }
  } else if (actor.userId === null) {
    return {
      ok: false,
      failure: { reason: "non_system_actor_requires_user_id" },
    };
  }

  // 4. Party check for order-side actors.
  if (actor.role === "buyer" || actor.role === "seller") {
    const expected =
      actor.role === "buyer" ? order.buyerId : order.sellerId;
    if (actor.userId !== expected) {
      return {
        ok: false,
        failure: {
          reason: "not_a_party",
          action,
          actorRole: actor.role,
        },
      };
    }
  }

  // 5. Required-reason check. Trim so whitespace-only strings don't smuggle
  // empty reasons past the guard.
  if (rule.requiresReason) {
    if (reason === null || reason.trim() === "") {
      return {
        ok: false,
        failure: { reason: "missing_reason", action },
      };
    }
  }

  return { ok: true, rule };
}

/* -------------------------------------------------------------------------- */
/*  Review / dispute eligibility                                              */
/* -------------------------------------------------------------------------- */

/**
 * Pure: is this order in a state where reviews can be written?
 * Lives here (not in reviews/state.ts) so the order state machine is the
 * single source of truth. `src/reviews/state.ts` re-exports this for
 * convenience.
 */
export function isReviewable(state: OrderState): boolean {
  return state === "completed";
}

/**
 * Pure: is this order in a state where the buyer can open a payment-side
 * dispute through the platform's own flow? We allow `paid` because once
 * the seller has shipped (`fulfilled`), the buyer's recourse is to either
 * confirm receipt or to open a platform dispute, not to push a duplicate
 * payment dispute.
 */
export function isPaymentDisputable(state: OrderState): boolean {
  return state === "paid";
}
