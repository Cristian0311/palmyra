create or replace function public.create_support_request(
  p_request_type text,
  p_subject text,
  p_message text,
  p_contact_phone text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_company_name text;
  v_request_id uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;

  -- Prefer the company's explicit active scope. This matters for users that
  -- can belong to more than one company: support must never be attached to an
  -- arbitrary membership.
  select p.active_company_id
    into v_company
  from public.profiles p
  where p.id = v_user;

  if v_company is not null and not exists (
    select 1 from public.company_memberships cm
    where cm.user_id = v_user
      and cm.company_id = v_company
      and cm.status = 'active'
  ) then
    v_company := null;
  end if;

  if v_company is null then
    select cm.company_id
      into v_company
    from public.company_memberships cm
    where cm.user_id = v_user
      and cm.status = 'active'
    order by cm.created_at asc
    limit 1;
  end if;

  select c.name into v_company_name
  from public.companies c
  where c.id = v_company;

  if v_company is null or v_company_name is null then
    raise exception 'active_company_not_found';
  end if;

  if length(trim(coalesce(p_request_type,''))) < 2 then raise exception 'request_type_required'; end if;
  if length(trim(coalesce(p_subject,''))) < 2 then raise exception 'subject_required'; end if;
  if length(trim(coalesce(p_message,''))) < 5 then raise exception 'message_required'; end if;

  insert into public.support_requests (
    company_id, user_id, company_name, request_type, subject, message, contact_phone, metadata
  ) values (
    v_company,
    v_user,
    v_company_name,
    left(trim(p_request_type), 80),
    left(trim(p_subject), 160),
    left(trim(p_message), 4000),
    left(nullif(trim(coalesce(p_contact_phone,'')), ''), 60),
    case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end
  )
  returning id into v_request_id;

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request_id,
    'company_id', v_company,
    'company_name', v_company_name
  );
end;
$$;

revoke all on function public.create_support_request(text,text,text,text,jsonb) from public;
grant execute on function public.create_support_request(text,text,text,text,jsonb) to authenticated;
