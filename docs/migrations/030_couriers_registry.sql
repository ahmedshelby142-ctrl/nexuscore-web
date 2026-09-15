-- 030 — Couriers become a real entity, not a string typed on each order.
--
-- ## Why
--
-- `ShippingSelector` collected «اسم شركة الشحن / المندوب» as FREE TEXT, and
-- `order.courierId` was optional with a `"default"` fallback. So:
--
--   * «أرامكس», «اراميكس» and «Aramex » were three couriers;
--   * an order could name a company in `courierName` while its MONEY
--     (`receivable_courier` / `payable_courier`) booked to the subject
--     `"default"`, because that is what `courierIdOf` falls back to;
--   * حسابات الشحن had to reverse-engineer the courier list out of the orders
--     themselves, and a courier with no orders yet did not exist at all.
--
-- `useCourierStore` did hold courier records — in **localStorage**, via
-- zustand `persist`, under the key `courier-storage`. It was never in
-- `CLOUD_SCHEMA` and there was no table behind it, so couriers were per-device:
-- register one on the shop's laptop and the phone had never heard of it. That
-- is why selecting instead of typing was not possible before this migration.
--
-- ## Shape
--
-- Deliberately identical to `suppliers` — text id, quoted camelCase business
-- columns, the §6 COMMON sync columns, soft delete via `deleted_at`. Nothing
-- here is novel; a courier is a counterparty directory exactly like a supplier.
--
-- ## Access
--
-- SELECT for any store member: a cashier must be able to PICK a courier, and
-- that is the whole point of the change.
--
-- WRITE for ADMIN only, because `/courier-ledger` — the management screen where
-- a courier is registered — is ADMIN-only in `ROUTE_ACCESS`. The brief asks
-- that companies be addable only in the proper management screen; matching the
-- policy to that screen's own access is how that is enforced rather than
-- merely hidden.

CREATE TABLE IF NOT EXISTS public.couriers (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  phone         text,
  notes         text,
  "createdAt"   timestamptz,
  "updatedAt"   timestamptz,
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL,
  sync_status   text NOT NULL DEFAULT 'pending',
  deleted_at    timestamptz,
  updated_at    bigint NOT NULL DEFAULT 0
);

-- One name per shop, case-insensitively, among the LIVE rows. This is the
-- constraint that makes «أرامكس» typed twice impossible rather than merely
-- discouraged. Archived rows are excluded so a name can be reused after the
-- courier is retired.
CREATE UNIQUE INDEX IF NOT EXISTS couriers_name_per_store
  ON public.couriers (store_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_couriers_store ON public.couriers (store_id);

ALTER TABLE public.couriers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_couriers ON public.couriers;
CREATE POLICY select_couriers ON public.couriers
  FOR SELECT USING (public.is_store_member(store_id));

DROP POLICY IF EXISTS write_couriers ON public.couriers;
CREATE POLICY write_couriers ON public.couriers
  FOR ALL
  USING (public.has_role(store_id, VARIADIC ARRAY['ADMIN']::text[]))
  WITH CHECK (public.has_role(store_id, VARIADIC ARRAY['ADMIN']::text[]));

REVOKE ALL ON TABLE public.couriers FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.couriers TO authenticated;
