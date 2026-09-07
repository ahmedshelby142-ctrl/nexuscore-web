-- ============================================================================
-- Role write-permission probe — the authoritative check for the role matrix.
--
--   Run against the project's database as a superuser / service role, e.g. the
--   Supabase SQL editor. Set `qa` to a DISPOSABLE store. It touches nothing:
--   the block always ends in RAISE, so the whole transaction rolls back, and
--   the results come back in the error message.
--
-- WHY THIS EXISTS
-- ---------------
-- The client can hide a screen; only Postgres can refuse a write. The roles
-- audit of 2026-09-07 found six tables where a role-gated `ALL` policy sat
-- beside a permissive INSERT/UPDATE policy keyed on `is_store_member` — and
-- because Postgres OR-s permissive policies, the role gate governed nothing but
-- DELETE. A POS_ECOMMERCE till operator could create products and rewrite every
-- price in the shop, from a screen they cannot even open.
--
-- Migration 022 closed it. This probe is how that was proven, and how to prove
-- it again after any change to policies, roles or the products trigger.
--
-- HOW IT WORKS
-- ------------
-- It borrows one existing member of the QA store, sets their role to the one
-- under test, then impersonates them with `request.jwt.claims` and tries a
-- write against every role-sensitive table. Nothing persists.
--
-- ONE ROLE PER RUN, DELIBERATELY. `has_role` and `is_store_member` are STABLE,
-- so Postgres may reuse a cached result if the role changes mid-transaction —
-- a loop over four roles reports the FIRST role's answers four times. Change
-- the literal on the marked line and run it again for each role.
--
-- EXPECTED RESULTS (verified 2026-09-07, after migration 022)
-- -----------------------------------------------------------
--   ADMIN           product+ price+ expense+ order+ supplier+ customer+
--                   discount+ branch+ delete+ setRole+ xtenant- xread=0 licence0
--   ACCOUNTANT      product+ price+ expense+ order- supplier+ customer-
--                   discount- branch+ setRole0 xtenant- xread=0
--   POS_ECOMMERCE   product- price- mirror+ expense- order+ supplier-
--                   customer+ branch- setRole0 xtenant- xread=0
--   ECOMMERCE_ONLY  product- price- mirror+ expense- order+ supplier-
--                   customer+ branch- setRole0 xtenant- xread=0
--
--   `+` allowed, `-` refused (42501), `0` allowed but matched no rows.
--
--   The two that must never change: `setRole` is never `+` for a non-ADMIN
--   (no self-escalation), and `xtenant`/`xread` are never `+`/non-zero for
--   anyone (no cross-tenant access, not even for ADMIN).
--
--   `mirror+` for the selling roles is REQUIRED, not a leak: `applyStockMoves`
--   writes `products.quantity` from الطلبات. If it ever reads `mirror-`, order
--   dispatch and returns are broken for the roles that own that screen.
-- ============================================================================

DO $$
DECLARE
  qa   uuid := 'db31bbd8-dba1-42e1-9a2e-a9bbe5877c2f';  -- disposable QA store
  other uuid := 'c1c919f9-1d0e-469e-a33e-6a1acb3196e2'; -- any OTHER store
  role_under_test text := 'POS_ECOMMERCE';              -- ← change me, one per run
  uid uuid; n integer; r text := '';
  dev uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  SELECT user_id INTO uid FROM public.store_members WHERE store_id = qa LIMIT 1;
  UPDATE public.store_members SET role = role_under_test WHERE user_id = uid AND store_id = qa;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);

  BEGIN INSERT INTO public.products (id,name,sku,store_id,device_id) VALUES ('RP1','P','RS',qa,dev); r:=r||'product+ ';
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'product- '; END;

  BEGIN UPDATE public.products SET "unitPrice"="unitPrice"+0.01 WHERE store_id=qa;
        GET DIAGNOSTICS n=ROW_COUNT; r:=r||(CASE WHEN n>0 THEN 'price+ ' ELSE 'price0 ' END);
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'price- '; END;

  BEGIN UPDATE public.products SET quantity=quantity WHERE store_id=qa;
        GET DIAGNOSTICS n=ROW_COUNT; r:=r||(CASE WHEN n>0 THEN 'mirror+ ' ELSE 'mirror0 ' END);
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'mirror- '; END;

  BEGIN INSERT INTO public.expenses (id,category,amount,store_id,device_id)
        VALUES ('RP3','office_supplies',1,qa,dev); r:=r||'expense+ ';
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'expense- '; END;

  BEGIN INSERT INTO public.orders (id,"orderNumber","customerName","customerPhone",store_id,device_id)
        VALUES ('RP6','RO','C','0',qa,dev); r:=r||'order+ ';
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'order- '; END;

  BEGIN INSERT INTO public.suppliers (id,"companyName","contactPerson",phone,store_id,device_id)
        VALUES ('RP4','S','C','0',qa,dev); r:=r||'supplier+ ';
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'supplier- '; END;

  BEGIN INSERT INTO public.customers (id,name,phone,address,store_id,device_id)
        VALUES ('RP5','C','0','a',qa,dev); r:=r||'customer+ ';
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'customer- '; END;

  BEGIN INSERT INTO public.discount_codes (id,code,type,value,store_id,device_id)
        VALUES ('RP7','RC','fixed',1,qa,dev); r:=r||'discount+ ';
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'discount- '; END;

  BEGIN INSERT INTO public.branches (id,name,code,store_id,device_id)
        VALUES ('RP2','B','RB',qa,dev); r:=r||'branch+ ';
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'branch- '; END;

  -- Escalation: can this role make itself ADMIN?
  BEGIN UPDATE public.store_members SET role='ADMIN' WHERE user_id=uid AND store_id=qa;
        GET DIAGNOSTICS n=ROW_COUNT; r:=r||(CASE WHEN n>0 THEN 'setRole+ ' ELSE 'setRole0 ' END);
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'setRole- '; END;
  UPDATE public.store_members SET role=role_under_test WHERE user_id=uid AND store_id=qa;

  -- Cross-tenant: write and read another shop.
  BEGIN INSERT INTO public.products (id,name,sku,store_id,device_id) VALUES ('RPX','X','RSX',other,dev); r:=r||'xtenant+ ';
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'xtenant- '; END;
  SELECT count(*) INTO n FROM public.products WHERE store_id=other; r:=r||'xread='||n||' ';

  -- Can any store role touch its own licence?
  BEGIN UPDATE public.store_licenses SET valid_until=now()+interval '99 years' WHERE store_id=qa;
        GET DIAGNOSTICS n=ROW_COUNT; r:=r||(CASE WHEN n>0 THEN 'LICENCE+ ' ELSE 'licence0 ' END);
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'licence- '; END;

  -- Global licence administration must be System Owner only.
  BEGIN PERFORM public.admin_list_stores(); r:=r||'adminRPC+ ';
  EXCEPTION WHEN insufficient_privilege THEN r:=r||'adminRPC- '; END;

  RAISE EXCEPTION '% -- %', role_under_test, r;
END $$;
