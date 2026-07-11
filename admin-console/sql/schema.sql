-- YIL-11 Admin Console: minimal schema for moderation, user lookup, and metrics.
-- This is intentionally a paper-thin overlay on top of the eventual marketplace
-- data model (YIL-5). It only defines what the admin console needs to operate:
-- moderation state on listings, denormalized user columns it can read, and
-- a few aggregated metrics queries that are intentionally simple.

create schema if not exists admin;

-- Listing state machine overlay (YIL-5 owns the canonical `listings` table;
-- this view assumes the canonical table has at least: id, seller_id, title,
-- description, price_cents, currency, created_at, status)
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'listings'
  ) then
    create table public.listings (
      id           uuid primary key default gen_random_uuid(),
      seller_id    uuid not null,
      title        text not null,
      description  text,
      price_cents  integer not null check (price_cents >= 0),
      currency     char(3) not null default 'USD',
      status       text not null default 'pending'
                      check (status in ('pending','approved','rejected','removed')),
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now()
    );
    create index listings_status_idx on public.listings (status, created_at desc);
    create index listings_seller_idx on public.listings (seller_id);
  end if;
end$$;

-- Minimal users table for the admin console's lookup page. Mirrors what the
-- auth system (YIL-4) will eventually expose, but keeps the admin console
-- runnable in isolation by defining its own columns.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'users'
  ) then
    create table public.users (
      id            uuid primary key default gen_random_uuid(),
      email         citext unique,
      display_name  text,
      role          text not null default 'user'
                       check (role in ('user','seller','admin')),
      created_at    timestamptz not null default now(),
      last_seen_at  timestamptz
    );
    create index users_email_idx on public.users (email);
    create index users_role_idx  on public.users (role);
  end if;
end$$;

-- Moderation events: append-only audit trail for the console.
create table if not exists admin.moderation_events (
  id           bigserial primary key,
  listing_id   uuid not null,
  actor        text not null,                 -- admin user id or email
  action       text not null
                 check (action in ('approve','reject','unreject','remove')),
  reason       text,
  created_at   timestamptz not null default now()
);
create index moderation_events_listing_idx
  on admin.moderation_events (listing_id, created_at desc);

-- Materialised snapshot of dashboard metrics. Refreshed on demand from the
-- admin console — keeps the dashboard query O(1) regardless of row growth.
create table if not exists admin.metrics_snapshot (
  captured_at          timestamptz primary key default now(),
  users_total          bigint not null,
  users_last_7d        bigint not null,
  listings_total       bigint not null,
  listings_pending     bigint not null,
  listings_approved    bigint not null,
  listings_rejected    bigint not null,
  gross_listings_value_cents bigint not null
);

-- Convenience view: listings augmented with seller email for the moderation UI.
create or replace view admin.listings_with_seller as
  select
    l.id,
    l.title,
    l.description,
    l.price_cents,
    l.currency,
    l.status,
    l.created_at,
    l.updated_at,
    l.seller_id,
    u.email as seller_email,
    u.display_name as seller_display_name
  from public.listings l
  left join public.users u on u.id = l.seller_id;

-- Seed data so the dashboard isn't empty on first boot. Idempotent.
insert into public.users (id, email, display_name, role)
values
  ('00000000-0000-0000-0000-000000000001', 'founder@yilix.test', 'Founder',         'admin'),
  ('00000000-0000-0000-0000-000000000002', 'ada@yilix.test',     'Ada Lovelace',    'seller'),
  ('00000000-0000-0000-0000-000000000003', 'grace@yilix.test',   'Grace Hopper',    'seller'),
  ('00000000-0000-0000-0000-000000000004', 'linus@yilix.test',   'Linus Torvalds',  'seller'),
  ('00000000-0000-0000-0000-000000000005', 'buyer1@yilix.test',  'Buyer One',       'user'),
  ('00000000-0000-0000-0000-000000000006', 'buyer2@yilix.test',  'Buyer Two',       'user')
on conflict (id) do nothing;

insert into public.listings (id, seller_id, title, description, price_cents, currency, status, created_at)
values
  ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'Hand-turned walnut pen',        'Made on a south-facing windowsill.', 4500,  'USD', 'pending',  now() - interval '2 hours'),
  ('11111111-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Hand-bound pocket notebook',   '64 pages, dot grid, sewn binding.', 1800,  'USD', 'pending',  now() - interval '5 hours'),
  ('11111111-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', 'Vintage copper kettle',        'Lightly polished, no leaks.',       12500, 'USD', 'approved', now() - interval '1 day'),
  ('11111111-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 'Antique brass compass',        'Working but jewel is loose.',       8200, 'USD', 'pending',  now() - interval '3 days'),
  ('11111111-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004', 'Mechanical keyboard kit',      'Soldering required.',              29900, 'USD', 'approved', now() - interval '6 hours'),
  ('11111111-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000004', 'Spare keyboard PCB',           'Hot-swap, RGB underglow.',         14500, 'USD', 'rejected', now() - interval '7 hours'),
  ('11111111-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000004', 'Test listing — spam',          'Buy now!!!',                          100, 'USD', 'pending',  now() - interval '15 minutes')
on conflict (id) do nothing;

-- Initial metrics snapshot
insert into admin.metrics_snapshot (
  captured_at, users_total, users_last_7d,
  listings_total, listings_pending, listings_approved, listings_rejected,
  gross_listings_value_cents
)
select
  now(),
  (select count(*) from public.users),
  (select count(*) from public.users where created_at > now() - interval '7 days'),
  (select count(*) from public.listings),
  (select count(*) from public.listings where status = 'pending'),
  (select count(*) from public.listings where status = 'approved'),
  (select count(*) from public.listings where status = 'rejected'),
  (select coalesce(sum(price_cents),0) from public.listings where status = 'approved')
on conflict (captured_at) do nothing;
