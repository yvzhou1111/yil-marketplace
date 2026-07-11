/**
 * Application logger — single shared pino instance.
 *
 * Conventions (see docs/observability/LOGGING.md):
 *
 * - One logger per process. Import `logger` and call methods directly.
 * - Always JSON in production (`LOG_PRETTY=false`), pino-pretty in dev.
 * - Redaction is applied to every event payload, on top of pino's default
 *   sensitive-field paths (configured by `LOG_REDACT_PATHS` env var).
 * - Bindings are inherited: a child logger inherits `requestId`, `route`, etc.
 *
 * Why pino, not the built-in `console`:
 * - We need machine-readable structured output that the log aggregator can
 *   query by `event` or `route`.
 * - We need to redact PII before it leaves the process.
 * - We need child loggers for request-scoped context.
 */

import pino, { type Logger, type LoggerOptions } from "pino";
import { parseRedactPaths } from "./observability/redact";

export type AppLogger = Logger;

let cached: Logger | undefined;

/**
 * Returns the process-wide logger. Reads `LOG_LEVEL` and `LOG_PRETTY` from
 * the environment on first call, then caches.
 *
 * In serverless / edge environments this is called per-invocation — the cache
 * lasts only as long as the runtime, which is the desired behavior.
 */
export function getLogger(): Logger {
  if (cached) return cached;

  const level = process.env.LOG_LEVEL ?? "info";
  const pretty = process.env.LOG_PRETTY === "true";
  const redactPaths = parseRedactPaths(process.env.LOG_REDACT_PATHS);

  const options: LoggerOptions = {
    level,
    base: {
      service: "yil-marketplace",
      env: process.env.NODE_ENV ?? "development",
      sha: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local",
    },
    // Pino's redact removes matching paths from every log payload before
    // serialization. We add ours on top of pino's defaults.
    redact: {
      paths: redactPaths,
      censor: "[redacted]",
      remove: false,
    },
    // Use ISO timestamps so the aggregator can sort without parsing hints.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (pretty && process.env.NODE_ENV !== "production") {
    // Lazy import pino-pretty only in dev — keeps prod bundle small.
    const prettyOpts = {
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname",
    };
    try {
      // Use transport only when pino-pretty is installed. If it isn't,
      // fall back to JSON output (no error, just less readable locally).
      const transport = pino.transport({
        target: "pino-pretty",
        options: prettyOpts,
      });
      cached = pino(options, transport);
      return cached;
    } catch {
      cached = pino(options);
      return cached;
    }
  }

  cached = pino(options);
  return cached;
}

/** Convenience accessor — equivalent to `getLogger()` but shorter at call sites. */
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop, receiver) {
    return Reflect.get(getLogger(), prop, receiver);
  },
});

/**
 * Bind request-scoped fields to a child logger. Use this from
 * `request-log.ts` so every log line within a request carries the same
 * `requestId`, `route`, `method`.
 */
export function requestLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}