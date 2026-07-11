/**
 * PII / secret redaction helpers shared by the logger and Sentry `beforeSend`.
 *
 * Two surfaces:
 *
 * - `REDACT_PATHS` — the default list of field paths that should be stripped
 *   from any object passed through `redact()`. Composed with the
 *   `LOG_REDACT_PATHS` env var (comma-separated) at logger init time.
 *
 * - `redact(value)` — returns a deep-cloned object with matching paths
 *   replaced by `"[redacted]"`. Pure function — safe to call from request
 *   handlers without leaking references.
 *
 * The path matcher is intentionally simple: paths are dot-separated, and a
 * single `*` segment matches one level. We do not need glob — we just need
 * to cover the common cases (`*.token`, `password`, `authorization`).
 */

export const REDACT_PATHS: ReadonlyArray<string> = [
  "password",
  "*.password",
  "secret",
  "*.secret",
  "*secret*",
  "token",
  "*.token",
  "*token*",
  "authorization",
  "cookie",
  "set-cookie",
  "credit_card",
  "*.credit_card",
  "*.cc",
  "ssn",
  "*.ssn",
  "tax_id",
  "*.tax_id",
  "session",
  "*.session",
];

export function parseRedactPaths(envValue: string | undefined): string[] {
  if (!envValue) return [...REDACT_PATHS];
  const fromEnv = envValue
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // env-supplied paths are additive on top of the defaults.
  return [...REDACT_PATHS, ...fromEnv];
}

/**
 * Returns true if `path` matches any of the glob-style `patterns`.
 *
 * A pattern like `*.token` matches `user.token` and `tokens.token`, but not
 * `token`. A pattern like `token` matches only the literal field `token`.
 * A pattern like `*token*` matches any path that contains `token`.
 */
export function matchesAny(path: string, patterns: ReadonlyArray<string>): boolean {
  for (const pattern of patterns) {
    if (matchPath(pattern, path)) return true;
  }
  return false;
}

function matchPath(pattern: string, path: string): boolean {
  // Escape regex special chars in the pattern, then translate `*` into `.*`.
  // We match case-insensitively because real-world identifiers show up as
  // `authToken`, `Auth-Token`, `AUTH_TOKEN`, etc.
  const regexSource = pattern
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${regexSource}$`, "i");
  return regex.test(path);
}

/**
 * Walks `value`, replacing any field whose dotted path matches a redact
 * pattern with the literal string `"[redacted]"`. Returns a deep clone —
 * the input is not mutated.
 */
export function redact<T>(value: T, patterns: ReadonlyArray<string>): T {
  return walk(value, "", patterns) as T;
}

const REDACTED = "[redacted]" as const;

function walk(value: unknown, path: string, patterns: ReadonlyArray<string>): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, `${path}[${index}]`, patterns));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (matchesAny(childPath, patterns)) {
        out[key] = REDACTED;
      } else {
        out[key] = walk(child, childPath, patterns);
      }
    }
    return out;
  }
  return value;
}