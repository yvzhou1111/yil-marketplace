/**
 * Sentry browser init. Next.js loads this file automatically on the client.
 * Kept as a tiny shim so the heavy init lives in one place (`src/lib/observability/sentry.ts`).
 */

import { initSentryBrowser } from "./src/lib/observability/sentry";

void initSentryBrowser();