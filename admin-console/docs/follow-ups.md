# Admin Console Follow-ups (deferred from YIL-11)

This document tracks the cuts made to keep the YIL-11 deliverable minimal but
functional. Each item is concrete enough to pick up as a follow-up issue.

## Deferred items

1. **Real authentication.** `requireAdmin()` trusts an `x-admin-email` header.
   Wire this into the shared auth middleware from YIL-4 once that lands. The
   surface area to replace is a single function in `src/lib/db.ts`.

2. **Bulk moderation.** Selecting N pending listings and approving them in one
   POST. Requires a `POST /api/listings/bulk` route that takes
   `{ ids: string[], action: 'approve'|'reject'|'remove' }` and writes the
   audit log per-id inside a single transaction. Cheap to add once the
   moderation queue gets a checkbox column.

3. **Search via Postgres trigram / FTS.** Current search is `ilike '%q%'`.
   Acceptable at soft-launch volume, but a `pg_trgm` GIN index on
   `listings.title` would be needed once we cross ~10k listings.

4. **Webhook-driven snapshot refresh.** Today, metrics snapshot is refreshed
   after every moderation event in-process. That misses external mutations
   (e.g. a seller edit via the public app). A LISTEN/NOTIFY channel from the
   listings table would close the gap. Owned by YIL-12 (observability).

5. **Reject reason input.** Buttons today reject without prompting for a
   reason. A modal or inline textarea attached to the row would let admins
   record why — and let us expose rejection reasons to sellers in a later
   iteration.

6. **User impersonation / "view as"** so on-call can reproduce what a buyer
   sees. Required for YIL-12 (on-call runbook). Not in scope for YIL-11.

## Out of scope entirely

- Editing listings through the admin console. Sellers own their listings;
  admins only moderate. If we ever need admin-edits, that is a separate
  authority model with its own audit trail.
- A public-facing version of any of this. Everything here assumes an internal
  admin network position.