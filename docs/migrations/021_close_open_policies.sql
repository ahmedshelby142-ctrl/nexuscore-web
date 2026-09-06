-- ============================================================================
-- 021 — close three policies that were open to the whole internet
--
-- Safe to re-run.
--
-- FOUND BY: reading every policy on every table in the live database during the
-- final production audit, looking for `USING (true)` / `WITH CHECK (true)`.
-- Three turned up, all granted to PUBLIC — which includes `anon`, the role the
-- publishable key in every shipped bundle resolves to.
--
-- ── 1. `orders` — the serious one ───────────────────────────────────────────
--
--     CREATE POLICY "Allow full access to orders" ON orders
--       FOR ALL USING (true) WITH CHECK (true);
--
-- Postgres OR-s permissive policies together, so this did not sit alongside
-- `select_orders` and `write_orders` — it REPLACED them. Every tenant check on
-- the orders table was decorative.
--
-- Proven against the live database before this migration was written, with no
-- session at all and nothing but the publishable key:
--
--     POST   /rest/v1/orders            (store_id of a store the caller is
--                                        not a member of)          → 201
--     GET    /rest/v1/orders?store_id=… (that same store)           → 200, rows
--     PATCH  /rest/v1/orders?id=…                                   → 204
--     DELETE /rest/v1/orders?id=…                                   → 204
--
-- Read, write, edit and delete any shop's orders, from a browser that has never
-- signed in. Orders carry `customerName`, `customerPhone` and `address`, so
-- this was customer PII as well as business data. The probe row was tagged
-- `QA-RLS-PROBE-…` and deleted immediately; the table held no other rows.
--
-- Dropping the policy leaves the two that were always meant to govern this
-- table: `select_orders` for members, `write_orders` for ADMIN / POS_ECOMMERCE
-- / ECOMMERCE_ONLY. Nothing legitimate loses access — the app has only ever
-- used those roles here.
--
-- ── 2. `auth_sessions`, `auth_login_attempts` — the legacy auth tables ──────
--
-- SELECT, INSERT and UPDATE were all `true` to PUBLIC on `auth_sessions`, and
-- INSERT was `true` on `auth_login_attempts`. They belong to the local
-- username/password system that predates Supabase Auth, whose last reachable
-- caller was removed when the `owner`/`owner` fallback went. Nothing in the app
-- reads or writes either table any more.
--
-- Left as they were, `auth_sessions` is a world-readable, world-writable table
-- named "sessions", and `auth_login_attempts` is an unauthenticated INSERT
-- endpoint anyone can fill. Both are empty of anything that matters
-- (`auth_sessions` has no rows; `auth_login_attempts` holds five from the old
-- flow), so the policies simply go.
--
-- The tables are NOT dropped. Dropping is irreversible and buys nothing that
-- deny-all does not: with RLS on and no policy, they are inert to every client
-- role, exactly like `public.users` beside them. If the legacy system is ever
-- properly removed, that is a separate, deliberate change.
-- ============================================================================

DROP POLICY IF EXISTS "Allow full access to orders"              ON public.orders;
DROP POLICY IF EXISTS "Allow anon select from auth_sessions"     ON public.auth_sessions;
DROP POLICY IF EXISTS "Allow anon insert to auth_sessions"       ON public.auth_sessions;
DROP POLICY IF EXISTS "Allow anon update to auth_sessions"       ON public.auth_sessions;
DROP POLICY IF EXISTS "Allow anon insert to auth_login_attempts" ON public.auth_login_attempts;

-- RLS stays on for all three. `orders` keeps `select_orders` / `write_orders`;
-- the two legacy tables keep none, which is deny-all.
ALTER TABLE public.orders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_login_attempts ENABLE ROW LEVEL SECURITY;
