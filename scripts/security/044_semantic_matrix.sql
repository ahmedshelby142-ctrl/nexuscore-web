-- ============================================================================
-- 044 semantic-integrity matrix — RUN ONLY INSIDE A TRANSACTION THAT ROLLS BACK
--
--     begin;
--     -- (QA without 044 deployed: paste docs/migrations/044_*.sql here)
--     <this file>
--     rollback;
--
-- Legitimate events: one per kind and shape the builders in src/lib/ledger/
-- write (an order_placed goes through place_order with its order row — 046),
-- appended by the role that really writes them, at TOP LEVEL (043:
-- never inside an EXCEPTION block). Attacks: each inside its own block, so a
-- refusal is recorded and the run continues. Every `qa044-*` row disappears
-- with the rollback. Generated; run 2026-09-27 against the live project.
-- ============================================================================
set local role authenticated;
create temp table r(n serial, c text, expected text, outcome text);
create function pg_temp.e(p_id text, p_kind text, p_ref_type text, p_ref_id text, p_lines jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('id',p_id,'store_id','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f','device_id','e772af92-fa0d-406c-b995-96bb570c6923','kind',p_kind,
    'occurred_at','2026-09-27T00:00:00Z','created_at','2026-09-27T00:00:00Z','payload','{}','ref_type',p_ref_type,'ref_id',p_ref_id,
    'lines', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',p_id||'-'||o,'account',x->>0,
        'subject_id', case when x->>1 = 'P' then 'b8955a15-724f-4c8f-a963-d4f2ac6afeb9' else x->>1 end,
        'amount_delta',(x->>2)::int,'qty_delta',(x->>3)::real,'unit_cost',(x->>4)::int))) from jsonb_array_elements(p_lines) with ordinality t(x,o)),'[]'::jsonb))
$f$;
create function pg_temp.o(p_num text, p_dep numeric) returns jsonb language sql as $f$
  select jsonb_build_object('id', gen_random_uuid()::text, 'store_id','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f', 'orderNumber', p_num,
    'customerName','QA044', 'customerPhone','01000000000', 'address','QA',
    'items', jsonb_build_array(jsonb_build_object('id','i1','productId','b8955a15-724f-4c8f-a963-d4f2ac6afeb9','quantity',1,'unitPrice',300)),
    'totalAmount',300, 'shippingFee',40, 'depositAmount',p_dep, 'expectedCod',340 - p_dep, 'status','pending')
$f$;
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
create temp table base as select (select coalesce(sum(amount_delta),0) from ledger_lines where store_id='db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f' and account='wallet') wallet_all, (select count(*) from ledger_events where store_id='db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f') events, (select count(*) from ledger_lines where store_id='db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f') lines;
-- legitimate, POS_ECOMMERCE
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
insert into r(c,expected,outcome) select 'L sale (POS retail)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L01','sale','pos_sale','QA044','[["stock","P",-1000,-1,null],["cogs","P",1000,null,1000],["wallet","inStoreSafe",3000,null,null],["revenue","pos",3000,null,null],["customer_ltv","qa-cust",3000,null,null]]'));
insert into r(c,expected,outcome) select 'L sale refund (POS return mode, signs flipped)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L02','sale','pos_sale','QA044R','[["stock","P",1000,1,null],["cogs","P",-1000,null,1000],["wallet","inStoreSafe",-3000,null,null],["revenue","pos",-3000,null,null],["customer_ltv","qa-cust",-3000,null,null]]'));
insert into r(c,expected,outcome) select 'L sale wholesale on part-credit + delivery cost','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L03','sale','wholesale_invoice','FJ-QA044','[["stock","P",-1000,-1,null],["cogs","P",1000,null,null],["wallet","vodafoneCash",1000,null,null],["receivable_client","qa-client",2000,null,null],["revenue","wholesale",3000,null,null],["expense","shipping",500,null,null]]'));
insert into r(c,expected,outcome) select 'L sale exchange (in and out in one cart)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L04','sale','exchange','QA044X','[["stock","P",-1000,-1,null],["stock","P",1000,1,null],["cogs","P",1000,null,null],["cogs","P",-1000,null,null],["wallet","inStoreSafe",500,null,null],["revenue","pos",500,null,null]]'));
insert into r(c,expected,outcome) select 'L order_placed with deposit (place_order, 046)','PASS','OK '||(public.place_order(pg_temp.o('ECO-QA044', 50), pg_temp.e('qa044-L05','order_placed','ecommerce_order','ECO-QA044','[["stock","P",-1000,-1,null],["wallet","vodafoneCash",5000,null,null]]'))->'order'->>'orderNumber');
insert into r(c,expected,outcome) select 'L client_payment order top-up within what is owed','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L06','client_payment','ecommerce_order','ECO-1789428055543','[["wallet","instaPay",10000,null,null]]'));
insert into r(c,expected,outcome) select 'L order_delivered (COD = goods + fee - deposit)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L07','order_delivered','ecommerce_order','ECO-QA044','[["cogs","P",1000,null,1000],["receivable_courier","qa-courier",29000,null,null],["revenue","ecommerce",30000,null,null],["payable_courier","qa-courier",4000,null,null],["customer_ltv","qa-cust",30000,null,null]]'));
insert into r(c,expected,outcome) select 'L courier_settlement within what the courier holds','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L08','courier_settlement','courier_batch','QA044','[["wallet","inStoreSafe",25000,null,null],["receivable_courier","qa-courier",-29000,null,null],["payable_courier","qa-courier",-4000,null,null]]'));
insert into r(c,expected,outcome) select 'L order_cancelled refunding the deposit','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L09','order_cancelled','ecommerce_order','ECO-QA044B','[["stock","P",1000,1,null],["wallet","vodafoneCash",-2000,null,null]]'));
insert into r(c,expected,outcome) select 'L order_cancelled keeping the deposit (pending resolution)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L10','order_cancelled','ecommerce_order','ECO-QA044C','[["stock","P",1000,1,null],["revenue","deposit_pending_resolution",2000,null,null],["customer_ltv","qa-cust",2000,null,null]]'));
insert into r(c,expected,outcome) select 'L order_edited (swap)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L11','order_edited','ecommerce_order','ECO-QA044','[["stock","P",-500,-1,null],["stock","P",500,1,null]]'));
insert into r(c,expected,outcome) select 'L order_returned_pending (no lines)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L12','order_returned_pending','ecommerce_order','ECO-QA044','[]'));
insert into r(c,expected,outcome) select 'L return_confirmed (refund from till, shop pays fee)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L13','return_confirmed','ecommerce_order','ECO-QA044','[["stock","P",1000,1,null],["cogs","P",-1000,null,null],["wallet","inStoreSafe",-30000,null,null],["revenue","ecommerce",-30000,null,null],["payable_courier","qa-courier",4000,null,null],["expense","shipping_return",4000,null,null],["customer_ltv","qa-cust",-30000,null,null]]'));
insert into r(c,expected,outcome) select 'L return_confirmed (refund via courier, customer pays fee)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L14','return_confirmed','ecommerce_order','ECO-QA044E','[["stock","P",1000,1,null],["cogs","P",-1000,null,null],["receivable_courier","qa-courier",-30000,null,null],["revenue","ecommerce",-30000,null,null],["payable_courier","qa-courier",4000,null,null],["receivable_courier","qa-courier",4000,null,null]]'));
insert into r(c,expected,outcome) select 'L return_confirmed wholesale (clears debt, refunds rest)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L15','return_confirmed','wholesale_invoice','FJ-QA044','[["stock","P",1000,1,null],["cogs","P",-1000,null,null],["revenue","wholesale",-3000,null,null],["receivable_client","qa-client",-2000,null,null],["wallet","vodafoneCash",-1000,null,null]]'));
insert into r(c,expected,outcome) select 'L rto_confirmed (shop fee, deposit refunded)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L16','rto_confirmed','ecommerce_order','ECO-QA044F','[["stock","P",1000,1,null],["payable_courier","qa-courier",4000,null,null],["expense","shipping_return",4000,null,null],["wallet","vodafoneCash",-5000,null,null]]'));
insert into r(c,expected,outcome) select 'L client_payment wholesale','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L17','client_payment','wholesale_invoice','FJ-QA044','[["wallet","inStoreSafe",1000,null,null],["receivable_client","qa-client",-1000,null,null]]'));
-- legitimate, ADMIN-only kinds
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
insert into r(c,expected,outcome) select 'L purchase part-paid','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L18','purchase','supplier_invoice','FM-QA044','[["stock","P",2000,2,1000],["wallet","inStoreSafe",-500,null,null],["payable_supplier","qa-supplier",1500,null,null]]'));
insert into r(c,expected,outcome) select 'L purchase = supplier return (cash back)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L19','purchase','supplier_return','FM-QA044','[["stock","P",-1000,-1,1000],["payable_supplier","qa-supplier",-500,null,null],["wallet","inStoreSafe",500,null,null]]'));
insert into r(c,expected,outcome) select 'L supplier_payment','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L20','supplier_payment','supplier_payment',null,'[["wallet","inStoreSafe",-1000,null,null],["payable_supplier","qa-supplier",-1000,null,null]]'));
insert into r(c,expected,outcome) select 'L expense','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L21','expense','expense',null,'[["expense","rent",700,null,null],["wallet","inStoreSafe",-700,null,null]]'));
insert into r(c,expected,outcome) select 'L payroll','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L22','payroll','payroll',null,'[["expense","salaries",800,null,null],["wallet","inStoreSafe",-800,null,null]]'));
insert into r(c,expected,outcome) select 'L wallet_transfer','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L23','wallet_transfer','wallet_transfer',null,'[["wallet","inStoreSafe",-900,null,null],["wallet","bankAccount",900,null,null]]'));
insert into r(c,expected,outcome) select 'L owner_draw','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L24','owner_draw','owner_draw','owner','[["owner_budget","owner",600,null,null],["wallet","inStoreSafe",-600,null,null]]'));
insert into r(c,expected,outcome) select 'L stock_adjustment count (shrinkage)','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L25','stock_adjustment','stock_audit',null,'[["stock","P",-1000,-1,null],["expense","shrinkage",1000,null,null]]'));
insert into r(c,expected,outcome) select 'L stock_adjustment opening stock','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L26','stock_adjustment','opening_balance','b8955a15-724f-4c8f-a963-d4f2ac6afeb9','[["stock","P",5000,5,null]]'));
insert into r(c,expected,outcome) select 'L stock_adjustment wallet opening balance','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L27','stock_adjustment','opening_balance','bankAccount','[["wallet","bankAccount",1000,null,null]]'));
insert into r(c,expected,outcome) select 'L stock_adjustment product-edit qty correction','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L28','stock_adjustment','product_edit',null,'[["stock","P",0,2,0]]'));
insert into r(c,expected,outcome) select 'L deposit_refunded','PASS','OK '||public.ledger_append(pg_temp.e('qa044-L29','deposit_refunded','ecommerce_order','ECO-QA044C','[["wallet","vodafoneCash",-1000,null,null],["revenue","deposit_pending_resolution",-1000,null,null],["customer_ltv","qa-cust",-1000,null,null]]'));
-- attacks, POS_ECOMMERCE
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A01','sale',null,null,'[["wallet","inStoreSafe",100000000,null,null]]'));
    insert into r(c,expected,outcome) values ('A sale = lone wallet +1,000,000 EGP','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A sale = lone wallet +1,000,000 EGP','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A02','bonus',null,null,'[["wallet","inStoreSafe",100000000,null,null]]'));
    insert into r(c,expected,outcome) values ('A invented kind bonus','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A invented kind bonus','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A03','sale',null,null,'[["free_money","x",100000000,null,null]]'));
    insert into r(c,expected,outcome) values ('A invented account free_money','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A invented account free_money','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A04','order_delivered','ecommerce_order','ECO-QA044Z','[["receivable_courier","qa-courier2",100000000,null,null]]'));
    insert into r(c,expected,outcome) values ('A order_delivered COD +1M with no goods','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A order_delivered COD +1M with no goods','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A05','courier_settlement',null,null,'[["wallet","inStoreSafe",100000000,null,null],["receivable_courier","qa-empty",-100000000,null,null]]'));
    insert into r(c,expected,outcome) values ('A courier_settlement +1M from a courier holding 0','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A courier_settlement +1M from a courier holding 0','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A06','client_payment','ecommerce_order','NO-SUCH-ORDER','[["wallet","inStoreSafe",100000000,null,null]]'));
    insert into r(c,expected,outcome) values ('A top-up on an order that does not exist','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A top-up on an order that does not exist','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A07','client_payment','ecommerce_order','ECO-1789428055543','[["wallet","inStoreSafe",79001,null,null]]'));
    insert into r(c,expected,outcome) values ('A top-up above what is owed on a real order','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A top-up above what is owed on a real order','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A08','client_payment',null,null,'[["wallet","inStoreSafe",5000,null,null]]'));
    insert into r(c,expected,outcome) values ('A top-up with no order reference','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A top-up with no order reference','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A09','sale',null,null,'[["wallet","my-pocket",3000,null,null],["revenue","pos",3000,null,null]]'));
    insert into r(c,expected,outcome) values ('A wallet line to a wallet that does not exist','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A wallet line to a wallet that does not exist','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A10','sale',null,null,'[["wallet","inStoreSafe",100000000,null,null],["revenue","pos",3000,null,null]]'));
    insert into r(c,expected,outcome) values ('A sale where revenue does not match money in','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A sale where revenue does not match money in','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A11','order_placed',null,null,'[["stock","P",-1000,-1,null],["wallet","inStoreSafe",-5000,null,null]]'));
    insert into r(c,expected,outcome) values ('A order_placed paying a deposit OUT','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A order_placed paying a deposit OUT','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A12','order_placed',null,null,'[["wallet","inStoreSafe",5000,null,null]]'));
    insert into r(c,expected,outcome) values ('A order_placed with no goods (cash only)','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A order_placed with no goods (cash only)','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A13','order_placed',null,null,'[["stock","P",-1000,-1,null],["revenue","pos",5000,null,null]]'));
    insert into r(c,expected,outcome) values ('A order_placed moving revenue','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A order_placed moving revenue','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A14','sale',null,null,'[["stock","P",1000,-1,null],["wallet","inStoreSafe",3000,null,null],["revenue","pos",3000,null,null]]'));
    insert into r(c,expected,outcome) values ('A stock line signed against its value','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A stock line signed against its value','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A15','sale',null,null,'[["wallet","inStoreSafe",3000,5,null],["revenue","pos",3000,null,null]]'));
    insert into r(c,expected,outcome) values ('A quantity on a wallet line','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A quantity on a wallet line','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A16','sale',null,null,'[["wallet","inStoreSafe",3000,null,10],["revenue","pos",3000,null,null]]'));
    insert into r(c,expected,outcome) values ('A unit cost on a wallet line','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A unit cost on a wallet line','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A17','return_confirmed',null,null,'[["stock","P",1000,1,null],["wallet","inStoreSafe",30000,null,null],["revenue","ecommerce",30000,null,null]]'));
    insert into r(c,expected,outcome) values ('A return that pays money IN','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A return that pays money IN','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A18','rto_confirmed',null,null,'[["stock","P",1000,1,null],["wallet","inStoreSafe",5000,null,null]]'));
    insert into r(c,expected,outcome) values ('A rto that pays money IN','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A rto that pays money IN','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A19','order_cancelled',null,null,'[["stock","P",1000,1,null],["wallet","inStoreSafe",5000,null,null]]'));
    insert into r(c,expected,outcome) values ('A cancel that pays money IN','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A cancel that pays money IN','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A20','order_returned_pending',null,null,'[["wallet","inStoreSafe",5000,null,null]]'));
    insert into r(c,expected,outcome) values ('A pending moving money','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A pending moving money','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
insert into r(c,expected,outcome) select 'L order_placed with deposit (for A21) (place_order, 046)','PASS','OK '||(public.place_order(pg_temp.o('ECO-QA044D', 50), pg_temp.e('qa044-L30','order_placed','ecommerce_order','ECO-QA044D','[["stock","P",-1000,-1,null],["wallet","vodafoneCash",5000,null,null]]'))->'order'->>'orderNumber');
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A21','order_delivered','ecommerce_order','ECO-QA044D','[["receivable_courier","qa-courier",34000,null,null],["revenue","ecommerce",30000,null,null],["payable_courier","qa-courier",4000,null,null]]'));
    insert into r(c,expected,outcome) values ('A delivery that ignores the deposit already taken','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A delivery that ignores the deposit already taken','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A22','stock_adjustment','opening_balance','b8955a15-724f-4c8f-a963-d4f2ac6afeb9','[["stock","P",5000,5,null]]'));
    insert into r(c,expected,outcome) values ('A stock_adjustment by POS (role matrix)','REJECT 42501','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A stock_adjustment by POS (role matrix)','REJECT 42501','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin insert into ledger_lines(id,event_id,store_id,device_id,account,subject_id,qty_delta,amount_delta,sync_status) values ('qa044-A23','767d9ac5-f0d8-4e60-a622-97467e8d5f6f','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f','e772af92-fa0d-406c-b995-96bb570c6923','wallet','inStoreSafe',0,100000000,'synced');
    insert into r(c,expected,outcome) values ('A 043 still in force: line on an OLD event','REJECT 42501','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A 043 still in force: line on an OLD event','REJECT 42501','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
-- attacks, ADMIN: semantically invalid is invalid for everyone
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A24','purchase',null,null,'[["stock","P",2000,2,null],["wallet","inStoreSafe",-500,null,null]]'));
    insert into r(c,expected,outcome) values ('A ADMIN purchase paying less than the stock it books','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A ADMIN purchase paying less than the stock it books','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A25','wallet_transfer',null,null,'[["wallet","inStoreSafe",-1000,null,null],["wallet","bankAccount",2000,null,null]]'));
    insert into r(c,expected,outcome) values ('A ADMIN wallet_transfer that creates money','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A ADMIN wallet_transfer that creates money','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A26','expense',null,null,'[["expense","rent",-700,null,null],["wallet","inStoreSafe",700,null,null]]'));
    insert into r(c,expected,outcome) values ('A ADMIN expense that pays money IN','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A ADMIN expense that pays money IN','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A27','stock_adjustment','stock_audit',null,'[["wallet","inStoreSafe",100000000,null,null]]'));
    insert into r(c,expected,outcome) values ('A ADMIN wallet opening balance on a non-opening adjustment','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A ADMIN wallet opening balance on a non-opening adjustment','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A28','stock_adjustment','opening_balance',null,'[["wallet","inStoreSafe",1000,null,null],["stock","P",1000,1,null]]'));
    insert into r(c,expected,outcome) values ('A ADMIN wallet opening balance bundled with stock','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A ADMIN wallet opening balance bundled with stock','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A29','supplier_payment',null,null,'[["wallet","inStoreSafe",1000,null,null],["payable_supplier","qa-supplier",1000,null,null]]'));
    insert into r(c,expected,outcome) values ('A ADMIN supplier_payment that pays money IN','REJECT 23514','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A ADMIN supplier_payment that pays money IN','REJECT 23514','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
-- attacks, foreign ADMIN (another store)
select set_config('request.jwt.claims','{"sub":"d626358d-4504-412e-9fe1-42dbf861bee2","role":"authenticated"}',true);
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A30','sale',null,null,'[["wallet","inStoreSafe",3000,null,null],["revenue","pos",3000,null,null]]'));
    insert into r(c,expected,outcome) values ('A cross-tenant: valid sale into another store','REJECT 42501','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A cross-tenant: valid sale into another store','REJECT 42501','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
do $$ begin
  begin perform public.ledger_append(pg_temp.e('qa044-A31','courier_settlement',null,null,'[["wallet","inStoreSafe",1000,null,null],["receivable_courier","qa-courier",-1000,null,null]]'));
    insert into r(c,expected,outcome) values ('A cross-tenant: settle a courier of another store','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('A cross-tenant: settle a courier of another store','REJECT','REJECTED '||sqlstate||' '||left(sqlerrm,70)); end;
end $$;
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
insert into r(c,expected,outcome) select 'NO PARTIAL WRITE: refused events','0 events, 0 lines','events='||(select count(*) from ledger_events where id like 'qa044-A%')||', lines='||(select count(*) from ledger_lines where id like 'qa044-A%');
insert into r(c,expected,outcome) select 'BALANCE store wallets moved only by legitimate lines','0','drift='||((select coalesce(sum(amount_delta),0) from ledger_lines where store_id='db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f' and account='wallet') - (select wallet_all from base) - (select coalesce(sum(amount_delta),0) from ledger_lines where id like 'qa044-L%' and account='wallet'));
insert into r(c,expected,outcome) select 'BALANCE every legitimate event landed with all its lines','30 events, 90 lines','events='||(select count(*) from ledger_events where id like 'qa044-L%')||', lines='||(select count(*) from ledger_lines where id like 'qa044-L%');
select c, expected, outcome from r order by n;
