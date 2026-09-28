-- ============================================================================
-- 049 owner-equity matrix — RUN ONLY INSIDE A TRANSACTION THAT ROLLS BACK
--
--     begin;
--     -- (QA before deployment: paste 049 here)
--     <this file, part A or part B>
--     rollback;
--
-- QA-STORE (disposable): ADMIN c6b25c1b…, POS 32f9d480… (re-roled in-txn for
-- MODERATOR). The store already has history, so every figure is measured as a
-- DELTA from a baseline taken at the top of the part. `pg_temp.stmt()` is
-- src/lib/ledger/equity.ts in SQL: the same accounts, kinds and formula.
-- ============================================================================

-- ── shared helpers ─────────────────────────────────────────────────────────
create temp table snap(label text, cap numeric, has_cap boolean, contrib numeric, draws numeric, pl numeric,
  opening numeric, equity numeric, net_assets numeric, revenue numeric);
create temp table r(n serial, probe text, expected text, got text);
grant all on snap, r to authenticated;
grant usage on sequence r_n_seq to authenticated;
create function pg_temp.ln(p_id text, p_acc text, p_subj text, p_amt bigint) returns jsonb language sql as $f$
  select jsonb_build_object('id', p_id, 'account', p_acc, 'subject_id', p_subj, 'amount_delta', p_amt)
$f$;
create function pg_temp.ev(p_kind text, p_id text, p_lines jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('id', p_id, 'store_id', 'db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f',
    'device_id', 'e772af92-fa0d-406c-b995-96bb570c6923', 'kind', p_kind,
    'occurred_at', '2026-09-27T00:00:00Z', 'created_at', '2026-09-27T00:00:00Z', 'payload', '{}',
    'ref_type', 'qa049', 'ref_id', p_id, 'lines', p_lines)
$f$;
-- equity.ts, in SQL (piastres → EGP at the end)
create function pg_temp.bal(p_acc text, p_kind text) returns numeric language sql as $f$
  select coalesce(sum(amount), 0)::numeric from public.ledger_balances('db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', p_acc, p_kind)
$f$;
create function pg_temp.stmt(p_label text) returns void language plpgsql as $f$
declare cap numeric; hascap boolean; capcash numeric; contrib numeric; draws numeric; pl numeric; adj numeric; na numeric;
begin
  select coalesce(sum(amount),0), count(*) > 0 into cap, hascap
    from public.ledger_balances('db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', 'owner_equity', 'owner_capital');
  capcash := pg_temp.bal('wallet', 'owner_capital');
  contrib := pg_temp.bal('owner_equity', 'owner_contribution');
  draws := pg_temp.bal('owner_budget', null);
  pl := pg_temp.bal('revenue', null) - pg_temp.bal('cogs', null) - pg_temp.bal('expense', null);
  adj := pg_temp.bal('stock', 'stock_adjustment') + pg_temp.bal('wallet', 'stock_adjustment') + pg_temp.bal('expense', 'stock_adjustment');
  na := pg_temp.bal('wallet', null) + pg_temp.bal('stock', null) + pg_temp.bal('receivable_client', null)
        + pg_temp.bal('receivable_courier', null) - pg_temp.bal('payable_supplier', null) - pg_temp.bal('payable_courier', null);
  insert into snap values (p_label, cap/100, hascap, contrib/100, draws/100, pl/100,
    (adj - (cap - capcash))/100, (cap + contrib + (adj - (cap - capcash)) + pl - draws)/100, na/100,
    pg_temp.bal('revenue', null)/100);
end $f$;
create function pg_temp.d(p_from text, p_to text) returns jsonb language sql as $f$
  select jsonb_build_object(
    'capital', b.cap, 'capital_recorded', b.has_cap, 'd_contrib', b.contrib - a.contrib,
    'd_draws', b.draws - a.draws, 'd_profit', b.pl - a.pl, 'd_opening', b.opening - a.opening,
    'd_equity', b.equity - a.equity, 'd_net_assets', b.net_assets - a.net_assets, 'd_revenue', b.revenue - a.revenue)
  from snap a, snap b where a.label = p_from and b.label = p_to
$f$;
create function pg_temp.try(p_label text, p_expected text, p_event jsonb) returns void language plpgsql as $f$
begin
  begin
    perform public.ledger_append(p_event);
    insert into r(probe, expected, got) values (p_label, p_expected, 'ACCEPTED');
  exception when others then
    insert into r(probe, expected, got) values (p_label, p_expected, 'REJECTED ' || sqlstate || ' ' || left(sqlerrm, 70));
  end;
end $f$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
select pg_temp.stmt('0 baseline');

-- ── PART A: sole owner, profit (spec §10) ──────────────────────────────────
-- 500,000 opening capital in cash · 100,000 contribution · 300,000 profit ·
-- 80,000 withdrawal  ⇒  capital 500,000, equity +820,000
select public.ledger_append(pg_temp.ev('owner_capital', 'qa049-cap', jsonb_build_array(
  pg_temp.ln('qa049-cap-1', 'owner_equity', 'owner', 50000000), pg_temp.ln('qa049-cap-2', 'wallet', 'inStoreSafe', 50000000))));
select pg_temp.stmt('A1 capital');
select public.ledger_append(pg_temp.ev('owner_contribution', 'qa049-con', jsonb_build_array(
  pg_temp.ln('qa049-con-1', 'owner_equity', 'owner', 10000000), pg_temp.ln('qa049-con-2', 'wallet', 'bankAccount', 10000000))));
select pg_temp.stmt('A2 contribution');
select public.ledger_append(pg_temp.ev('sale', 'qa049-sale', jsonb_build_array(
  pg_temp.ln('qa049-sale-1', 'wallet', 'inStoreSafe', 30000000), pg_temp.ln('qa049-sale-2', 'revenue', 'pos', 30000000))));
select pg_temp.stmt('A3 profit');
select public.ledger_append(pg_temp.ev('owner_draw', 'qa049-draw', jsonb_build_array(
  pg_temp.ln('qa049-draw-1', 'owner_budget', 'owner', 8000000), pg_temp.ln('qa049-draw-2', 'wallet', 'inStoreSafe', -8000000))));
select pg_temp.stmt('A4 withdrawal');
insert into r(probe, expected, got) select 'A total (baseline → end)', 'capital 500000, equity +820000, net assets +820000', pg_temp.d('0 baseline', 'A4 withdrawal')::text;
insert into r(probe, expected, got) select 'A contribution alone', 'equity +100000, revenue +0, profit +0', pg_temp.d('A1 capital', 'A2 contribution')::text;
insert into r(probe, expected, got) select 'A withdrawal alone', 'equity -80000, profit +0, capital unchanged', pg_temp.d('A3 profit', 'A4 withdrawal')::text;
insert into r(probe, expected, got) select 'A profit alone', 'equity +300000, capital unchanged', pg_temp.d('A2 contribution', 'A3 profit')::text;
insert into r(probe, expected, got) select 'baseline (before)', 'capital not recorded (null/false)', (select jsonb_build_object('capital_recorded', has_cap, 'capital', cap) from snap where label='0 baseline')::text;
reset role;
select jsonb_agg(jsonb_build_object('probe', probe, 'expected', expected, 'got', got) order by n) from r;

-- ── PART B (its own rolled-back transaction: helpers + baseline, then this) ──
-- Loss (spec §11): 500,000 capital · 100,000 contribution · 150,000 loss ·
-- 50,000 withdrawal  ⇒  equity +400,000.
-- PART-B-START
select public.ledger_append(pg_temp.ev('owner_capital', 'qa049b-cap', jsonb_build_array(
  pg_temp.ln('qa049b-cap-1', 'owner_equity', 'owner', 50000000), pg_temp.ln('qa049b-cap-2', 'wallet', 'inStoreSafe', 50000000))));
select public.ledger_append(pg_temp.ev('owner_contribution', 'qa049b-con', jsonb_build_array(
  pg_temp.ln('qa049b-con-1', 'owner_equity', 'owner', 10000000), pg_temp.ln('qa049b-con-2', 'wallet', 'inStoreSafe', 10000000))));
select public.ledger_append(pg_temp.ev('expense', 'qa049b-exp', jsonb_build_array(
  pg_temp.ln('qa049b-exp-1', 'wallet', 'inStoreSafe', -15000000), pg_temp.ln('qa049b-exp-2', 'expense', 'rent', 15000000))));
select public.ledger_append(pg_temp.ev('owner_draw', 'qa049b-draw', jsonb_build_array(
  pg_temp.ln('qa049b-draw-1', 'owner_budget', 'owner', 5000000), pg_temp.ln('qa049b-draw-2', 'wallet', 'inStoreSafe', -5000000))));
select pg_temp.stmt('B1 loss scenario');
insert into r(probe, expected, got) select 'B loss total', 'capital 500000, d_profit -150000, equity +400000, net assets +400000', pg_temp.d('0 baseline', 'B1 loss scenario')::text;

-- Historical capital declared WITHOUT cash, for a partner: a reclassification.
select public.ledger_append(pg_temp.ev('owner_capital', 'qa049b-hist', jsonb_build_array(
  pg_temp.ln('qa049b-hist-1', 'owner_equity', 'qa-partner-1', 20000000))));
select pg_temp.stmt('B2 historical partner capital');
insert into r(probe, expected, got) select 'B historical capital (no cash)', 'capital 700000, d_opening -200000, d_equity 0, d_net_assets 0', pg_temp.d('B1 loss scenario', 'B2 historical partner capital')::text;

-- Corrections: down to zero allowed, below zero refused.
-- At TOP LEVEL: an accepted append inside pg_temp.try's exception block is a
-- subtransaction, and 043 refuses lines whose event is not in the top-level one.
select public.ledger_append(pg_temp.ev('owner_capital', 'qa049b-fix', jsonb_build_array(
  pg_temp.ln('qa049b-fix-1', 'owner_equity', 'owner', -10000000), pg_temp.ln('qa049b-fix-2', 'wallet', 'inStoreSafe', -10000000))));
insert into r(probe, expected, got) values ('B correction -100000 of the owner 500000 (top level)', 'ACCEPT', 'ACCEPTED');
select pg_temp.try('B correction below zero (-500000 more)', 'REJECT', pg_temp.ev('owner_capital', 'qa049b-neg', jsonb_build_array(
  pg_temp.ln('qa049b-neg-1', 'owner_equity', 'owner', -50000000))));
-- Shape rules
select pg_temp.try('B contribution cash differs from equity', 'REJECT', pg_temp.ev('owner_contribution', 'qa049b-bad1', jsonb_build_array(
  pg_temp.ln('qa049b-bad1-1', 'owner_equity', 'owner', 1000000), pg_temp.ln('qa049b-bad1-2', 'wallet', 'inStoreSafe', 900000))));
select pg_temp.try('B contribution with no cash', 'REJECT', pg_temp.ev('owner_contribution', 'qa049b-bad2', jsonb_build_array(
  pg_temp.ln('qa049b-bad2-1', 'owner_equity', 'owner', 1000000))));
select pg_temp.try('B capital booked as revenue', 'REJECT', pg_temp.ev('owner_capital', 'qa049b-bad3', jsonb_build_array(
  pg_temp.ln('qa049b-bad3-1', 'owner_equity', 'owner', 1000000), pg_temp.ln('qa049b-bad3-2', 'revenue', 'pos', 1000000))));
select pg_temp.try('B two capital lines in one event', 'REJECT', pg_temp.ev('owner_capital', 'qa049b-bad4', jsonb_build_array(
  pg_temp.ln('qa049b-bad4-1', 'owner_equity', 'owner', 1000000), pg_temp.ln('qa049b-bad4-2', 'owner_equity', 'qa-partner-1', 1000000))));
select pg_temp.try('B owner_equity smuggled into an expense', 'REJECT', pg_temp.ev('expense', 'qa049b-bad5', jsonb_build_array(
  pg_temp.ln('qa049b-bad5-1', 'wallet', 'inStoreSafe', -1000000), pg_temp.ln('qa049b-bad5-2', 'owner_equity', 'owner', 1000000))));
select pg_temp.stmt('B3 after corrections');
insert into r(probe, expected, got) select 'B correction moved equity with its cash', 'd_equity -100000 = d_net_assets -100000, capital 600000', pg_temp.d('B2 historical partner capital', 'B3 after corrections')::text;
insert into r(probe, expected, got) select 'B per owner (capital / contributions / draws)', 'cap:owner 400000, cap:qa-partner-1 200000, con:owner 100000, draw:owner 50000',
  (select jsonb_object_agg(k, v) from (
     select 'cap:' || subject_id k, amount / 100 v from public.ledger_balances('db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', 'owner_equity', 'owner_capital')
     union all select 'con:' || subject_id, amount / 100 from public.ledger_balances('db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', 'owner_equity', 'owner_contribution')
     union all select 'draw:' || subject_id, amount / 100 from public.ledger_balances('db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', 'owner_budget')) x)::text;

-- Who may post / read
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
select pg_temp.try('B POS_ECOMMERCE posts capital', 'REJECT', pg_temp.ev('owner_capital', 'qa049b-pos', jsonb_build_array(
  pg_temp.ln('qa049b-pos-1', 'owner_equity', 'owner', 1000000), pg_temp.ln('qa049b-pos-2', 'wallet', 'inStoreSafe', 1000000))));
select pg_temp.try('B POS_ECOMMERCE posts a contribution', 'REJECT', pg_temp.ev('owner_contribution', 'qa049b-pos2', jsonb_build_array(
  pg_temp.ln('qa049b-pos2-1', 'owner_equity', 'owner', 1000000), pg_temp.ln('qa049b-pos2-2', 'wallet', 'inStoreSafe', 1000000))));
reset role;
update store_members set role = 'ACCOUNTANT' where user_id = '32f9d480-3b2d-47c1-bfa2-0cac96fa4637';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
select pg_temp.try('B ACCOUNTANT posts capital', 'REJECT', pg_temp.ev('owner_capital', 'qa049b-acc', jsonb_build_array(
  pg_temp.ln('qa049b-acc-1', 'owner_equity', 'owner', 1000000))));
insert into r(probe, expected, got) select 'B ACCOUNTANT reads capital', '600000 (finance role reads)', (pg_temp.bal('owner_equity', 'owner_capital') / 100)::text;
reset role;
update store_members set role = 'MODERATOR' where user_id = '32f9d480-3b2d-47c1-bfa2-0cac96fa4637';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
insert into r(probe, expected, got) select 'B MODERATOR reads capital', '0 rows (048)', (select count(*) from public.ledger_balances('db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', 'owner_equity'))::text;
select set_config('request.jwt.claims','{"sub":"d626358d-4504-412e-9fe1-42dbf861bee2","role":"authenticated"}',true);
select pg_temp.try('B foreign ADMIN posts capital into QA-STORE', 'REJECT', pg_temp.ev('owner_capital', 'qa049b-foreign', jsonb_build_array(
  pg_temp.ln('qa049b-foreign-1', 'owner_equity', 'owner', 1000000))));
insert into r(probe, expected, got) select 'B foreign ADMIN reads QA-STORE capital', '0 rows', (select count(*) from public.ledger_balances('db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', 'owner_equity'))::text;
reset role;
select jsonb_agg(jsonb_build_object('probe', probe, 'expected', expected, 'got', got) order by n) from r;
