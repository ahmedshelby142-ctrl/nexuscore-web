-- 029 — `courier` joins the responsibility axis.
--
-- ## Why
--
-- Migration 026 added `return_cause` with three values: customer, shop,
-- unknown. It cannot express the case the shop actually needs to price
-- differently — a delivery that failed through the COURIER's own fault.
--
-- Today that is recorded as one of the other three, and every one of them is
-- wrong:
--
--   * `customer` charges the customer the wasted trip and keeps their deposit,
--     for something they did not do;
--   * `shop`     books the courier's fee as OUR expense and absorbs a cost the
--     shipping company owes us;
--   * `unknown`  does the same as `shop`, and keeps the deposit as well.
--
-- With `courier` the fee lands as `receivable_courier` — the company
-- compensates us — the customer's wasted-trip debt is untouched, and the
-- deposit goes back.
--
-- ## Safety
--
-- Widening a CHECK constraint only. No row changes, no column changes, no
-- policy changes. Every existing value stays valid and keeps its exact
-- accounting: `shippingBorneBy` and `depositForfeitedOn` both leave
-- `unknown` on the pre-026 default.

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_return_cause_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_return_cause_check
  CHECK (return_cause = ANY (ARRAY['customer'::text, 'courier'::text, 'shop'::text, 'unknown'::text]));

ALTER TABLE public.return_records
  DROP CONSTRAINT IF EXISTS return_records_return_cause_check;
ALTER TABLE public.return_records
  ADD CONSTRAINT return_records_return_cause_check
  CHECK (return_cause = ANY (ARRAY['customer'::text, 'courier'::text, 'shop'::text, 'unknown'::text]));
