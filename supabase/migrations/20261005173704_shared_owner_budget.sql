-- One setting per store. No ledger rewrite and no browser-storage import.
CREATE TABLE public.owner_budgets (
  store_id uuid PRIMARY KEY REFERENCES public.stores(id),
  budget_limit numeric NOT NULL CHECK (budget_limit > 0 AND budget_limit < 1000000000000 AND budget_limit = round(budget_limit,2)),
  period_type text NOT NULL CHECK (period_type IN ('monthly','open')),
  started_at timestamptz NOT NULL CHECK (isfinite(started_at)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.owner_budgets ENABLE ROW LEVEL SECURITY;
-- Desktop's existing finance page lets ADMIN and ACCOUNTANT set/reset the
-- personal budget. Preserve that intent; Mobile still exposes ADMIN only.
CREATE POLICY owner_budgets_read ON public.owner_budgets FOR SELECT TO authenticated
  USING (public.has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
CREATE POLICY owner_budgets_insert ON public.owner_budgets FOR INSERT TO authenticated
  WITH CHECK (public.has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
CREATE POLICY owner_budgets_update ON public.owner_budgets FOR UPDATE TO authenticated
  USING (public.has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']))
  WITH CHECK (public.has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
CREATE POLICY owner_budgets_delete ON public.owner_budgets FOR DELETE TO authenticated
  USING (public.has_role(store_id, VARIADIC ARRAY['ADMIN','ACCOUNTANT']));
REVOKE ALL ON public.owner_budgets FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.owner_budgets TO authenticated;
CREATE FUNCTION public.stamp_owner_budget() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.created_at := OLD.created_at; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER owner_budget_timestamp BEFORE INSERT OR UPDATE ON public.owner_budgets
  FOR EACH ROW EXECUTE FUNCTION public.stamp_owner_budget();
REVOKE ALL ON FUNCTION public.stamp_owner_budget() FROM PUBLIC, anon, authenticated;
