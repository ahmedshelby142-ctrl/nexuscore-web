-- ============================================================================
-- 043 security matrix — I-2 ledger line/event integrity, I-3 product id
--
-- RUN ONLY INSIDE A TRANSACTION THAT ROLLS BACK:
--
--     begin;
--     -- (QA without 043 deployed: paste docs/migrations/043_*.sql here)
--     <this file>
--     rollback;
--
-- Every row it writes is disposable (`qa043-*`) and disappears with the
-- rollback. It was run this way against the live project on 2026-09-27, first
-- with the migration applied inside the transaction (QA), then against the
-- deployed objects; results are recorded in DESKTOP_PRODUCT_AUDIT.md §I.
--
-- Fixtures are QA-STORE's: store db31bbd8 (ADMIN c6b25c1b, POS_ECOMMERCE
-- 32f9d480), foreign ADMIN d626358d of store c58d76ab, and an ADMIN
-- `purchase` event 767d9ac5 that already existed (2 lines). The expected
-- column states the answer; any row whose outcome disagrees is a failure.
--
-- 2026-09-27 (044): the legitimate events use builder-real shapes — 044
-- refuses the synthetic ones this file first used (a sale with no revenue, an
-- order_placed carrying a courier receivable). G and CAVEAT append a VALID
-- sale so that it is 043's same-transaction rule they exercise, not 044's.
-- ============================================================================
set local role authenticated;
create temp table r(n serial, c text, expected text, outcome text);
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
insert into r(c,expected,outcome) select 'I2-A ADMIN purchase via ledger_append','PASS','OK '||ledger_append('{"id":"qa043-A","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"purchase","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","ref_type":"supplier_invoice","ref_id":"QA043","payload":"{}","lines":[{"id":"qa043-A1","account":"stock","subject_id":"b8955a15-724f-4c8f-a963-d4f2ac6afeb9","qty_delta":2,"amount_delta":2000,"unit_cost":1000},{"id":"qa043-A2","account":"wallet","subject_id":"inStoreSafe","qty_delta":0,"amount_delta":-2000}]}'::jsonb);
insert into r(c,expected,outcome) select 'I2-A lines written with it','2','lines='||count(*) from ledger_lines where event_id='qa043-A';
insert into r(c,expected,outcome) select 'I2-F ADMIN expense','PASS','OK '||ledger_append('{"id":"qa043-F1","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"expense","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","payload":"{}","lines":[{"id":"qa043-F1a","account":"wallet","subject_id":"inStoreSafe","amount_delta":-500},{"id":"qa043-F1b","account":"expense","subject_id":"qa","amount_delta":500}]}'::jsonb);
insert into r(c,expected,outcome) select 'I2-F ADMIN supplier_payment','PASS','OK '||ledger_append('{"id":"qa043-F2","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"supplier_payment","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","payload":"{}","lines":[{"id":"qa043-F2a","account":"wallet","subject_id":"inStoreSafe","amount_delta":-300},{"id":"qa043-F2b","account":"payable_supplier","subject_id":"qa","amount_delta":-300}]}'::jsonb);
do $$ begin
  perform public.ledger_append('{"id":"qa043-F3","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"wallet_transfer","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","payload":"{}","lines":[{"id":"qa043-F3a","account":"wallet","subject_id":"inStoreSafe","amount_delta":-100},{"id":"qa043-F3b","account":"wallet","subject_id":"vodafoneCash","amount_delta":100}]}'::jsonb);
  insert into r(c,expected,outcome) values ('I2-F nested PERFORM ledger_append (refund_order_deposit shape)','PASS','OK');
end $$;
do $$ begin
  begin
    insert into ledger_lines(id,event_id,store_id,device_id,account,subject_id,qty_delta,amount_delta,sync_status) values ('qa043-CA','767d9ac5-f0d8-4e60-a622-97467e8d5f6f','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f','e772af92-fa0d-406c-b995-96bb570c6923','wallet','inStoreSafe',0,100,'synced');
    insert into r(c,expected,outcome) values ('I2-C ADMIN line on OLD event','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I2-C ADMIN line on OLD event','REJECT','REJECTED '||sqlstate); end;
end $$;
do $$ begin
  begin
    perform public.ledger_append('{"id":"qa043-G","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"sale","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","payload":"{}","lines":[{"id":"qa043-A1","account":"wallet","subject_id":"inStoreSafe","amount_delta":1},{"id":"qa043-G2","account":"revenue","subject_id":"pos","amount_delta":1}]}'::jsonb);
    insert into r(c,expected,outcome) values ('I2-G append with a bad line','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I2-G append with a bad line','REJECT','REJECTED '||sqlstate); end;
end $$;
insert into r(c,expected,outcome) select 'I2-G no orphan event left behind','0','events='||count(*) from ledger_events where id='qa043-G';
do $$ begin
  begin
    perform public.ledger_append('{"id":"qa043-SUB","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"sale","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","payload":"{}","lines":[{"id":"qa043-SUB1","account":"wallet","subject_id":"inStoreSafe","amount_delta":1},{"id":"qa043-SUB2","account":"revenue","subject_id":"pos","amount_delta":1}]}'::jsonb);
    insert into r(c,expected,outcome) values ('CAVEAT append inside an EXCEPTION subtransaction','REJECT (documented fail-closed)','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('CAVEAT append inside an EXCEPTION subtransaction','REJECT (documented fail-closed)','REJECTED '||sqlstate); end;
end $$;
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
insert into r(c,expected,outcome) select 'I2-B POS sale via ledger_append','PASS','OK '||ledger_append('{"id":"qa043-B","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"sale","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","payload":"{}","lines":[{"id":"qa043-B1","account":"wallet","subject_id":"inStoreSafe","amount_delta":5000},{"id":"qa043-B2","account":"stock","subject_id":"b8955a15-724f-4c8f-a963-d4f2ac6afeb9","qty_delta":-1,"amount_delta":-1000},{"id":"qa043-B3","account":"revenue","subject_id":"pos","amount_delta":5000}]}'::jsonb);
insert into r(c,expected,outcome) select 'I2-F POS order_placed','PASS','OK '||ledger_append('{"id":"qa043-F4","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"order_placed","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","ref_type":"ecommerce_order","ref_id":"QA043","payload":"{}","lines":[{"id":"qa043-F4a","account":"stock","subject_id":"b8955a15-724f-4c8f-a963-d4f2ac6afeb9","qty_delta":-1,"amount_delta":-1000},{"id":"qa043-F4b","account":"wallet","subject_id":"vodafoneCash","amount_delta":700}]}'::jsonb);
insert into r(c,expected,outcome) select 'I2-F POS order_delivered (courier now holds 700)','PASS','OK '||ledger_append('{"id":"qa043-F6","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"order_delivered","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","ref_type":"ecommerce_order","ref_id":"QA043-DELIVERED","payload":"{}","lines":[{"id":"qa043-F6a","account":"receivable_courier","subject_id":"qa","amount_delta":700},{"id":"qa043-F6b","account":"revenue","subject_id":"ecommerce","amount_delta":700}]}'::jsonb);
insert into r(c,expected,outcome) select 'I2-F POS courier_settlement','PASS','OK '||ledger_append('{"id":"qa043-F5","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"courier_settlement","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","payload":"{}","lines":[{"id":"qa043-F5a","account":"receivable_courier","subject_id":"qa","amount_delta":-700},{"id":"qa043-F5b","account":"wallet","subject_id":"inStoreSafe","amount_delta":700}]}'::jsonb);
do $$ begin
  begin
    perform public.ledger_append('{"id":"qa043-B3","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"purchase","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","payload":"{}","lines":[]}'::jsonb);
    insert into r(c,expected,outcome) values ('I2-B POS purchase (role matrix forbids)','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I2-B POS purchase (role matrix forbids)','REJECT','REJECTED '||sqlstate); end;
  begin
    insert into ledger_lines(id,event_id,store_id,device_id,account,subject_id,qty_delta,amount_delta,sync_status) values ('qa043-C','767d9ac5-f0d8-4e60-a622-97467e8d5f6f','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f','e772af92-fa0d-406c-b995-96bb570c6923','wallet','inStoreSafe',0,100,'synced');
    insert into r(c,expected,outcome) values ('I2-C POS line on ADMIN''s old event','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I2-C POS line on ADMIN''s old event','REJECT','REJECTED '||sqlstate); end;
  begin
    insert into ledger_lines(id,event_id,store_id,device_id,account,subject_id,qty_delta,amount_delta,sync_status) values ('qa043-D','767d9ac5-f0d8-4e60-a622-97467e8d5f6f','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f','e772af92-fa0d-406c-b995-96bb570c6923','wallet','inStoreSafe',0,100000000,'synced');
    insert into r(c,expected,outcome) values ('I2-D POS +1,000,000 EGP wallet line on old event','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I2-D POS +1,000,000 EGP wallet line on old event','REJECT','REJECTED '||sqlstate); end;
  begin
    insert into ledger_lines(id,event_id,store_id,device_id,account,subject_id,qty_delta,amount_delta,unit_cost,sync_status) values ('qa043-D2','767d9ac5-f0d8-4e60-a622-97467e8d5f6f','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f','e772af92-fa0d-406c-b995-96bb570c6923','stock','b8955a15-724f-4c8f-a963-d4f2ac6afeb9',100,1,1,'synced');
    insert into r(c,expected,outcome) values ('I2-D/I3-D POS cost-rewriting stock line on old purchase','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I2-D/I3-D POS cost-rewriting stock line on old purchase','REJECT','REJECTED '||sqlstate); end;
end $$;
select set_config('request.jwt.claims','{"sub":"d626358d-4504-412e-9fe1-42dbf861bee2","role":"authenticated"}',true);
do $$ begin
  begin
    insert into ledger_lines(id,event_id,store_id,device_id,account,subject_id,qty_delta,amount_delta,sync_status) values ('qa043-E1','767d9ac5-f0d8-4e60-a622-97467e8d5f6f','db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f','e772af92-fa0d-406c-b995-96bb570c6923','wallet','inStoreSafe',0,100,'synced');
    insert into r(c,expected,outcome) values ('I2-E foreign line tagged with victim store','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I2-E foreign line tagged with victim store','REJECT','REJECTED '||sqlstate); end;
  begin
    insert into ledger_lines(id,event_id,store_id,device_id,account,subject_id,qty_delta,amount_delta,sync_status) values ('qa043-E2','qa043-A','c58d76ab-b71a-4bcb-969b-3cef288fe608','e772af92-fa0d-406c-b995-96bb570c6923','wallet','x',0,100,'synced');
    insert into r(c,expected,outcome) values ('I2-E own-store line on victim event created THIS txn','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I2-E own-store line on victim event created THIS txn','REJECT','REJECTED '||sqlstate); end;
  begin
    perform public.ledger_append('{"id":"qa043-E3","store_id":"db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f","device_id":"e772af92-fa0d-406c-b995-96bb570c6923","kind":"sale","occurred_at":"2026-09-27T00:00:00Z","created_at":"2026-09-27T00:00:00Z","payload":"{}","lines":[]}'::jsonb);
    insert into r(c,expected,outcome) values ('I2-E foreign ledger_append into victim store','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I2-E foreign ledger_append into victim store','REJECT','REJECTED '||sqlstate); end;
end $$;
select set_config('request.jwt.claims','{"sub":"32f9d480-3b2d-47c1-bfa2-0cac96fa4637","role":"authenticated"}',true);
do $$ declare n int; begin
  update products set quantity = quantity - 1, metadata = metadata where id='b8955a15-724f-4c8f-a963-d4f2ac6afeb9';
  get diagnostics n = row_count;
  insert into r(c,expected,outcome) values ('I3-A POS stock-mirror update','PASS (1 row)','rows='||n);
  begin update products set id = id||'-rekeyed' where id='b8955a15-724f-4c8f-a963-d4f2ac6afeb9';
    insert into r(c,expected,outcome) values ('I3-B POS id change','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I3-B POS id change','REJECT','REJECTED '||sqlstate||' '||sqlerrm); end;
  begin update products set "unitPrice" = 1 where id='b8955a15-724f-4c8f-a963-d4f2ac6afeb9';
    insert into r(c,expected,outcome) values ('I3-C POS price change','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I3-C POS price change','REJECT','REJECTED '||sqlstate); end;
  begin update products set store_id = 'c58d76ab-b71a-4bcb-969b-3cef288fe608' where id='b8955a15-724f-4c8f-a963-d4f2ac6afeb9';
    insert into r(c,expected,outcome) values ('I3-E POS store_id change','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I3-E POS store_id change','REJECT','REJECTED '||sqlstate); end;
end $$;
select set_config('request.jwt.claims','{"sub":"d626358d-4504-412e-9fe1-42dbf861bee2","role":"authenticated"}',true);
do $$ declare n int; begin
  update products set quantity = 999 where id='b8955a15-724f-4c8f-a963-d4f2ac6afeb9';
  get diagnostics n = row_count;
  insert into r(c,expected,outcome) values ('I3-F foreign ADMIN stock update','0 rows','rows='||n);
  update products set id = id||'-x' where id='b8955a15-724f-4c8f-a963-d4f2ac6afeb9';
  get diagnostics n = row_count;
  insert into r(c,expected,outcome) values ('I3-F foreign ADMIN id change','0 rows','rows='||n);
end $$;
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
do $$ declare n int; begin
  update products set name = name, "unitPrice" = "unitPrice" + 0, quantity = quantity + 1 where id='b8955a15-724f-4c8f-a963-d4f2ac6afeb9';
  get diagnostics n = row_count;
  insert into r(c,expected,outcome) values ('I3-G ADMIN normal product update','PASS (1 row)','rows='||n);
  begin update products set id = id||'-rekeyed' where id='b8955a15-724f-4c8f-a963-d4f2ac6afeb9';
    insert into r(c,expected,outcome) values ('I3-G ADMIN id change (new invariant)','REJECT','ACCEPTED');
  exception when others then insert into r(c,expected,outcome) values ('I3-G ADMIN id change (new invariant)','REJECT','REJECTED '||sqlstate); end;
end $$;
select set_config('request.jwt.claims','{"sub":"c6b25c1b-8ed9-4566-9e63-e890967270d2","role":"authenticated"}',true);
insert into r(c,expected,outcome) select 'BALANCE till after legit events only','425800 (423000 + 2800)','till='||sum(amount_delta) from ledger_lines where store_id='db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f' and account='wallet' and subject_id='inStoreSafe';
insert into r(c,expected,outcome) select 'BALANCE old purchase event lines unchanged','2','lines='||count(*) from ledger_lines where event_id='767d9ac5-f0d8-4e60-a622-97467e8d5f6f';
insert into r(c,expected,outcome) select 'BALANCE new lines = legit lines only','17','lines='||count(*) from ledger_lines where id like 'qa043-%';
select c, expected, outcome from r order by n;
