# ADR 0002 — Two-sided reviews and abuse moderation

- **Status:** Accepted
- **Date:** 2026-07-11
- **Issue:** YIL-10 (Week 3.3: Reviews and ratings)
- **Author:** founding-engineer
- **Deciders:** founding-engineer, board (YIL-1)
- **Supersedes:** —

## Context

The marketplace lets buyers and sellers transact. Once a transaction reaches
`completed`, both sides need a way to leave a public, durable evaluation of
the other party. The system also needs a way to surface and act on reviews
that violate policy (spam, harassment, doxxing, threats, etc.).

Requirements from the issue:

- **Two-sided.** Both parties can review the other.
- **Gated on `completed` state.** Reviews cannot be written on
  `initiated`, `paid`, `fulfilled`, `disputed`, or `cancelled` orders.
- **Moderation flag for abuse.** Anyone (signed in) can flag a review.
  The platform hides and audits as needed.

Non-goals for this issue (kept narrow to ship something auditable):

- Photo attachments in reviews.
- Seller response / public replies.
- Disputed-order resolution flow (YIL-14 owns the dispute lifecycle).
- Reporting the *seller* of a listing (separate moderation surface in
  YIL-11 — admin console).
- A user-facing "report this user" path; abuse is reported per review.

## Decision

### 1. Two-sided, gated on `completed`

- An `orders` table holds the lifecycle: `initiated → paid → fulfilled →
  completed`, with side branches to `disputed` and `cancelled`. The state
  machine lives in `src/reviews/state.ts`; the SQL `order_state` enum and
  the `orders` table are in migration `0002_reviews.sql`.
- Reviews require the order's state to be `completed`. Earlier states
  don't allow reviews by design — a buyer who paid but never received the
  item cannot retaliate in public before resolution.
- `disputed` orders also block reviews. While a dispute is open, the
  system stays neutral.

### 2. One review per side per order

- `reviews` has a unique index on `(order_id, role)` where `role` is
  `buyer | seller`. The buyer writes one review of the seller; the seller
  writes one review of the buyer. No revision, no second chance; the
  unique constraint surfaces double-submissions as `already_reviewed`
  rather than silently dropping them.
- `role` is the **reviewer's** POV. `role = 'buyer'` means the buyer is
  reviewing the seller. `role = 'seller'` means the seller is reviewing
  the buyer. We never allow a reviewer to pick a role that doesn't match
  their side of the order — see `checkReviewEligibility` in
  `src/reviews/state.ts`.
- A reviewer cannot write both sides of an order. Even on a single order
  they have exactly one role, exactly one allowed review.

### 3. Two distinct tables: `review_flags` and `review_moderation_actions`

We separate **reports** from **decisions**:

- `review_flags` is what users create. It is keyed `(review_id, reporter_id)`
  so duplicate reports from the same user merge into one row. It is
  append-only — reporters do not see each other.
- `review_moderation_actions` is what admins create. It is append-only
  and tells the truth about *who decided what, and when*. The admin
  console reads this for "why was this review removed".
- Reviews are soft-hidden via `hidden_at` + `hidden_reason` rather than
  deleted, so the audit trail stays intact and a moderator can restore.

We never write a report into the moderation audit log. The two are
distinct audit trails because they answer different questions: "what did
users see and report?" vs. "what did the platform decide?"

### 4. Auto-hide threshold

If a review receives `>= 3` open flags from distinct users, the system
auto-hides it. The choice is:

| Threshold | Behaviour |
|---|---|
| 1 | One grudge-report hides any review. Too easy to abuse. |
| 3 | A handful of independent users flagging is a strong signal; cost of false positive is "moderator clicks restore". |
| 5+ | Lets a small pile-on survive longer than necessary at MVP. |

We pick **3** because at MVP we expect low traffic; we want the first
abusive reviews to be quarantined quickly, and the false-positive cost is
just a hidden review (a moderator can `restore` in one click). The
threshold is centralised in `AUTO_HIDE_FLAG_THRESHOLD` so we can raise
it later without a migration.

Hidden reviews are excluded from the public aggregate so a moderator-
hidden review never poisons a seller's average. The aggregate still
counts them in `total` / `hidden` for moderators.

### 5. Rate-limit abuse-flag spam (out of scope for code, in scope for ops)

We do **not** ship per-user flag-rate limiting in this issue. Rationale:

- We already deduplicate flags via the unique index on
  `(review_id, reporter_id)`.
- Auto-hide at 3 distinct reporters already short-circuits abuse piles.
- Adding a counter + window in this PR would duplicate the rate-limit
  primitive we'll want globally. We track it on the radar for YIL-12
  (Observability) so it lives next to the rest of our rate-limit policy.

### 6. Schema migrations

Migration `0002_reviews.sql` adds:

- `order_state`, `review_role`, `review_flag_reason` enums
- `orders`, `reviews`, `review_flags`, `review_moderation_actions` tables
- Indexes for the hot read paths (list reviews about a user, list open
  flags on a review)
- `updated_at` triggers for `orders` and `reviews`
- Two SQL helpers: `reviews_aggregate_for_user` and
  `review_open_flag_count`

Migration is idempotent: every `CREATE` uses `IF NOT EXISTS`, every
trigger is `DROP TRIGGER IF EXISTS … CREATE TRIGGER …`.

## Consequences

**Positive**

- Reviews are guaranteed to be about real, completed transactions. The
  `orders` lifecycle prevents reviews from being weaponised during a
  dispute.
- Moderation is split into a *reports* table (user input) and a
  *decisions* table (admin output), keeping the audit trail honest.
- Auto-hide at 3 flags short-circuits abuse before a human has to be
  awake. Moderator actions stay trivial: click `restore` if it was a
  false positive.
- Hidden reviews don't poison public averages. The seller's profile
  page only shows reviews that survive moderation.

**Negative / risks**

- The "disputed" state blocks reviews entirely. If a buyer and seller
  resolve a dispute amicably, neither side ever gets to leave a
  positive review. Acceptable for MVP — operators can transition a
  disputed order to `completed` if appropriate.
- Auto-hide threshold is fixed at 3. If we ship into a region where
  coordinated flagging is a thing (politically adjacent listings), we
  may need to raise it. Constant is centralised, change is one-line.
- We don't dedupe near-duplicate reports (e.g. "spam" + "off_topic"
  from the same user). The unique index already enforces one row per
  `(review, reporter)`; the `reason` is whatever the reporter picks
  first. Acceptable for MVP.

## Escape hatch

When any of these becomes true, we revisit:

- Median open-flag count per flagged review > 5 → raise
  `AUTO_HIDE_FLAG_THRESHOLD`.
- Disputed-order reviews matter to retention → add `dispute_resolved →
  completed` transition and allow reviews on resolved orders.
- Coordinated brigading on a seller → add per-user flag rate-limit and
  per-seller flag accumulation rules.

## Appendix A — schema

See `db/migrations/0002_reviews.sql` and `src/db/schema.ts`.

## Appendix B — API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/orders/:id/reviews` | buyer or seller of the order | Submit a review for a completed order |
| GET | `/api/orders/:id/reviews` | public | List visible reviews for an order |
| GET | `/api/users/:id/reviews` | public | List visible reviews about a user + aggregate |
| POST | `/api/reviews/:id/flag` | signed in | Flag a review for moderation |
| POST | `/api/admin/reviews/:id/moderate` | admin | Hide / restore / dismiss |
| GET | `/api/admin/review-flags` | admin | Review-flag queue |

## Appendix C — what we are explicitly NOT doing

- No public replies / seller-response on reviews.
- No photo or attachment upload in reviews.
- No anonymous reviews (we always know who wrote what).
- No review-vote-helpful counter (YAGNI at MVP).
- No per-listing review (we attach reviews to orders, not listings —
  the listing is a separate concept that can be re-listed).
- No automatic dispute resolution. Disputes stay disputes.
- No machine-learning moderation. Threshold + human moderation only.