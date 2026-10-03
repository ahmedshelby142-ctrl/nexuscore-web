-- ============================================================================
-- 054 — separate a recovered wasted trip from base delivery
--
-- New orders store the base delivery fee in `shippingFee` and the recovery of
-- one earlier customer-caused wasted trip in `wastedTripCompensation`. Existing
-- rows keep their original shippingFee untouched and receive a safe 0 default.
-- No ledger event, settlement, customer counter, or historical total is
-- rewritten by this migration.
--
-- ORDER OF RELEASE: apply this BEFORE deploying the matching frontends.
--   - `place_order` inserts only the payload keys that are real columns, so a
--     new client against an unmigrated table loses the compensation and the
--     046 equation then refuses the placement;
--   - Mobile selects `wastedTripCompensation` from `orders_operational`.
-- Applied first, nothing changes for the current clients: they send no
-- compensation, the column defaults to 0, and every equation is unchanged.
-- ============================================================================

-- 1. The column. Additive; existing rows read 0.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "wastedTripCompensation" numeric NOT NULL DEFAULT 0;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'orders_wasted_trip_compensation_nonnegative'
       AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_wasted_trip_compensation_nonnegative
      CHECK ("wastedTripCompensation" >= 0);
  END IF;
END;
$constraint$;

-- 2. The validator. 046 owns the complete ledger-event validator; it is rebuilt
-- from the LIVE definition so every later guard survives byte-for-byte, and
-- only these change:
--   order_placed     deposit + COD = total + shipping + compensation
--   order_delivered  may carry an `expense` line (a courier override above the
--                    base fee) and refuses a negative one
-- Each text it replaces must occur EXACTLY once, or nothing is changed: a
-- second occurrence would mean a rule this migration was not written for.
DO $validator$
DECLARE
  v_definition text;
  v_needle     text;
  v_count      int;
  v_needles    text[] := ARRAY[
    'v_total numeric; v_ship numeric; v_dep numeric; v_cod numeric; v_disc numeric; v_goods numeric;',
    'SELECT o."totalAmount", o."shippingFee", o."depositAmount", o."expectedCod",',
    'INTO v_total, v_ship, v_dep, v_cod, v_disc, v_goods',
    'abs(v_dep + v_cod - v_total - v_ship) >= 0.005 THEN',
    'WHEN ''order_delivered''    THEN ARRAY[''cogs'',''receivable_courier'',''revenue'',''payable_courier'',''customer_ltv'']',
    'IF v_rco_neg > 0 OR v_pc_neg > 0 OR v_rev_neg > 0 OR v_cogs_neg > 0 OR ltv NOT IN (0, r) THEN'
  ];
BEGIN
  SELECT pg_get_functiondef('public.ledger_validate_event(jsonb)'::regprocedure)
    INTO v_definition;

  -- Idempotent: already rebuilt by an earlier run of this migration.
  IF position('abs(v_dep + v_cod - v_total - v_ship - v_comp) >= 0.005 THEN' IN v_definition) > 0 THEN
    RAISE NOTICE '054: validator already carries the compensation equation — unchanged';
    RETURN;
  END IF;

  -- The order_delivered guard below relies on 046 declaring v_ex_neg.
  IF position('v_ex_neg int' IN v_definition) = 0 THEN
    RAISE EXCEPTION '054 requires the 046 validator (v_ex_neg is not declared)' USING ERRCODE = '55000';
  END IF;

  FOREACH v_needle IN ARRAY v_needles LOOP
    v_count := (length(v_definition) - length(replace(v_definition, v_needle, ''))) / length(v_needle);
    IF v_count <> 1 THEN
      RAISE EXCEPTION '054 requires the 046 validator shape: expected exactly one "%", found %',
        left(v_needle, 70), v_count USING ERRCODE = '55000';
    END IF;
  END LOOP;

  v_definition := replace(v_definition, v_needles[1],
    'v_total numeric; v_ship numeric; v_comp numeric; v_dep numeric; v_cod numeric; v_disc numeric; v_goods numeric;');
  v_definition := replace(v_definition, v_needles[2],
    'SELECT o."totalAmount", o."shippingFee", COALESCE(o."wastedTripCompensation", 0), o."depositAmount", o."expectedCod",');
  v_definition := replace(v_definition, v_needles[3],
    'INTO v_total, v_ship, v_comp, v_dep, v_cod, v_disc, v_goods');
  v_definition := replace(v_definition, v_needles[4],
    'abs(v_dep + v_cod - v_total - v_ship - v_comp) >= 0.005 THEN');
  v_definition := replace(v_definition, v_needles[5],
    'WHEN ''order_delivered''    THEN ARRAY[''cogs'',''receivable_courier'',''revenue'',''payable_courier'',''customer_ltv'',''expense'']');
  v_definition := replace(v_definition, v_needles[6],
    'IF v_rco_neg > 0 OR v_pc_neg > 0 OR v_rev_neg > 0 OR v_cogs_neg > 0 OR v_ex_neg > 0 OR ltv NOT IN (0, r) THEN');

  EXECUTE v_definition;
END;
$validator$;

-- 3. Mobile's read model. `orders_operational` (047/048) lists its columns, so
-- the new one is appended — last, as CREATE OR REPLACE VIEW requires, which
-- also refuses outright if any existing column differs. The definition is the
-- live one unchanged; compensation is what the customer owes, not a cost, so it
-- is shown to every member like `shippingFee`. Grants and security_barrier are
-- kept as they are.
CREATE OR REPLACE VIEW public.orders_operational WITH (security_barrier = true) AS
SELECT
  id,
  "orderNumber",
  "customerName",
  "customerPhone",
  address,
  governorate,
  city,
  CASE WHEN public.can_read_store_finance(store_id) THEN items ELSE public.strip_line_cost(items) END AS items,
  CASE WHEN public.can_read_store_finance(store_id) THEN "stockItems" ELSE public.strip_line_cost("stockItems") END AS "stockItems",
  "totalAmount",
  "shippingFee",
  "paymentMethod",
  "depositAmount",
  "depositWallet",
  "expectedCod",
  "discountAmount",
  "discountCodeId",
  status,
  "courierId",
  "courierName",
  CASE WHEN public.can_read_store_finance(store_id) THEN "courierFee" ELSE NULL::numeric END AS "courierFee",
  "createdAt",
  "updatedAt",
  updated_at,
  "revenueLogged",
  "customerId",
  "codSettledAt",
  "returnConfirmedAt",
  "returnType",
  return_cause,
  "isExchange",
  original_order_id,
  "wholesaleClientId",
  "shippingPenaltyApplied",
  store_id,
  deleted_at,
  "wastedTripCompensation"
FROM public.orders o
WHERE public.is_store_member(store_id);
