-- 031 — `has_role` returns TRUE or FALSE. Never NULL.
--
-- ## The defect
--
-- `has_role` is:
--
--     member_role(p_store_id) = ANY(p_roles) AND store_licensed(p_store_id)
--
-- `member_role` is a scalar SQL function over a SELECT that matches no row when
-- the caller is not a member of that store — so it returns NULL, and
-- `NULL = ANY(...)` is NULL. `store_licensed` is an EXISTS and is never NULL,
-- so the AND gives:
--
--     member?  licensed  result
--     TRUE     TRUE      TRUE
--     TRUE     FALSE     FALSE
--     FALSE    TRUE      FALSE
--     FALSE    FALSE     FALSE
--     NULL     TRUE      NULL     <-- non-member of a licensed store
--     NULL     FALSE     FALSE    (NULL AND FALSE is FALSE)
--
-- Exactly one cell is NULL, and it is the most security-sensitive one: someone
-- who is not a member at all, asking about a live store.
--
-- ## Why that is dangerous even though nothing is broken today
--
-- In an RLS policy a NULL `USING` / `WITH_CHECK` behaves as false — a row is
-- only visible or writable when the expression is TRUE — so all 18 policies
-- that call `has_role` are already fail-closed. The trigger
-- `products_guard_definition_columns` uses `IF has_role(...) THEN <allow>`,
-- which also falls through to the restriction on NULL.
--
-- PL/pgSQL is where it bites: `IF NOT has_role(...) THEN RETURN; END IF;` reads
-- `NOT NULL` as NULL, and `IF NULL THEN` does not fire — so the guard is skipped
-- for precisely the caller it exists to stop. That is not hypothetical: it
-- happened in `mobile_shortages` (migration 028), where an ADMIN of a different
-- shop read QA-STORE's shortage rows until the call site was wrapped in
-- COALESCE. This moves the fix from the call site to the function, so the next
-- one cannot repeat it.
--
-- ## Why this cannot widen access
--
-- COALESCE only ever rewrites NULL. No cell that was TRUE changes, and no cell
-- that was FALSE becomes TRUE — so it can only ever DENY where the answer was
-- previously undefined. Permissions are strictly preserved or tightened, and
-- the one tightened cell is already treated as a denial everywhere it is read
-- today. Measured before and after across all eight cases; see the session
-- report.
--
-- The permission model itself is untouched: same roles, same licence check,
-- same membership lookup, same VARIADIC signature, same SECURITY DEFINER and
-- pinned search_path.

CREATE OR REPLACE FUNCTION public.has_role(p_store_id uuid, VARIADIC p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    public.member_role(p_store_id) = ANY(p_roles)
      AND public.store_licensed(p_store_id),
    false
  );
$function$;
