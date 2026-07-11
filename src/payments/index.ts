/**
 * Public surface of the payments module (YIL-9).
 *
 * Re-exports everything app code and tests need. Keep this list narrow —
 * internal helpers should NOT leak.
 */

export * from "./types";
export * from "./state";
export * from "./idempotency";
export {
  createIntentForOrder,
  retrievePaymentIntent,
  newPendingRecord,
  OrderNotPayableError,
  AmountMismatchError,
  CurrencyMismatchError,
} from "./intents";
export type {
  OrderSnapshot,
  CreateIntentInput,
  CreateIntentResult,
} from "./intents";
export {
  createRefund,
  RefundNotAllowedError,
  SELLER_ALLOWED_REFUND_REASONS,
  ADMIN_ALLOWED_REFUND_REASONS,
} from "./refunds";
export type {
  RefundReason,
  CreateRefundInput,
  CreateRefundResult,
} from "./refunds";
export {
  handleWebhook,
  verifyWebhook,
  WebhookSignatureError,
  isHandledEventType,
} from "./webhooks";
export type { WebhookRowStore, WebhookOutcome } from "./webhooks";
export {
  getStripeClient,
  getStripeWebhookSecret,
  getStripePublishableKey,
  STRIPE_API_VERSION,
  StripeConfigError,
} from "./stripe";
export {
  insertPendingIntent,
  findById,
  findByStripeId,
  setStripePaymentIntentId,
  persistTransition,
  insertRefund,
  toRecord,
  liveWebhookStore,
} from "./db";