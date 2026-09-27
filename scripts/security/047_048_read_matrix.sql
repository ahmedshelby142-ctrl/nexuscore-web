-- ============================================================================
-- 047/048 read-security matrix — RUN ONLY INSIDE A TRANSACTION THAT ROLLS BACK
--
--     begin;
--     -- (QA before deployment: paste 047 and 048 here)
--     <this file>
--     rollback;
--
-- QA-STORE (disposable): ADMIN c6b25c1b…, POS 32f9d480…. The POS member is
-- re-roled INSIDE the transaction to act as ACCOUNTANT / ECOMMERCE_ONLY /
-- MODERATOR; the rollback restores it. A foreign store's ADMIN and `anon` are
-- the tenant/anonymous probes. Every probe reads through the caller's JWT —
-- the same path the authenticated public client takes.
-- ============================================================================
create temp table r(n serial, who text, probe text, got text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;

-- Count what a statement returns for the CURRENT caller; an error is recorded
-- as its SQLSTATE rather than aborting the run.
create function pg_temp.cnt(q text) returns text language plpgsql as $f$
declare v bigint;
begin
  execute q into v;
  return coalesce(v, 0)::text;
exception when others then
  return 'ERR ' || sqlstate;
end $f$;
grant execute on function pg_temp.cnt(text) to authenticated, anon;

create function pg_temp.probe(p_who text) returns void language plpgsql as $f$
declare s constant text := '''db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f''';
begin
  insert into r(who, probe, got) values
  (p_who, 'ledger_lines rows',                pg_temp.cnt('select count(*) from ledger_lines')),
  (p_who, 'ledger_lines with unit_cost',      pg_temp.cnt('select count(*) from ledger_lines where unit_cost is not null')),
  (p_who, 'ledger_events rows',               pg_temp.cnt('select count(*) from ledger_events')),
  (p_who, 'ledger_balances wallet rows',      pg_temp.cnt('select count(*) from ledger_balances('||s||',''wallet'')')),
  (p_who, 'ledger_events_page rows',          pg_temp.cnt('select count(*) from ledger_events_page('||s||')')),
  (p_who, 'orders (table) rows',              pg_temp.cnt('select count(*) from orders')),
  (p_who, 'orders (table) with cogsAmount',   pg_temp.cnt('select count(*) from orders where "cogsAmount" is not null')),
  (p_who, 'orders_operational rows',          pg_temp.cnt('select count(*) from orders_operational')),
  (p_who, 'orders_operational line unitCost', pg_temp.cnt('select count(*) from orders_operational where "stockItems"::text like ''%unitCost%'' or items::text like ''%unitCost%''')),
  (p_who, 'orders_operational courierFee set',pg_temp.cnt('select count(*) from orders_operational where "courierFee" is not null')),
  (p_who, 'orders_operational has cogsAmount column', pg_temp.cnt('select count(*) from information_schema.columns where table_name=''orders_operational'' and column_name=''cogsAmount''')),
  (p_who, 'OP reader: pending queue',         pg_temp.cnt('select count(*) from orders_operational where status=''pending'' and deleted_at is null')),
  (p_who, 'OP reader: search ECO',            pg_temp.cnt('select count(*) from orders_operational where "orderNumber" ilike ''%ECO%'' or "customerName" ilike ''%ECO%''')),
  (p_who, 'OP reader: waiting-order contains',pg_temp.cnt('select count(*) from orders_operational where "stockItems" @> ''[{"productId":"b8955a15-724f-4c8f-a963-d4f2ac6afeb9"}]'' or items @> ''[{"productId":"b8955a15-724f-4c8f-a963-d4f2ac6afeb9"}]''')),
  (p_who, 'OP reader: selling fields intact', pg_temp.cnt('select count(*) from orders_operational where "totalAmount" is not null and "expectedCod" is not null and status is not null and "orderNumber" is not null')),
  (p_who, 'mobile_stock_quantities rows',     pg_temp.cnt('select count(*) from mobile_stock_quantities((select array_agg(id) from products))')),
  -- Same product, different quantity. Only meaningful where the caller can
  -- still read ledger_balances (a Moderator gets 0 rows there by design).
  (p_who, 'stock qty = ledger_balances qty (mismatches)', pg_temp.cnt('select count(*) from mobile_stock_quantities((select array_agg(id) from products)) q join (select subject_id, qty from ledger_balances('||s||',''stock'')) b on b.subject_id = q.product_id where q.qty is distinct from b.qty')),
  (p_who, 'stock qty matched products',       pg_temp.cnt('select count(*) from mobile_stock_quantities((select array_agg(id) from products)) q join (select subject_id, qty from ledger_balances('||s||',''stock'')) b on b.subject_id = q.product_id where q.qty = b.qty')),
  (p_who, 'mobile_order_timeline rows (all ECO orders)', pg_temp.cnt('select count(*) from orders_operational o cross join lateral mobile_order_timeline(o."orderNumber")')),
  (p_who, 'mobile_shortages rows',            pg_temp.cnt('select count(*) from mobile_shortages('||s||')')),
  (p_who, 'store_activity readable',          pg_temp.cnt('select count(*) from store_activity')),
  (p_who, 'products rows',                    pg_temp.cnt('select count(*) from products')),
  (p_who, 'customers rows',                   pg_temp.cnt('select count(*) from customers')),
  (p_who, 'couriers rows',                    pg_temp.cnt('select count(*) from couriers')),
  (p_who, 'expenses',                         pg_temp.cnt('select count(*) from expenses')),
  (p_who, 'transactions',                     pg_temp.cnt('select count(*) from transactions')),
  (p_who, 'purchase_invoices',                pg_temp.cnt('select count(*) from purchase_invoices')),
  (p_who, 'suppliers',                        pg_temp.cnt('select count(*) from suppliers')),
  (p_who, 'wholesale_invoices',               pg_temp.cnt('select count(*) from wholesale_invoices')),
  (p_who, 'wholesale_clients',                pg_temp.cnt('select count(*) from wholesale_clients')),
  (p_who, 'courier_claims',                   pg_temp.cnt('select count(*) from courier_claims')),
  (p_who, 'return_records',                   pg_temp.cnt('select count(*) from return_records')),
  (p_who, 'discount_codes',                   pg_temp.cnt('select count(*) from discount_codes')),
  (p_who, 'store_members rows visible',       pg_temp.cnt('select count(*) from store_members')),
  (p_who, 'list_store_members rows',          pg_temp.cnt('select count(*) from list_store_members()')),
  -- The value must be CONSUMED, or the planner never calls the function.
  (p_who, 'owner_financial_summary',          pg_temp.cnt('select count(*) from (select owner_financial_summary('||s||', null, null)::text t) x where t is not null')),
  (p_who, 'other stores'' orders via view',  pg_temp.cnt('select count(*) from orders_operational where store_id <> '||s));
end $f$;
grant execute on function pg_temp.probe(text) to authenticated, anon;

-- ── the activity signal fires, and placing an order still works ────────────
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
insert into r(who, probe, got) select 'POS_ECOMMERCE', 'store_activity before placement', count(*)::text from store_activity;
insert into r(who, probe, got)
select 'POS_ECOMMERCE', 'place_order still works (047 triggers in the txn)',
  (public.place_order(
    jsonb_build_object('id', gen_random_uuid()::text, 'store_id','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', 'device_id','e772af92-fa0d-406c-b995-96bb570c6923',
      'orderNumber','QA048-A', 'customerName','QA048', 'customerPhone','01000000000', 'address','QA',
      'items', jsonb_build_array(jsonb_build_object('id','i1','productId','b8955a15-724f-4c8f-a963-d4f2ac6afeb9','productName','QA','quantity',1,'unitPrice',300)),
      'stockItems', jsonb_build_array(jsonb_build_object('id','s1','productId','b8955a15-724f-4c8f-a963-d4f2ac6afeb9','productName','QA','quantity',1,'unitPrice',300,'unitCost',90)),
      'totalAmount',300,'shippingFee',40,'discountAmount',0,'depositAmount',0,'expectedCod',340,'paymentMethod','partial_cod','status','pending'),
    jsonb_build_object('id','qa048-ev-A','store_id','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f','device_id','e772af92-fa0d-406c-b995-96bb570c6923','kind','order_placed',
      'occurred_at','2026-09-27T00:00:00Z','created_at','2026-09-27T00:00:00Z','payload','{}','ref_type','ecommerce_order','ref_id','QA048-A',
      'lines', jsonb_build_array(jsonb_build_object('id','qa048-l1','account','stock','subject_id','b8955a15-724f-4c8f-a963-d4f2ac6afeb9','qty_delta',-1,'amount_delta',-9000)))
  ) -> 'order' ->> 'orderNumber');
insert into r(who, probe, got) select 'POS_ECOMMERCE', 'store_activity after placement (by source)',
  string_agg(source || '=' || n, ',' order by source) from (select source, count(*) n from store_activity group by source) x;

-- ── each role ──────────────────────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
select pg_temp.probe('ADMIN');
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
select pg_temp.probe('POS_ECOMMERCE');
reset role;
update store_members set role='ACCOUNTANT' where user_id='32f9d480-3b2d-47c1-bfa2-0cac96fa4637';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
select pg_temp.probe('ACCOUNTANT');
reset role;
update store_members set role='ECOMMERCE_ONLY' where user_id='32f9d480-3b2d-47c1-bfa2-0cac96fa4637';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
select pg_temp.probe('ECOMMERCE_ONLY');
reset role;
update store_members set role='MODERATOR' where user_id='32f9d480-3b2d-47c1-bfa2-0cac96fa4637';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
select pg_temp.probe('MODERATOR');
-- A Moderator cannot write the activity table or reach another store's.
insert into r(who, probe, got) select 'MODERATOR', 'insert into store_activity',
  pg_temp.cnt('with x as (insert into store_activity(store_id, source) values (''db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f'',''orders'') returning 1) select count(*) from x');
-- ── licence lapse must not hand the ledger back (has_role would have) ──────
reset role;
update store_licenses set valid_until = now() - interval '30 days', status = 'expired' where store_id = 'db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
insert into r(who, probe, got) select 'MODERATOR (licence lapsed)', 'ledger_lines rows', pg_temp.cnt('select count(*) from ledger_lines');
insert into r(who, probe, got) select 'MODERATOR (licence lapsed)', 'expenses', pg_temp.cnt('select count(*) from expenses');
-- ── cross-tenant and anonymous ─────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"d626358d-4504-412e-9fe1-42dbf861bee2","role":"authenticated"}',true);
insert into r(who, probe, got) select 'FOREIGN ADMIN', 'QA-STORE ledger_lines', pg_temp.cnt('select count(*) from ledger_lines where store_id=''db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f''');
insert into r(who, probe, got) select 'FOREIGN ADMIN', 'QA-STORE orders_operational', pg_temp.cnt('select count(*) from orders_operational where store_id=''db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f''');
insert into r(who, probe, got) select 'FOREIGN ADMIN', 'QA-STORE stock via mobile_stock_quantities', pg_temp.cnt('select count(*) from mobile_stock_quantities(array[''b8955a15-724f-4c8f-a963-d4f2ac6afeb9''])');
insert into r(who, probe, got) select 'FOREIGN ADMIN', 'QA-STORE timeline via mobile_order_timeline', pg_temp.cnt('select count(*) from mobile_order_timeline(''QA048-A'')');
insert into r(who, probe, got) select 'FOREIGN ADMIN', 'QA-STORE staff via list_store_members', pg_temp.cnt('select count(*) from list_store_members() where user_id in (''c6b25c1b-8ed9-4566-9e63-e890967270d2'',''32f9d480-3b2d-47c1-bfa2-0cac96fa4637'')');
insert into r(who, probe, got) select 'FOREIGN ADMIN', 'QA-STORE store_activity', pg_temp.cnt('select count(*) from store_activity where store_id=''db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f''');
reset role;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
insert into r(who, probe, got) select 'ANON', 'orders_operational', pg_temp.cnt('select count(*) from orders_operational');
insert into r(who, probe, got) select 'ANON', 'mobile_stock_quantities', pg_temp.cnt('select count(*) from mobile_stock_quantities(array[''b8955a15-724f-4c8f-a963-d4f2ac6afeb9''])');
insert into r(who, probe, got) select 'ANON', 'mobile_order_timeline', pg_temp.cnt('select count(*) from mobile_order_timeline(''QA048-A'')');
insert into r(who, probe, got) select 'ANON', 'ledger_lines', pg_temp.cnt('select count(*) from ledger_lines');
insert into r(who, probe, got) select 'ANON', 'store_activity', pg_temp.cnt('select count(*) from store_activity');
insert into r(who, probe, got) select 'ANON', 'list_store_members', pg_temp.cnt('select count(*) from list_store_members()');
reset role;
select jsonb_object_agg(who, probes) from (
  select who, jsonb_object_agg(probe, got) probes from r group by who
) x;
