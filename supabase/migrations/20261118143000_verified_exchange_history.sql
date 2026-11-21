create or replace function public.get_verified_exchange_rate_history(
  p_since timestamptz default null,
  p_limit integer default 2500
)
returns table (captured_at timestamptz, rates jsonb)
language sql stable security definer
set search_path = public
as $$
  select recent.captured_at, recent.rates
  from (
    select h.captured_at, jsonb_object_agg(h.code, h.value) as rates
    from public.exchange_rate_history h
    where lower(h.source) in ('eltoque', 'eltoque api')
      and h.value > 0
      and (p_since is null or h.captured_at >= p_since)
    group by h.captured_at
    order by h.captured_at desc
    limit least(greatest(coalesce(p_limit, 2500), 1), 2500)
  ) recent
  order by recent.captured_at;
$$;
revoke all on function public.get_verified_exchange_rate_history(timestamptz, integer) from public;
grant execute on function public.get_verified_exchange_rate_history(timestamptz, integer) to anon, authenticated;
