/**
 * Unit tests for the repo's `buildBrowseWhereSql` helper.
 *
 * We render the resulting SQL fragment with `PgDialect.sqlToQuery()` —
 * the same call the production Postgres driver uses — so the assertions
 * can pin down the parameterized SQL string and the bound parameters.
 * This catches regressions in parameter ordering, escaping of `%` / `_`
 * in LIKE patterns, and the category-slug `EXISTS` shape.
 */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { buildBrowseWhereSql } from "./repo";

const dialect = new PgDialect();

type Rendered = { sql: string; params: unknown[] };

function renderWhere(filters: Parameters<typeof buildBrowseWhereSql>[0]): Rendered {
  const fragment = buildBrowseWhereSql(filters);
  const compiled = dialect.sqlToQuery(fragment as never);
  return { sql: compiled.sql, params: compiled.params };
}

describe("buildBrowseWhereSql", () => {
  it("always restricts to non-deleted, published listings", () => {
    const r = renderWhere({});
    expect(r.sql).toMatch(/deleted_at IS NULL/);
    expect(r.sql).toMatch(/status = 'published'/);
  });

  it("adds an inclusive lower price bound", () => {
    const r = renderWhere({ priceMinCents: 5000 });
    expect(r.sql).toMatch(/amount_cents\s*>=\s*\$1/);
    expect(r.params[0]).toBe(5000);
  });

  it("adds an inclusive upper price bound", () => {
    const r = renderWhere({ priceMaxCents: 25_000 });
    expect(r.sql).toMatch(/amount_cents\s*<=\s*\$1/);
    expect(r.params[0]).toBe(25_000);
  });

  it("supports both bounds simultaneously", () => {
    const r = renderWhere({ priceMinCents: 1000, priceMaxCents: 9000 });
    expect(r.sql).toMatch(/amount_cents\s*>=\s*\$1/);
    expect(r.sql).toMatch(/amount_cents\s*<=\s*\$2/);
    expect(r.params).toEqual([1000, 9000]);
  });

  it("escapes LIKE wildcards in the location filter", () => {
    const r = renderWhere({ location: "100% off_now" });
    expect(r.sql).toMatch(/location ILIKE/);
    // The bound parameter must have % and _ escaped so the user can't
    // accidentally match every row.
    expect(r.params[0]).toBe("%100\\% off\\_now%");
  });

  it("trims and collapses whitespace in the location filter", () => {
    const r = renderWhere({ location: "  Brooklyn,   NY  " });
    expect(r.params[0]).toBe("%Brooklyn, NY%");
  });

  it("skips the location predicate when the input is empty / whitespace", () => {
    const r = renderWhere({ location: "   " });
    expect(r.sql).not.toMatch(/location ILIKE/);
  });

  it("uses EXISTS + IN for the category filter", () => {
    const r = renderWhere({ categorySlugs: ["books", "music"] });
    expect(r.sql).toMatch(/EXISTS\s*\(/);
    expect(r.sql).toMatch(/c\.slug IN/);
    // Drizzle inlines the IN list as multiple bound parameters.
    expect(r.params).toEqual(["books", "music"]);
  });

  it("skips the category predicate when the list is empty", () => {
    const r = renderWhere({ categorySlugs: [] });
    expect(r.sql).not.toMatch(/EXISTS/);
  });

  it("combines all filters with AND", () => {
    const r = renderWhere({
      categorySlugs: ["books"],
      priceMinCents: 1000,
      priceMaxCents: 5000,
      location: "NY",
    });
    expect(r.sql).toMatch(/AND/);
    expect(r.sql).toMatch(/category_id/);
    expect(r.sql).toMatch(/amount_cents/);
    expect(r.sql).toMatch(/location/);
  });
});

describe("buildBrowseWhereSql — SQL safety", () => {
  it("never interpolates user input as raw SQL", () => {
    // Inputs that an attacker might try to slip past string concatenation.
    const malicious = {
      categorySlugs: ["'); DROP TABLE listings; --"],
      location: "' OR 1=1 --",
    };
    const r = renderWhere(malicious);
    // Both values must end up as bound parameters, not embedded literals.
    expect(r.sql).not.toMatch(/DROP TABLE/);
    expect(r.sql).not.toMatch(/OR 1=1/);
  });

  it("returns a sensible fragment for the no-filter case", () => {
    const r = renderWhere({});
    // Two always-on predicates → wrapped in parens for safety. We don't
    // care about the wrapping here, just that both predicates are present.
    expect(r.sql).toMatch(/deleted_at IS NULL/);
    expect(r.sql).toMatch(/status = 'published'/);
  });
});

// Quietly exercise the `sql` import so the linter doesn't complain.
// This is intentional — it's the same `sql` Drizzle uses internally and
// we want this file's import list to reflect that.
export const __ensureSqlUsed = sql`SELECT 1`;