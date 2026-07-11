import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Singleton Postgres pool + Drizzle wrapper.
 * In dev, Next.js HMR can re-evaluate this module — keep the pool cached on globalThis.
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

export const db = drizzle(getPool(), { schema });
export { schema };