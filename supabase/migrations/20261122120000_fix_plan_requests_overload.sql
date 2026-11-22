-- PostgREST no puede resolver rpc('get_pending_plan_requests') sin argumentos
-- cuando coexisten la sobrecarga vacía y la de dos argumentos con valores por
-- defecto. La versión de dos argumentos ya cubre el caso sin argumentos, así
-- que se retira la vacía para eliminar la ambigüedad.
drop function if exists public.get_pending_plan_requests();

revoke all on function public.get_pending_plan_requests(text, integer) from public, anon;
grant execute on function public.get_pending_plan_requests(text, integer) to authenticated;

notify pgrst, 'reload schema';
