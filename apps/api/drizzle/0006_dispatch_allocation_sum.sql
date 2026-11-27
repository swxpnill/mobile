-- Spec section 4: for a truck that has been weighed (awaiting approval or dispatched), its line allocations
-- sum exactly to gross - tare. The shared rules check it before every write; this deferred
-- constraint trigger is the defence in depth, checked at commit so a transaction may rewrite the
-- truck and its allocations in any order.
CREATE FUNCTION public.check_truck_allocations_sum() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t_tenant uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
  t_id uuid;
  t_state text;
  t_net bigint;
  t_sum bigint;
BEGIN
  IF TG_TABLE_NAME = 'trucks' THEN
    t_id := COALESCE(NEW.id, OLD.id);
  ELSE
    t_id := COALESCE(NEW.truck_id, OLD.truck_id);
  END IF;
  SELECT state, gross_kg - tare_kg INTO t_state, t_net
    FROM public.trucks WHERE tenant_id = t_tenant AND id = t_id;
  -- Gone (hard delete) or not weighed yet: nothing to hold.
  IF NOT FOUND OR t_state NOT IN ('weighed', 'dispatched') THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(net_kg), 0) INTO t_sum
    FROM public.truck_allocations WHERE tenant_id = t_tenant AND truck_id = t_id;
  IF t_net IS NULL OR t_sum <> t_net THEN
    RAISE EXCEPTION 'truck_allocations_sum: truck % allocations sum to % kg, gross - tare is % kg', t_id, t_sum, t_net
      USING ERRCODE = 'check_violation', CONSTRAINT = 'truck_allocations_sum';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER truck_allocations_sum_on_trucks
  AFTER INSERT OR UPDATE OF state, tare_kg, gross_kg ON public.trucks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_truck_allocations_sum();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER truck_allocations_sum_on_allocations
  AFTER INSERT OR UPDATE OR DELETE ON public.truck_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_truck_allocations_sum();
