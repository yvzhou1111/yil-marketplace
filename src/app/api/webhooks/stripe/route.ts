/**
 * POST /api/webhooks/stripe — Stripe → us.
 *
 * Always returns 200 unless the signature is invalid (400) or we hit an
 * unrecoverable error (500). Stripe expects 2xx for "we got it" and
 * retries on 5xx. The handler itself is idempotent + dedupe-safe.
 *
 * We do NOT parse JSON ourselves — `Request.text()` gives us the raw
 * bytes that Stripe signed. Passing `req.json()` to `verifyWebhook`
 * would silently fail (signatures check the raw body, not the parsed one).
 */
import { NextResponse } from "next/server";
import {
  handleWebhook,
  WebhookSignatureError,
  StripeConfigError,
  liveWebhookStore,
} from "@/payments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return new NextResponse("missing stripe-signature header", { status: 400 });
  }

  const rawBody = await req.text();

  try {
    const outcome = await handleWebhook(rawBody, sig, liveWebhookStore);
    return NextResponse.json(outcome, { status: 200 });
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      // 400 (no retry) — sigs that don't match are bad credentials / replay
      // attempts; we don't want Stripe to retry them.
      return new NextResponse("invalid signature", { status: 400 });
    }
    if (err instanceof StripeConfigError) {
      // 500 with no body details — server-side misconfiguration, Stripe
      // will retry.
      return new NextResponse("webhook misconfigured", { status: 500 });
    }
    return new NextResponse("internal error", { status: 500 });
  }
}
