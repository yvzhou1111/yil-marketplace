// Shared moderation logic. Single source of truth for state transitions so the
// listing detail page, the listings table actions, and any future bulk tools
// all converge on the same rules.
import { pool, withClient } from './db';

export type ModerationAction = 'approve' | 'reject' | 'unreject' | 'remove';

export type ModerationResult =
  | { ok: true; listingId: string; newStatus: string }
  | { ok: false; error: string; statusCode: number };

const TERMINAL_STATES = new Set(['removed']);

export async function applyModeration(opts: {
  listingId: string;
  action: ModerationAction;
  actor: { id: string; email: string };
  reason?: string;
}): Promise<ModerationResult> {
  const { listingId, action, actor, reason } = opts;

  return withClient(async (client) => {
    await client.query('begin');
    try {
      const cur = await client.query<{ status: string }>(
        'select status from public.listings where id = $1 for update',
        [listingId],
      );
      if (cur.rowCount === 0) {
        await client.query('rollback');
        return { ok: false, error: 'listing not found', statusCode: 404 };
      }

      const fromStatus = cur.rows[0].status;
      if (TERMINAL_STATES.has(fromStatus) && action !== 'remove') {
        await client.query('rollback');
        return {
          ok: false,
          error: `cannot ${action} a ${fromStatus} listing`,
          statusCode: 409,
        };
      }

      const targetStatus = computeTargetStatus(fromStatus, action);
      if (!targetStatus) {
        await client.query('rollback');
        return {
          ok: false,
          error: `action "${action}" is not allowed from "${fromStatus}"`,
          statusCode: 409,
        };
      }

      await client.query(
        `update public.listings
         set status = $2, updated_at = now()
         where id = $1`,
        [listingId, targetStatus],
      );

      await client.query(
        `insert into admin.moderation_events (listing_id, actor, action, reason)
         values ($1, $2, $3, $4)`,
        [listingId, actor.email, action, reason ?? null],
      );

      await client.query('commit');
      return { ok: true, listingId, newStatus: targetStatus };
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
}

function computeTargetStatus(
  from: string,
  action: ModerationAction,
): string | null {
  switch (action) {
    case 'approve':
      return from === 'pending' ? 'approved' : null;
    case 'reject':
      return from === 'pending' ? 'rejected' : null;
    case 'unreject':
      return from === 'rejected' ? 'pending' : null;
    case 'remove':
      // Admins can yank any listing off the platform.
      return 'removed';
    default:
      return null;
  }
}

export async function refreshMetricsSnapshot(): Promise<void> {
  await pool.query(`
    insert into admin.metrics_snapshot (
      captured_at, users_total, users_last_7d,
      listings_total, listings_pending, listings_approved, listings_rejected,
      gross_listings_value_cents
    )
    select
      now(),
      (select count(*) from public.users),
      (select count(*) from public.users where created_at > now() - interval '7 days'),
      (select count(*) from public.listings),
      (select count(*) from public.listings where status = 'pending'),
      (select count(*) from public.listings where status = 'approved'),
      (select count(*) from public.listings where status = 'rejected'),
      (select coalesce(sum(price_cents),0) from public.listings where status = 'approved')
    on conflict (captured_at) do update set
      users_total = excluded.users_total,
      users_last_7d = excluded.users_last_7d,
      listings_total = excluded.listings_total,
      listings_pending = excluded.listings_pending,
      listings_approved = excluded.listings_approved,
      listings_rejected = excluded.listings_rejected,
      gross_listings_value_cents = excluded.gross_listings_value_cents
  `);
}
