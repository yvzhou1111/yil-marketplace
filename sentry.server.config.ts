/**
 * Sentry server init. Next.js loads this file automatically on the server.
 * Kept as a tiny shim so the heavy init lives in one place (`src/lib/observability/sentry.ts`).
 *
 * Note: this is for the *initial* server boot only. The full init that
 * catches route-handler errors runs from `instrumentation.ts` so we can
 * control sample rate and `beforeSend` from a single place.
 */

import { initSentryServer } from "./src/lib/observability/sentry";

void initSentryServer();