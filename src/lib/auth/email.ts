/**
 * Email transport — YIL-4.
 *
 * In production this would call a transactional email provider (Postmark,
 * SES, Resend). For the week-1 bootstrap we log the message and — when
 * `MAGIC_LINK_DEV_LOG_ONLY` is unset — also print the magic link to the
 * server stdout so a developer clicking through the API can copy/paste it.
 *
 * The provider swap lives entirely behind `sendMagicLinkEmail`. Routes
 * never import an SDK directly.
 */

export type MagicLinkEmail = {
  to: string;
  url: string;
  expiresAt: Date;
};

const DEV_LOG_ENV = "MAGIC_LINK_DEV_LOG_ONLY";

export async function sendMagicLinkEmail(msg: MagicLinkEmail): Promise<void> {
  if (process.env.NODE_ENV !== "production" && !process.env[DEV_LOG_ENV]) {
    // Dev convenience: surface the link in server logs so a developer
    // can copy it without leaving the terminal. In prod we MUST NOT log
    // the URL because anyone reading the logs gets to sign in as the
    // recipient.
    // eslint-disable-next-line no-console
    console.info(
      `[auth] magic link for ${maskEmail(msg.to)}: ${msg.url} ` +
        `(expires ${msg.expiresAt.toISOString()})`
    );
    return;
  }

  // TODO(YIL-?): wire a transactional email provider. Until then, log
  // a structured event so the test suite can assert it fired.
  // eslint-disable-next-line no-console
  console.info(
    JSON.stringify({
      event: "magic_link_email",
      to: maskEmail(msg.to),
      expires_at: msg.expiresAt.toISOString(),
      // We deliberately do NOT log the URL in production.
    })
  );
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "<invalid>";
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}