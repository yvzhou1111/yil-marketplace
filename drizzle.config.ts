import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  // Generated SQL lives next to the hand-authored bootstrap migrations so
  // `tsx scripts/migrate.ts` only has to know about one folder. The naming
  // convention is `NNNN_<slug>.sql` with a monotonically increasing NNNN.
  out: "./db/migrations/generated",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://yil:yil@localhost:5432/yil_marketplace",
  },
  strict: true,
  verbose: true,
} satisfies Config;