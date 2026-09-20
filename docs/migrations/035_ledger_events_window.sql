-- 035 — the event reader compares instants too.
--
-- Migration 034 fixed `driver.balances`, which filtered a `text` column with
-- PostgREST's string comparison. `driver.events` has the same defect and was
-- not fixed with it: `ledger_events.occurred_at` is `text`, and
--
--     .gte("occurred_at", from.toISOString())
--     .lt ("occurred_at", to.toISOString())
--     .order("occurred_at", { ascending: false })
--
-- compares and SORTS two different spellings of the same instant as strings:
--
--     2026-09-12T14:18:07.675Z            ISO, what `toISOString()` produces
--     2026-09-12 14:18:07.675957+00       Postgres style, 27 of 321 rows
--
-- and `' ' (0x20) < 'T' (0x54)`.
--
-- Measured on this database, per day, on the store that holds data:
--
--     day           text compare     cast (correct)
--     2026-09-11              14                  0    ← a day with NO events
--     2026-09-12              57                 60
--     2026-09-13              30                 39
--     2026-09-14              45                 47
--
-- Fourteen events attributed to a day that had none, nine missing from the
-- next. And 44 of 167 rows sort out of place, so `.order(…).limit(n)` returns
-- the wrong rows in the wrong order — which is what "آخر ٥٠ تسوية" and the POS
-- return picker are built on.
--
-- This blocks the roadmap's last PHASE 3 item, «21. نظرة عامة — extended date
-- filter (شهر / سنة)»: the dashboard drives that filter through BOTH
-- `balances()` and `events({ from, to })`, so half of it was still wrong.
--
-- Same shape as `ledger_balances`: SECURITY INVOKER, so `select_ledger_events`
-- still decides what the caller may see and nothing is granted that a select
-- did not already allow. It only fixes how the window is compared and how the
-- rows are ordered.

BEGIN;

CREATE OR REPLACE FUNCTION public.ledger_events_page(
  p_store    uuid,
  p_kind     text        DEFAULT NULL,
  p_ref_type text        DEFAULT NULL,
  p_ref_id   text        DEFAULT NULL,
  p_from     timestamptz DEFAULT NULL,
  p_to       timestamptz DEFAULT NULL,
  p_limit    integer     DEFAULT 200
)
RETURNS SETOF public.ledger_events
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.*
  FROM public.ledger_events e
  WHERE e.store_id = p_store
    AND (p_kind     IS NULL OR e.kind     = p_kind)
    AND (p_ref_type IS NULL OR e.ref_type = p_ref_type)
    AND (p_ref_id   IS NULL OR e.ref_id   = p_ref_id)
    AND (p_from IS NULL OR e.occurred_at::timestamptz >= p_from)
    AND (p_to   IS NULL OR e.occurred_at::timestamptz <  p_to)
  -- Newest first, by INSTANT. Sorting the text put 44 of 167 rows in the
  -- wrong place, which a LIMIT then turns into the wrong rows entirely.
  ORDER BY e.occurred_at::timestamptz DESC
  LIMIT GREATEST(COALESCE(p_limit, 200), 0)
$function$;

REVOKE ALL ON FUNCTION public.ledger_events_page(uuid, text, text, text, timestamptz, timestamptz, integer) FROM public;
REVOKE ALL ON FUNCTION public.ledger_events_page(uuid, text, text, text, timestamptz, timestamptz, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.ledger_events_page(uuid, text, text, text, timestamptz, timestamptz, integer) TO authenticated;

COMMIT;
