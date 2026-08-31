-- ============================================================================
-- 011 — remove the ledger events that were written without their lines
--
-- OPTIONAL. Read this whole header before running it.
--
-- WHAT HAPPENED
-- -------------
-- `ledger_lines.device_id` is `uuid NOT NULL` with no default, and the client
-- was not sending it. So every line insert failed while the event header
-- succeeded, leaving headers that describe an operation which moved no stock
-- and no money. Every event currently in this database is one of those:
--
--   3 × stock_adjustment / opening_balance   (غسول سيرافي ×100, ×10,
--                                             huda beauty fondation ×50)
--   2 × purchase / supplier_invoice FM-0001  (the same receipt, 3 seconds
--                                             apart — the retry)
--
-- That is why every product reads 0 on the shelf: stock is SUM(qty_delta) over
-- `ledger_lines`, and there are no lines.
--
-- WHY DELETING IS SAFE *HERE* AND NOT IN GENERAL
-- ----------------------------------------------
-- The ledger is append-only on purpose — `no_delete_ledger_events` blocks the
-- client from ever removing an event, and that rule should stay. These rows are
-- the one legitimate exception: an event with zero lines contributes zero to
-- every SUM, so removing it changes no balance anywhere. It only removes a
-- phantom entry from the event history and audit views.
--
-- The alternative is to leave them. That is also defensible — they are a
-- truthful record that someone tried to receive stock and the system lost it.
-- Choose deliberately.
--
-- The DELETE below is deliberately scoped to `line_count = 0`. It cannot touch
-- an event that moved anything, even if you run it later by accident.
--
-- AFTER RUNNING THIS
-- ------------------
-- Re-enter the three opening balances and the FM-0001 receipt through the app.
-- With the fix deployed they will write their lines, and the stock numbers will
-- finally appear.
-- ============================================================================

-- Look first. Run this on its own and check the list before deleting anything.
SELECT e.id, e.kind, e.actor, e.ref_type, e.ref_id, e.occurred_at, e.payload
FROM public.ledger_events e
WHERE NOT EXISTS (SELECT 1 FROM public.ledger_lines l WHERE l.event_id = e.id)
ORDER BY e.created_at;

-- Then, if you are satisfied the list contains only line-less events:
--
-- DELETE FROM public.ledger_events e
-- WHERE NOT EXISTS (SELECT 1 FROM public.ledger_lines l WHERE l.event_id = e.id);
