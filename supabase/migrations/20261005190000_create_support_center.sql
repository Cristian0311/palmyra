-- PALMYRA support center: one platform-wide customer-care destination
-- plus tenant-scoped support request traceability.
create table if not exists public.platform_support_settings (
  id smallint primary key default 1 check (id = 1),
  whatsapp_number text,
  support_email text,
  privacy_url text,
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.platform_support_settings (id, whatsapp_number, support_email, privacy_url)
values (1, null, null, null)
on conflict (id) do nothing;

alter table public.platform_support_settings enable row level security;

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_name text not null,
  request_type text not null,
  subject text not null,
  message text not null,
  contact_phone text,
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_support_requests_company_created
  on public.support_requests(company_id, created_at desc);

create index if not exists idx_support_requests_status_created
  on public.support_requests(status, created_at desc);

alter table public.support_requests enable row level security;

-- Reads happen through the hardened functions below.
drop policy if exists "support_settings_no_direct_read" on public.platform_support_settings;
drop policy if exists "support_requests_no_direct_read" on public.support_requests;

create or replace function public.get_platform_support_settings()
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  return jsonb_build_object(
    'whatsapp_number', nullif(trim(coalesce((select s.whatsapp_number from public.platform_support_settings s where s.id=1), '')), ''),
    'support_email', nullif(trim(coalesce((select s.support_email from public.platform_support_settings s where s.id=1), '')), ''),
    'privacy_url', nullif(trim(coalesce((select s.privacy_url from public.platform_support_settings s where s.id=1), '')), '')
  );
end;
$$;

create or replace function public.set_platform_support_settings(
  p_whatsapp_number text,
  p_support_email text default null,
  p_privacy_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or not exists (
    select 1 from public.platform_admins pa where pa.user_id = v_user
  ) then
    raise exception 'permission_denied';
  end if;

  insert into public.platform_support_settings (
    id, whatsapp_number, support_email, privacy_url, updated_at
  ) values (
    1,
    nullif(regexp_replace(coalesce(p_whatsapp_number,''), '[^0-9+]', '', 'g'), ''),
    nullif(trim(coalesce(p_support_email,'')), ''),
    nullif(trim(coalesce(p_privacy_url,'')), ''),
    timezone('utc', now())
  )
  on conflict (id) do update set
    whatsapp_number = excluded.whatsapp_number,
    support_email = excluded.support_email,
    privacy_url = excluded.privacy_url,
    updated_at = excluded.updated_at;

  return public.get_platform_support_settings();
end;
$$;

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

  select cm.company_id, c.name
    into v_company, v_company_name
  from public.company_memberships cm
  join public.companies c on c.id = cm.company_id
  where cm.user_id = v_user
    and cm.status = 'active'
  order by cm.created_at asc
  limit 1;

  if v_company is null then
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

create or replace function public.get_platform_support_requests(
  p_status text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or not exists (
    select 1 from public.platform_admins pa where pa.user_id = v_user
  ) then
    raise exception 'permission_denied';
  end if;

  return coalesce((
    select jsonb_agg(x order by (x->>'created_at') desc)
    from (
      select jsonb_build_object(
        'id', sr.id,
        'company_id', sr.company_id,
        'company_name', sr.company_name,
        'request_type', sr.request_type,
        'subject', sr.subject,
        'message', sr.message,
        'contact_phone', sr.contact_phone,
        'status', sr.status,
        'created_at', sr.created_at,
        'updated_at', sr.updated_at
      ) x
      from public.support_requests sr
      where p_status is null or sr.status = p_status
      order by sr.created_at desc
      limit greatest(1, least(coalesce(p_limit, 50), 200))
    ) q
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_platform_support_settings() from public;
grant execute on function public.get_platform_support_settings() to authenticated;
revoke all on function public.set_platform_support_settings(text,text,text) from public;
grant execute on function public.set_platform_support_settings(text,text,text) to authenticated;
revoke all on function public.create_support_request(text,text,text,text,jsonb) from public;
grant execute on function public.create_support_request(text,text,text,text,jsonb) to authenticated;
revoke all on function public.get_platform_support_requests(text,integer) from public;
grant execute on function public.get_platform_support_requests(text,integer) to authenticated;
