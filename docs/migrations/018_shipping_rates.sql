-- ============================================================================
-- 018 — shipping_rates
--
-- Safe to re-run: every statement is idempotent.
--
-- WHY THIS EXISTS
-- ---------------
-- The shipping price matrix the owner edits in الإعدادات → الشحن lived in
-- localStorage and nowhere else. It is the last piece of business data in this
-- app that a second device could not see, and its absence is not cosmetic:
-- `/ecommerce-orders` builds its governorate dropdown from these rows, so a
-- browser without them cannot raise an online order AT ALL. The dropdown was
-- simply empty, with the submit button disabled and nothing on screen saying
-- why.
--
-- The rows are reference CONFIG, not a computed value — storing them is
-- legitimate in a way a balance never is. Every fee is snapshotted into the
-- ledger event at the moment of the movement, so this table prices the FUTURE
-- and never rewrites the past. That property is what makes an ordinary table
-- the right shape here.
--
-- SHAPE NOTES
-- -----------
--   * `id` is TEXT, matching every other client-minted table.
--   * Columns are the three movements the client already knows — `delivery`,
--     `return`, `exchange` — named exactly as `ShipmentMovement`, because
--     `rateFor(rows, gov, movement)` indexes the row BY that string. Renaming
--     them here would break the lookup silently.
--   * "return" is a reserved word in SQL, so it is quoted everywhere.
--   * No `isActive`: the store has never had one, and a governorate that is
--     not shipped to is simply absent. Adding a flag the UI cannot set would
--     be a column that only ever holds its default.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shipping_rates (
  id            TEXT PRIMARY KEY,
  governorate   TEXT        NOT NULL,
  delivery      NUMERIC     NOT NULL DEFAULT 0,
  "return"      NUMERIC     NOT NULL DEFAULT 0,
  exchange      NUMERIC     NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),

  store_id      UUID        NOT NULL,
  device_id     UUID        NOT NULL,
  sync_status   TEXT        NOT NULL DEFAULT 'pending',
  updated_at    BIGINT      NOT NULL DEFAULT 0,
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS shipping_rates_store_idx
  ON public.shipping_rates (store_id);
CREATE INDEX IF NOT EXISTS shipping_rates_updated_idx
  ON public.shipping_rates (store_id, updated_at);

-- One row per governorate per store. The client already refuses a duplicate in
-- `addRow`, but that check runs against whatever THIS browser has loaded — two
-- devices adding "القاهرة" at once would both pass it. Two rows for one place
-- makes "the rate" ambiguous and `rateFor` would silently take the first.
--
-- Case- and whitespace-insensitive, because `rateFor` matches on a normalised
-- key: without `lower(btrim(...))` here, "القاهرة " and "القاهرة" would be two
-- rows that the lookup then treats as one.
CREATE UNIQUE INDEX IF NOT EXISTS shipping_rates_governorate_per_store
  ON public.shipping_rates (store_id, lower(btrim(governorate)))
  WHERE deleted_at IS NULL;

ALTER TABLE public.shipping_rates ENABLE ROW LEVEL SECURITY;

-- Any member of the store may READ the tariff — the POS, الجملة and المرتجعات
-- all price movements from it, and a cashier who cannot read it cannot quote a
-- delivery fee. Only ADMIN/ACCOUNTANT may CHANGE it, matching every other
-- reference table in this schema.
DROP POLICY IF EXISTS select_shipping_rates ON public.shipping_rates;
CREATE POLICY select_shipping_rates ON public.shipping_rates
  FOR SELECT USING (is_store_member(store_id));

DROP POLICY IF EXISTS write_shipping_rates ON public.shipping_rates;
CREATE POLICY write_shipping_rates ON public.shipping_rates
  FOR ALL
  USING      (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']))
  WITH CHECK (has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));

-- Realtime, so a tariff edited in the office reaches the till without a
-- refresh. Guarded because adding a table twice raises.
DO $rt$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.shipping_rates;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $rt$;
