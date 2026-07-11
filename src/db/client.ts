import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Singleton Postgres pool + Drizzle wrapper.
 * In dev, Next.js HMR can re-evaluate this module — keep the pool cached on globalThis.
 *
 * The pool is created lazily so importing this module at build time
 * (Next.js collects page data during `next build`) doesn't throw when
 * DATABASE_URL is not set in the build environment.
 */
declare global {
  // eslint-disable-next-line no-var
  var __yilPgPool: Pool | undefined;
}

function getPool(): Pool {
  if (!globalThis.__yilPgPool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.example to .env.local or set the env var."
      );
    }
    globalThis.__yilPgPool = new Pool({ connectionString: url });
  }
  return globalThis.__yilPgPool;
}

let _db: ReturnType<typeof drizzle> | undefined;
function getDb() {
  if (!_db) _db = drizzle(getPool(), { schema });
  return _db;
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    return Reflect.get(getDb() as object, prop);
  },
});

export { schema };