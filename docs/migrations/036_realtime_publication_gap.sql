-- 036 — three subscriptions that were listening to a silent channel.
--
-- ## The gap
--
-- `useRealtimeSync` opens ONE Supabase channel with five `postgres_changes`
-- listeners: `products`, `orders`, `transactions`, `expenses` and
-- `ledger_events`. Postgres only streams a table's changes to Realtime if that
-- table is in the `supabase_realtime` publication, and three of the five were
-- not in it:
--
--     published:      branches, customers, discount_codes, ledger_events,
--                     ledger_lines, products, purchase_invoices,
--                     return_records, shipping_rates, stores, suppliers,
--                     wholesale_clients, wholesale_invoices
--     subscribed but NOT published:  orders, transactions, expenses
--
-- So the subscription was created, the callback was wired, and nothing was
-- ever delivered. A second browser never learned that the first one had taken
-- an order — the row only appeared after a manual «تحديث من السحابة» or a
-- reload. That is the hole PLAN item «Wire pull: SyncService.fetchChanges
-- caller (on boot + on `online` + every 5 min)» exists to close: boot and
-- `online` are covered by `hydrateAll()`, and the continuous leg is this
-- channel — which was only two-fifths connected.
--
-- Adding the three the client already listens for is the whole fix. No new
-- polling loop, no second write path, no client-side reconciliation.
--
-- ## Why this does not widen anything
--
-- Realtime applies each subscriber's own RLS to Postgres Changes: a client
-- receives a row only if its JWT satisfies that table's SELECT policy. All
-- three tables have RLS enabled and are gated on `is_store_member(store_id)`,
-- the same predicate that governs a plain read. Proven with two authenticated
-- clients in different stores: the second saw none of the first's rows.
--
-- The one documented exception is DELETE, where Realtime cannot filter the old
-- row. It does not apply here: this application soft-deletes through
-- `deleted_at` tombstones, so these tables receive UPDATEs, not DELETEs — and
-- the thirteen tables already in the publication carry that same property
-- unchanged.

BEGIN;

ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.expenses;

COMMIT;
