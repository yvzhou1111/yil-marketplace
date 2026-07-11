/**
 * Drizzle schema for the orders module.
 *
 * YIL-16 only needs the two tables the transactional wrapper writes:
 *   - `orders` — current state of an order
 *   - `order_state_transitions` — append-only audit log of every state change
 *
 * Both tables are created by the hand-authored migration
 * `db/migrations/0004_order_state_transitions.sql`, plus the surrounding
 * schema (users, listings, …) defined in `db/migrations/generated/`. The
 * trigger that enforces legal state transitions on UPDATE is also defined
 * in that hand-authored file — see the comment block at the top of it
 * for the rationale (app-layer + DB-layer double defense).
 *
 * Out of scope here: listings, reviews, users, categories, … Those
 * belong with their respective YIL tickets and are not imported from
 * the orders service.
 */

import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/*  Enums                                                                     */
/* -------------------------------------------------------------------------- */

export const orderState = pgEnum("order_state", [
  "initiated",
  "paid",
  "fulfilled",
  "completed",
  "disputed",
  "cancelled",
]);

export const orderTransitionActor = pgEnum("order_transition_actor", [
  "buyer",
  "seller",
  "admin",
  "system",
]);

/* -------------------------------------------------------------------------- */
/*  Tables                                                                    */
/* -------------------------------------------------------------------------- */

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id").notNull(),
    buyerId: uuid("buyer_id").notNull(),
    sellerId: uuid("seller_id").notNull(),
    state: orderState("state").default("initiated").notNull(),
    amountMinor: text("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).default("USD").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => ({
    stateIdx: index("orders_state_idx").on(t.state, t.createdAt),
    buyerIdx: index("orders_buyer_idx").on(t.buyerId, t.createdAt),
    sellerIdx: index("orders_seller_idx").on(t.sellerId, t.createdAt),
  })
);

export const orderStateTransitions = pgTable(
  "order_state_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull(),
    fromState: orderState("from_state"),
    toState: orderState("to_state").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorRole: orderTransitionActor("actor_role").notNull(),
    reason: varchar("reason", { length: 500 }).default("").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    orderHistoryIdx: index("order_state_transitions_order_history_idx").on(
      t.orderId,
      t.createdAt
    ),
    actorIdx: index("order_state_transitions_actor_idx").on(
      t.actorUserId,
      t.createdAt
    ),
    toStateIdx: index("order_state_transitions_to_state_idx").on(
      t.toState,
      t.createdAt
    ),
  })
);

/* -------------------------------------------------------------------------- */
/*  Inferred row types                                                        */
/* -------------------------------------------------------------------------- */

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderStateTransition = typeof orderStateTransitions.$inferSelect;
export type NewOrderStateTransition = typeof orderStateTransitions.$inferInsert;