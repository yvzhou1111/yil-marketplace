# Transactions (YIL-14)

This document is the short reference for the order state machine. If you
are working on payments (YIL-9), the reviews module (YIL-10), or the
admin console (YIL-11), this is the file you want open.

## The graph

```
initiated ──► paid ──► fulfilled ──► completed
    │  ╲        │  ╲       │             │
    │   ╲       │   ╲      │             │
    ▼    ▼      ▼    ╲     ▼             ▼
cancelled  cancelled   disputed      disputed
                              │
                              ▼
                    completed | cancelled   (admin resolves)
```

- **initiated** — buyer clicked checkout, money not yet captured
- **paid** — Stripe `payment_intent.succeeded` webhook fired
- **fulfilled** — seller shipped (or, for digital goods, marked fulfilled)
- **completed** — buyer confirmed receipt, or auto-confirm timer fired
- **disputed** — either party raised a dispute; pending admin resolution
- **cancelled** — terminal "no further obligations" state (left in for
  initiated/paid cancel paths and admin dispute resolution)

`completed` is not terminal in the strict sense: it can be reopened to
`disputed` for the post-fulfilment dispute window. `cancelled` is the
only true terminal.

## Transitions and actor permissions

| Action | From → To | Allowed roles | Reason required? |
|---|---|---|---|
| `pay` | `initiated → paid` | `buyer`, `system` | no |
| `fulfill` | `paid → fulfilled` | `seller`, `system` | no |
| `complete` | `fulfilled → completed` | `buyer`, `system`, `admin` | no |
| `open_dispute` | `paid` / `fulfilled` / `completed` → `disputed` | `buyer`, `seller` | **yes** |
| `resolve_dispute_favor_buyer` | `disputed → completed` | `admin` | **yes** |
| `resolve_dispute_favor_seller` | `disputed → cancelled` | `admin` | **yes** |
| `cancel` | `initiated → cancelled` | `buyer`, `seller`, `admin`, `system` | no |
| `cancel` | `paid → cancelled` | `buyer`, `admin`, `system` | **yes** |

Read this table as: **what you may do depends on who you are**. Admins
can close a `paid` order via `cancel` (with a reason) or via the
dispute path (with two reasons). The buyer / seller can only touch
their own side of the order.

## Files

| Path | Purpose |
|---|---|
| `src/db/schema.ts` | Drizzle model (`orders`, `order_state_transitions`, `order_state`, `order_transition_actor`) |
| `src/orders/state-machine.ts` | Pure TS machine + `validateTransition` |
| `src/orders/state-machine.test.ts` | Vitest suite, including the graph snapshot |
| `src/reviews/state.ts` | Re-exports `ORDER_STATES`, `OrderState`, `canTransition`, `nextStates`, `isReviewable` |
| `db/migrations/0003_order_state_transitions.sql` | Audit table, state timestamps, DB-level guard |
| `docs/adr/0003-order-state-machine.md` | The decision record |

## How to write a new transition

Pattern for a route handler that mutates `orders.state`:

```ts
import { validateTransition } from "@/orders/state-machine";

export async function POST(req: Request) {
  const order = await loadOrder(id);
  const actor = await loadActorFromSession(req);

  const check = validateTransition(
    { id: order.id, state: order.state, buyerId: order.buyerId, sellerId: order.sellerId },
    { role: actor.role, userId: actor.userId },
    "open_dispute",
    body.reason ?? null,
  );

  if (!check.ok) {
    return Response.json({ error: "transition_rejected", detail: check.failure }, { status: 409 });
  }

  await db.transaction(async (tx) => {
    await tx.update(orders).set({ state: "disputed" }).where(eq(orders.id, order.id));
    await tx.insert(orderStateTransitions).values({
      orderId: order.id,
      fromState: order.state,
      toState: "disputed",
      actorUserId: actor.userId,
      actorRole: actor.role,
      reason: body.reason,
      metadata: body.metadata ?? {},
    });
  });

  return Response.json({ ok: true });
}
```

The two statements (`UPDATE orders`, `INSERT order_state_transitions`)
*must* run in the same transaction. The DB-level CHECK constraint on
the audit table rejects the insert if `(from_state, to_state)` is not in
the allow-list; the BEFORE UPDATE trigger on `orders.state` rejects the
update if the same pair isn't allowed. Both layers say no to illegal
moves, so the two writes stay in lock-step.

## What this module does NOT do

- **Payments.** Stripe integration (intents, webhooks, refunds) is YIL-9.
  This module knows how to *record* that a payment happened; it does
  not capture the money. The metadata field on the `paid` transition
  is where the PaymentIntent id lands.
- **Reviews.** YIL-10. A review can only be created when the order is
  `completed`; the eligibility check lives in `isReviewable`.
- **Dispute evidence UI.** The schema records evidence URLs in
  `metadata`; how the buyer / seller upload / view them is in the
  admin console (YIL-11).
- **Auto-confirm timer.** A worker that fires `complete` after 14 days
  of `fulfilled` will live in the worker module (TBD). It calls
  `validateTransition` with `role: "system", userId: null`.
