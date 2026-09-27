-- ============================================================================
-- 045/046 order-deposit matrix — RUN ONLY INSIDE A TRANSACTION THAT ROLLS BACK
--
--     begin;
--     -- (QA before deployment: paste 045 and 046 here)
--     <this file>
--     rollback;
--
-- Owed on every test order: goods 300.00 + shipping 40.00 = 340.00 (unless
-- stated). Legitimate placements run at TOP LEVEL (043); attacks run inside
-- their own blocks so the refusal is recorded and the run continues. Every
-- QA046-* row disappears with the rollback. Generated; run 2026-09-27.
-- ============================================================================
set local role authenticated;
create temp table r(n serial, c text, expected text, outcome text);
create function pg_temp.ord(p_num text, p_price numeric, p_qty numeric, p_disc numeric, p_total numeric, p_ship numeric, p_dep numeric, p_cod numeric, p_name text) returns jsonb language sql as $f$
  select jsonb_strip_nulls(jsonb_build_object('id', gen_random_uuid()::text, 'store_id','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', 'device_id','e772af92-fa0d-406c-b995-96bb570c6923',
    'orderNumber', p_num, 'customerName', p_name, 'customerPhone','01000000000', 'address','QA',
    'items', jsonb_build_array(jsonb_build_object('id','i1','productId','b8955a15-724f-4c8f-a963-d4f2ac6afeb9','productName','QA','quantity',p_qty,'unitPrice',p_price)),
    'stockItems', jsonb_build_array(jsonb_build_object('id','s1','productId','b8955a15-724f-4c8f-a963-d4f2ac6afeb9','productName','QA','quantity',p_qty,'unitPrice',p_price,'unitCost',90)),
    'totalAmount', p_total, 'shippingFee', p_ship, 'discountAmount', p_disc, 'depositAmount', p_dep, 'expectedCod', p_cod,
    'paymentMethod','partial_cod', 'status','pending'))
$f$;
create function pg_temp.pl(p_num text, p_wallet int, p_extra jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('id','qa046-ev-'||p_num,'store_id','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f','device_id','e772af92-fa0d-406c-b995-96bb570c6923','kind','order_placed',
    'occurred_at','2026-09-27T00:00:00Z','created_at','2026-09-27T00:00:00Z','payload','{}',
    'ref_type','ecommerce_order','ref_id',p_num,
    'lines', jsonb_build_array(jsonb_build_object('id','qa046-l1-'||p_num,'account','stock','subject_id','b8955a15-724f-4c8f-a963-d4f2ac6afeb9','qty_delta',-1,'amount_delta',-9000))
      || case when p_wallet <> 0 then jsonb_build_array(jsonb_build_object('id','qa046-l2-'||p_num,'account','wallet','subject_id','vodafoneCash','amount_delta',p_wallet)) else '[]'::jsonb end
      || p_extra)
$f$;
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
create temp table base as select (select coalesce(sum(amount_delta),0) from ledger_lines where store_id='db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f' and account='wallet') wallet_all;
-- ── legitimate placements, POS_ECOMMERCE (owed = 300 goods + 40 shipping = 340.00) ──
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
insert into r(c,expected,outcome) select 'A zero deposit','PASS', case when (x->>'replayed')::boolean then 'REPLAYED ' else 'OK ' end || (x->'order'->>'orderNumber') from (select public.place_order(pg_temp.ord('QA046-A',300,1,0,300,40,0,340,'QA046 customer'),pg_temp.pl('QA046-A',0,'[]')) x) t;
insert into r(c,expected,outcome) select 'B deposit = everything owed (340.00)','PASS', case when (x->>'replayed')::boolean then 'REPLAYED ' else 'OK ' end || (x->'order'->>'orderNumber') from (select public.place_order(pg_temp.ord('QA046-B',300,1,0,300,40,340,0,'QA046 customer'),pg_temp.pl('QA046-B',34000,'[]')) x) t;
insert into r(c,expected,outcome) select 'C deposit below owed (100.00)','PASS', case when (x->>'replayed')::boolean then 'REPLAYED ' else 'OK ' end || (x->'order'->>'orderNumber') from (select public.place_order(pg_temp.ord('QA046-C',300,1,0,300,40,100,240,'QA046 customer'),pg_temp.pl('QA046-C',10000,'[]')) x) t;
insert into r(c,expected,outcome) select 'G decimal (goods 299.99, ship 40.01, deposit 123.45)','PASS', case when (x->>'replayed')::boolean then 'REPLAYED ' else 'OK ' end || (x->'order'->>'orderNumber') from (select public.place_order(pg_temp.ord('QA046-G',299.99,1,0,299.99,40.01,123.45,216.55,'QA046 customer'),pg_temp.pl('QA046-G',12345,'[]')) x) t;
insert into r(c,expected,outcome) select 'G sub-piastre deposit 12.345 booked as JS rounds it (1234)','PASS', case when (x->>'replayed')::boolean then 'REPLAYED ' else 'OK ' end || (x->'order'->>'orderNumber') from (select public.place_order(pg_temp.ord('QA046-G2',300,1,0,300,40,12.345,327.655,'QA046 customer'),pg_temp.pl('QA046-G2',1234,'[]')) x) t;
insert into r(c,expected,outcome) select 'M discounted order (2 x 150 - 30 discount)','PASS', case when (x->>'replayed')::boolean then 'REPLAYED ' else 'OK ' end || (x->'order'->>'orderNumber') from (select public.place_order(pg_temp.ord('QA046-M',150,2,30,270,40,50,260,'QA046 customer'),pg_temp.pl('QA046-M',5000,'[]')) x) t;
insert into r(c,expected,outcome) select 'H duplicate submit: same number again','PASS', case when (x->>'replayed')::boolean then 'REPLAYED ' else 'OK ' end || (x->'order'->>'orderNumber') from (select public.place_order(pg_temp.ord('QA046-C',300,1,0,300,40,100,240,'QA046 customer'),pg_temp.pl('QA046-C',10000,'[]')) x) t;
-- ── legitimate, ADMIN ──
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
insert into r(c,expected,outcome) select 'N ADMIN placement with deposit','PASS', case when (x->>'replayed')::boolean then 'REPLAYED ' else 'OK ' end || (x->'order'->>'orderNumber') from (select public.place_order(pg_temp.ord('QA046-N',300,1,0,300,40,200,140,'QA046 customer'),pg_temp.pl('QA046-N',20000,'[]')) x) t;
-- ── attacks, POS_ECOMMERCE ──
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
do $$ begin
  begin perform public.place_order(pg_temp.ord('QA046-D',300,1,0,300,40,341,-1,'QA046 customer'),pg_temp.pl('QA046-D',34100,'[]'));
    insert into r(c,expected,outcome) values ('D deposit 341.00 on 340.00 owed (COD would be -1)','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('D deposit 341.00 on 340.00 owed (COD would be -1)','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
do $$ begin
  begin perform public.place_order(pg_temp.ord('QA046-D2',300,1,0,300,40,100,240,'QA046 customer'),pg_temp.pl('QA046-D2',34100,'[]'));
    insert into r(c,expected,outcome) values ('D2 honest order (deposit 100) but 341.00 banked','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('D2 honest order (deposit 100) but 341.00 banked','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
do $$ begin
  begin perform public.place_order(pg_temp.ord('QA046-E',300,1,0,300,40,1000000,-999660,'QA046 customer'),pg_temp.pl('QA046-E',100000000,'[]'));
    insert into r(c,expected,outcome) values ('E deposit 1,000,000 on a 340.00 order','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('E deposit 1,000,000 on a 340.00 order','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
do $$ begin
  begin perform public.place_order(pg_temp.ord('QA046-E2',300,1,0,1000000,40,1000000,40,'QA046 customer'),pg_temp.pl('QA046-E2',100000000,'[]'));
    insert into r(c,expected,outcome) values ('E2 total inflated to 1,000,000 over 300.00 of goods','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('E2 total inflated to 1,000,000 over 300.00 of goods','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
do $$ begin
  begin perform public.place_order(pg_temp.ord('QA046-F',300,1,0,300,40,-50,390,'QA046 customer'),pg_temp.pl('QA046-F',-5000,'[]'));
    insert into r(c,expected,outcome) values ('F negative deposit','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('F negative deposit','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
do $$ begin
  begin perform public.place_order(pg_temp.ord('QA046-I',300,1,0,300,40,100,240,'QA046 customer'),pg_temp.pl('QA046-I',10000,'[{"id":"qa046-bad","account":"free_money","subject_id":"x","amount_delta":1}]'));
    insert into r(c,expected,outcome) values ('I ledger refuses (unknown account): no orphan order','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I ledger refuses (unknown account): no orphan order','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
do $$ begin
  begin perform public.place_order(pg_temp.ord('QA046-J',300,1,0,300,40,100,240,null),pg_temp.pl('QA046-J',10000,'[]'));
    insert into r(c,expected,outcome) values ('J order row refused (no customer name): no orphan money','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('J order row refused (no customer name): no orphan money','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.pl('QA046-L1',10000,'[]'));
    insert into r(c,expected,outcome) values ('L1 old path: order_placed with no order row','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('L1 old path: order_placed with no order row','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(jsonb_set(pg_temp.pl('QA046-C',10000,'[]'), '{id}', '"qa046-ev-again"'));
    insert into r(c,expected,outcome) values ('L2 a second placement on an existing order','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('L2 a second placement on an existing order','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
do $$ begin
  begin perform public.place_order(pg_temp.ord('QA046-L3',300,1,0,300,40,100,240,'QA046 customer'),pg_temp.pl('QA046-OTHER',10000,'[]'));
    insert into r(c,expected,outcome) values ('L3 the event names a different order than the row','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('L3 the event names a different order than the row','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
-- ── cross-tenant: the ADMIN of another store ──
select set_config('request.jwt.claims','{"sub":"d626358d-4504-412e-9fe1-42dbf861bee2","role":"authenticated"}',true);
do $$ begin
  begin perform public.place_order(pg_temp.ord('QA046-K',300,1,0,300,40,100,240,'QA046 customer'),pg_temp.pl('QA046-K',10000,'[]'));
    insert into r(c,expected,outcome) values ('K foreign ADMIN places into this store','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('K foreign ADMIN places into this store','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,80)); end;
end $$;
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
insert into r(c,expected,outcome) select 'H exactly one order and one placement for QA046-C','1 order, 1 event, 1 deposit line', (select count(*) from orders where store_id='db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f' and "orderNumber"='QA046-C')||' order, '||(select count(*) from ledger_events where store_id='db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f' and ref_id='QA046-C' and kind='order_placed')||' event, '||(select count(*) from ledger_lines where id='qa046-l2-QA046-C')||' deposit line';
insert into r(c,expected,outcome) select 'NO SIDE EFFECT of any refusal','0 orders, 0 events, 0 lines', (select count(*) from orders where "orderNumber" in ('QA046-D','QA046-D2','QA046-E','QA046-E2','QA046-F','QA046-I','QA046-J','QA046-L1','QA046-L3','QA046-OTHER','QA046-K'))||' orders, '||(select count(*) from ledger_events where ref_id in ('QA046-D','QA046-D2','QA046-E','QA046-E2','QA046-F','QA046-I','QA046-J','QA046-L1','QA046-L3','QA046-OTHER','QA046-K') or id='qa046-ev-again')||' events, '||(select count(*) from ledger_lines where id like 'qa046-%' and event_id not in (select id from ledger_events where ref_id in ('QA046-A','QA046-B','QA046-C','QA046-G','QA046-G2','QA046-M','QA046-N')))||' lines';
insert into r(c,expected,outcome) select 'WALLET moved by exactly the legitimate deposits','34000+10000+12345+1234+5000+20000 = 82579', 'moved='||((select coalesce(sum(amount_delta),0) from ledger_lines where store_id='db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f' and account='wallet') - (select wallet_all from base));
select c, expected, outcome from r order by n;
