// Tiny Postgres pool wrapper. Never invokes a query that mutates state
// without logging it via admin.moderation_events when relevant.
import { Pool, type PoolClient } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var __admin_pg_pool__: Pool | undefined;
}

function makePool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for the admin console.');
  }
  return new Pool({
    connectionString: url,
    max: Number(process.env.ADMIN_DB_POOL_MAX ?? '5'),
    idleTimeoutMillis: 30_000,
  });
}

export const pool: Pool = global.__admin_pg_pool__ ?? makePool();
if (process.env.NODE_ENV !== 'production') {
  global.__admin_pg_pool__ = pool;
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export function requireAdmin(req: Request): { id: string; email: string } {
  // YIL-4 will own real auth; until then, accept an `x-admin-email` header
  // for local exercising. Real production deploys must replace this with the
  // shared auth middleware from the main app.
  const email = req.headers.get('x-admin-email') ?? 'founder@yilix.test';
  const id =
    req.headers.get('x-admin-id') ?? '00000000-0000-0000-0000-000000000001';
  return { id, email };
}
