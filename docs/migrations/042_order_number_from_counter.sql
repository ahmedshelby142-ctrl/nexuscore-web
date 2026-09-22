-- ============================================================================
-- 042 — order numbers come from the store counter, not from the clock
--
-- Safe to re-run: every statement is idempotent.
--
-- WHY THIS EXISTS
-- ---------------
-- Every ecommerce and جملة order was numbered `ECO-` + `Date.now()`, in the
-- browser. That is not a document number, it is a timestamp wearing one:
--
--   * it is drawn from the DEVICE clock, so a till whose clock is a day behind
--     issues numbers that sort before orders taken yesterday, and one set to
--     the wrong year issues numbers nothing will ever sort correctly again;
--   * two devices that place an order in the same millisecond collide, and
--     nothing in the database said no — `orders` had no uniqueness on the
--     number at all, so the second one simply became a second document with
--     the first one's identity;
--   * `ECO-1758123456789` is not a number anybody can read down a phone, which
--     is the entire job of a document number.
--
-- Migration 016 already built the fix for exactly this problem — it is what
-- `FJ-`, `FM-` and `SP-` use. This migration gives orders the same counter and
-- the same last line of defence, and nothing else. `next_document_number` is
-- not touched: it already admits ADMIN / POS_ECOMMERCE / ECOMMERCE_ONLY /
-- ACCOUNTANT, which is precisely the set of roles that may place an order.
--
-- HISTORY IS NOT RENUMBERED
-- -------------------------
-- The 22 existing `ECO-<13 digits>` orders keep the numbers they were shipped,
-- invoiced and spoken about under. Renumbering a document that a customer has
-- in a message is not a migration, it is a lie. The counter starts a NEW
-- sequence alongside them, and the two cannot collide: a counter number is
-- `ECO-0001`, four digits growing to nine at a billion orders, and a legacy
-- one is thirteen digits of milliseconds. Different lengths, no overlap.
-- ============================================================================

-- ── The last line of defence ────────────────────────────────────────────────
--
-- Same shape as `wholesale_invoices_number_per_store` (016). Even if numbering
-- goes wrong again, two orders cannot both be ECO-0001: the second insert
-- fails loudly instead of quietly creating a twin.
--
-- Soft-deleted rows are INCLUDED on purpose. A number is spent once; a
-- cancelled order does not hand its number back, and a partial index would let
-- it be reissued while the original document still exists in every report that
-- reads `deleted_at IS NOT NULL`.
CREATE UNIQUE INDEX IF NOT EXISTS orders_number_per_store
  ON public.orders (store_id, "orderNumber");

-- ── Seed the counter ────────────────────────────────────────────────────────
--
-- From the canonical numbers ONLY. Seeding from `MAX(digits)` the way 016 does
-- would read a 13-digit millisecond timestamp and start this store's counter at
-- 1.75 trillion — `lpad` would hand back `ECO-1758123456790` and the clock
-- would be right back in the numbering, one increment at a time.
--
-- `^ECO-[0-9]{1,9}$` is the counter's own shape: up to a billion orders, which
-- is comfortably more than this sequence will ever reach, and still eight
-- digits short of a millisecond timestamp.
INSERT INTO public.store_counters (store_id, name, value)
SELECT s.id, 'ecommerce_order',
       COALESCE((SELECT MAX(substring(o."orderNumber" FROM 5)::BIGINT)
                 FROM public.orders o
                 WHERE o.store_id = s.id
                   AND o."orderNumber" ~ '^ECO-[0-9]{1,9}$'), 0)
FROM public.stores s
ON CONFLICT (store_id, name) DO NOTHING;
