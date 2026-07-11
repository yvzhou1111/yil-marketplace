// /admin/users — search by email, display name, or id. Shows listings the user
// owns so admins can pivot from a user to their inventory quickly.
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';

type UserRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  created_at: string;
  last_seen_at: string | null;
  listing_count: number;
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams?: { q?: string; role?: string };
}) {
  const q = (searchParams?.q ?? '').trim();
  const role = (searchParams?.role ?? '').trim();

  const where: string[] = [];
  const args: unknown[] = [];
  if (q.length > 0) {
    args.push(`%${q.toLowerCase()}%`);
    where.push(`(lower(coalesce(email,'')) like $${args.length}
                  or lower(coalesce(display_name,'')) like $${args.length}
                  or id::text like $${args.length})`);
  }
  if (role.length > 0) {
    args.push(role);
    where.push(`role = $${args.length}`);
  }
  const whereSql = where.length > 0 ? `where ${where.join(' and ')}` : '';

  const sql = `
    select
      u.id, u.email, u.display_name, u.role, u.created_at, u.last_seen_at,
      coalesce(lc.cnt, 0)::int as listing_count
    from public.users u
    left join (
      select seller_id, count(*)::int as cnt
      from public.listings
      group by seller_id
    ) lc on lc.seller_id = u.id
    ${whereSql}
    order by u.created_at desc
    limit 100
  `;
  const { rows } = await pool.query<UserRow>(sql, args);

  return (
    <div>
      <h1>User lookup</h1>

      <form className="toolbar" method="get">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Email, name, or id"
          style={{ minWidth: 320 }}
        />
        <select name="role" defaultValue={role}>
          <option value="">Any role</option>
          <option value="user">user</option>
          <option value="seller">seller</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">Search</button>
        <span className="muted">{rows.length} result{rows.length === 1 ? '' : 's'}</span>
      </form>

      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Email</th>
            <th>Role</th>
            <th>Listings</th>
            <th>Joined</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">No users match.</td>
            </tr>
          )}
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.display_name ?? <span className="muted">—</span>}</td>
              <td className="muted">{u.email ?? '—'}</td>
              <td><span className="pill">{u.role}</span></td>
              <td>{u.listing_count}</td>
              <td className="muted">{new Date(u.created_at).toLocaleDateString()}</td>
              <td className="muted">
                {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : 'never'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}