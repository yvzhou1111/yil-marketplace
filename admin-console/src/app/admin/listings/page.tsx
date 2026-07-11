// /admin/listings — moderation queue. Default view shows pending listings;
// the status dropdown switches to approved/rejected/removed.
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';

type ListingRow = {
  id: string;
  title: string;
  description: string | null;
  price_cents: number;
  currency: string;
  status: string;
  created_at: string;
  seller_email: string | null;
  seller_display_name: string | null;
};

const ALLOWED_STATUSES = new Set(['pending', 'approved', 'rejected', 'removed']);

export default async function ListingsPage({
  searchParams,
}: {
  searchParams?: { status?: string; q?: string };
}) {
  const status = searchParams?.status ?? 'pending';
  const q = (searchParams?.q ?? '').trim();

  if (!ALLOWED_STATUSES.has(status)) {
    return <p className="flash error">Unknown status: {status}</p>;
  }

  const where: string[] = ['l.status = $1'];
  const args: unknown[] = [status];
  if (q.length > 0) {
    args.push(`%${q.toLowerCase()}%`);
    where.push('(lower(l.title) like $2 or lower(coalesce(u.email,\'\')) like $2)');
  }
  const whereSql = where.join(' and ');

  const sql = `
    select
      l.id, l.title, l.description, l.price_cents, l.currency, l.status, l.created_at,
      u.email as seller_email, u.display_name as seller_display_name
    from public.listings l
    left join public.users u on u.id = l.seller_id
    where ${whereSql}
    order by l.created_at desc
    limit 100
  `;
  const { rows } = await pool.query<ListingRow>(sql, args);

  return (
    <div>
      <h1>Listing moderation</h1>

      <form className="toolbar" method="get">
        <select name="status" defaultValue={status}>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="removed">Removed</option>
        </select>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search title or seller email"
        />
        <button type="submit">Apply</button>
        <span className="muted">{rows.length} result{rows.length === 1 ? '' : 's'}</span>
      </form>

      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Seller</th>
            <th>Price</th>
            <th>Status</th>
            <th>Submitted</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">No listings match this filter.</td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <div><strong>{r.title}</strong></div>
                {r.description && <div className="muted">{r.description}</div>}
              </td>
              <td>
                <div>{r.seller_display_name ?? <span className="muted">—</span>}</div>
                <div className="muted">{r.seller_email ?? 'unknown seller'}</div>
              </td>
              <td>
                {formatPrice(r.price_cents, r.currency)}
              </td>
              <td><span className={`pill ${r.status}`}>{r.status}</span></td>
              <td className="muted">{new Date(r.created_at).toLocaleString()}</td>
              <td>
                {r.status === 'pending' && (
                  <RowActions id={r.id} mode="pending" />
                )}
                {r.status === 'rejected' && (
                  <RowActions id={r.id} mode="rejected" />
                )}
                {(r.status === 'approved' || r.status === 'removed') && (
                  <form action={`/api/listings/${r.id}/reject`} method="post" style={{ display: 'inline' }}>
                    <button type="submit" className="danger">Remove</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowActions({ id, mode }: { id: string; mode: 'pending' | 'rejected' }) {
  if (mode === 'pending') {
    return (
      <span style={{ display: 'inline-flex', gap: 6 }}>
        <form action={`/api/listings/${id}/approve`} method="post" style={{ display: 'inline' }}>
          <button type="submit">Approve</button>
        </form>
        <form action={`/api/listings/${id}/reject`} method="post" style={{ display: 'inline' }}>
          <button type="submit" className="danger">Reject</button>
        </form>
      </span>
    );
  }
  return (
    <form action={`/api/listings/${id}/reject`} method="post" style={{ display: 'inline' }}>
      <input type="hidden" name="action" value="unreject" />
      <button type="submit" className="secondary">Undo reject</button>
    </form>
  );
}

function formatPrice(cents: number, currency: string): string {
  const major = (cents / 100).toFixed(2);
  return `${currency} ${major}`;
}