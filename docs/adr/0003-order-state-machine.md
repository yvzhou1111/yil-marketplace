# ADR 0003 — Order state machine and audit log

- **Status:** Accepted
- **Date:** 2026-07-11
- **Issue:** YIL-14 (Week 3.1: Transactions schema and state machine)
- **Author:** founding-engineer
- **Deciders:** founding-engineer, board (YIL-1)

## Context

A marketplace needs an unambiguous lifecycle for transactions: when does
money move, when can a review be left, when can a dispute be opened, who
can resolve it. We are at week 3 with the data model in place but
without any write path or guard rails on `orders.state`.

The five states listed in YIL-14 — `initiated`, `paid`, `fulfilled`,
`completed`, `disputed` — map to the lifecycle of a real transaction,
but no model is usable without (1) a way to terminate an order that the
buyer abandons and (2) a guard that says *"this transition is not
allowed"*. Both must hold in code *and* in the database: in code because
that's where most calls originate, in the database because that's the
last line of defense against a buggy migration or a malicious raw-SQL
maintenance script.

We also need an audit trail. Two reasons:

1. **Legal / finance.** A marketplace that holds escrowed money has to
   be able to answer *"who moved $X from paid to refunded at time T
   and why?"* — for chargeback defense, for regulator inquiries, for
   operator debugging.
2. **Product.** Disputes are intrinsically a "story of what happened":
   the buyer paid, the seller shipped, the buyer said the item was
   not as described, the admin reviewed the photos. That story lives
   in the audit log, not in the row.

## Decision

### 1. Six states, not five

`initiated`, `paid`, `fulfilled`, `completed`, `disputed`, **`cancelled`**.

`cancelled` is a sixth state beyond YIL-14's five. The natural
transition graph requires it: an `initiated` order that the buyer
abandons has nowhere to go otherwise, and a `paid` order that the buyer
decides to refund-without-fulfilment has no other exit. Refunding-as-
state-change (rather than refunding-without-state-change) means a `paid`
order that the buyer abandons doesn't sit in escrow forever; the state
machine can answer *"where did this money go?"* with confidence.

`refunded` is intentionally **not** added yet. A refund is a Stripe
operation that lives in YIL-9 — when that lands we may discover the
shape needs to be different (partial refunds, multi-leg refunds). We
treat `cancelled` as a generic "no further obligations" state and let
YIL-9 decide whether to split out `refunded` later.

The graph (canonical, copy this into code review):

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

### 2. Two-layer guard: app + DB

We defend-in-depth. The application validates transitions in pure
TypeScript (`src/orders/state-machine.ts`) so a typo in a route handler
returns a structured failure immediately. The database enforces the
same rules via a `CHECK` constraint on the audit table and a `BEFORE
UPDATE` trigger on the orders table, so any path that bypasses the app
(e.g. a one-off SQL fix in prod) still fails closed.

Why two layers rather than one:

- The app guard gives *typed, structured errors* that route handlers
  can render. The DB trigger can only raise a generic SQLSTATE.
- The DB guard ensures no future feature branch can opt out of the
  invariant by mistake. Migrations run by a contractor, ad-hoc DBA
  scripts, or a different language's ad-hoc query — they all fail.

### 3. Append-only audit, never update in place

`order_state_transitions` is a log, not a row. Insertions only. No
`updated_at`, no `deleted_at`. If a row is wrong we write a counter-row.
This keeps the log hashable for compliance purposes and makes
"reconstruct the state at any point in time" cheap.

Every audit row carries:

- `from_state`, `to_state` — DB-level CHECK enforces the pair is legal
- `actor_role` — `buyer` / `seller` / `admin` / `system`
- `actor_user_id` — nullable only for `system`
- `reason` — free-form, capped at 500 chars
- `metadata` — jsonb, transition-specific (Stripe ids, tracking numbers,
  evidence urls, admin notes)
- `created_at` — set by `DEFAULT now()` on insert

### 4. Named actions over raw (from, to) pairs

API requests carry an *action name* (`pay`, `fulfill`, `complete`,
`open_dispute`, `resolve_dispute_favor_buyer`,
`resolve_dispute_favor_seller`, `cancel`) rather than raw state pairs.
Reasons:

- Per-action rules can express intent:
  `open_dispute` requires a non-empty reason; `pay` does not.
- Logs read better: `('paid', 'fulfilled', 'admin', ...)` says less
  than `('fulfilled', null, 'admin', 'Shipped via UPS')`.
- The action name is stable across minor refactors of the state graph.

Same action can fire on multiple edges (e.g. `cancel` covers both
`initiated → cancelled` and `paid → cancelled`). The validator picks
the right rule from the order's current `state`.

### 5. State timestamps on the orders row

`paid_at`, `fulfilled_at`, `completed_at`, `disputed_at`, `cancelled_at`
are denormalized columns on `orders`. They are populated by a trigger
on `UPDATE orders SET state = ...`. Operational queries
("average time to fulfillment") don't have to walk the audit table.
The audit table remains the authoritative source for *who* and *why*;
the orders row only carries *when*.

A CHECK constraint enforces that "state in {X, Y, ...} ⇒ timestamp_X
is set", but the reverse (timestamp set but state not yet advanced) is
allowed so the trigger can do its job in a single statement.

## Alternatives considered

**Single layer (app-only).** Rejected: no defense against raw SQL or
replication edge cases. A DBA fixing a stuck order should not have
unchecked power to put it in an illegal state.

**One transition table per state.** Rejected: `paid_at`, `fulfilled_at`,
etc. on the orders row are cheaper to query than walking a generic log.

**Update in place rather than append-only.** Rejected: the log is
hashable for compliance; update-in-place loses the "what was the state
at T" property.

**Embedding action name in metadata rather than a column.** Rejected:
the action name is the *primary* verb of the audit row. Burying it in
metadata makes "show me all disputes ever opened" require a JSON
query.

**Using an ORM-managed `pgEnum` rather than hand-written SQL.** The
schema file *does* declare an ORM-managed enum; the migration file
mirrors it because hand-written migrations are easier to review and
evolve than generated ones. Drizzle generates a SQL with the same
content; we keep both because they target different review audiences.

## Consequences

**Positive**

- One state machine, one source of truth, three synchronised
  representations: TypeScript graph, SQL CHECK, migration audit
  checklist.
- Every transition has a reason and an actor; ops can answer "why did
  this order move?" with a single query.
- New edges can be added in three places (schema, state-machine,
  migration) and the test suite catches a drift via the
  regression-snapshot test.

**Negative / risks**

- The `(from_state, to_state)` whitelist is duplicated three times.
  Drift is the primary risk: a future engineer changes one and
  forgets the others. We mitigate with a Vitest snapshot
  (`validateTransition — regression — complete graph snapshot`).
- The DB trigger rejects `UPDATE orders SET state = ...` paths that
  try to skip states. Application code that wants to "automatically
  advance" must use the transitions log, not raw `SET state` — which
  is the right thing, but it does add one extra step the caller has
  to remember. We will codify this in a forthcoming
  `src/orders/service.ts` that wraps the two statements in a
  transaction.
- `metadata` jsonb is intentionally opaque. If we ever add a real
  column, we'd be tempted to soft-migrate instead of hard-cut. We
  accept that and version via field naming (`metadata.v2`).

## Appendix A — file map

- `src/db/schema.ts` — Drizzle definition (mirror of the SQL)
- `src/orders/state-machine.ts` — Pure TS state machine + validator
- `src/orders/state-machine.test.ts` — Vitest, including the graph
  snapshot
- `src/reviews/state.ts` — Re-exports for the reviews module
- `db/migrations/0003_order_state_transitions.sql` — Audit table,
  state-timestamp columns, DB-level guard trigger
- `docs/architecture/transactions.md` — Short reference for the rest of
  the team
