// GET /api/users/lookup — JSON variant of the users page, for tooling that
// wants to query without rendering HTML.
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const role = (url.searchParams.get('role') ?? '').trim();

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
    select id, email, display_name, role, created_at, last_seen_at
    from public.users
    ${whereSql}
    order by created_at desc
    limit 100
  `;
  const { rows } = await pool.query(sql, args);
  return NextResponse.json({ users: rows });
}