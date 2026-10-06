-- Configurable official social channels for Free signup and Help Center.
-- Only the two public URLs are exposed. Support phone/email/privacy stay protected.

create table if not exists public.platform_social_links (
  id smallint primary key default 1,
  facebook_url text,
  whatsapp_channel_url text,
  updated_at timestamptz not null default timezone('utc', now()),
  constraint platform_social_links_singleton check (id = 1)
);

alter table public.platform_social_links enable row level security;

revoke all on table public.platform_social_links from public, anon, authenticated;
grant select on table public.platform_social_links to anon, authenticated;

drop policy if exists public_read_platform_social_links on public.platform_social_links;
create policy public_read_platform_social_links
  on public.platform_social_links
  for select
  to anon, authenticated
  using (id = 1);

insert into public.platform_social_links (id)
values (1)
on conflict (id) do nothing;

create or replace function public.get_platform_support_settings()
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  return jsonb_build_object(
    'whatsapp_number',
      nullif(trim(coalesce((select whatsapp_number from public.platform_support_settings where id=1),'')),''),
    'support_email',
      nullif(trim(coalesce((select support_email from public.platform_support_settings where id=1),'')),''),
    'privacy_url',
      nullif(trim(coalesce((select privacy_url from public.platform_support_settings where id=1),'')),''),
    'facebook_url',
      nullif(trim(coalesce((select facebook_url from public.platform_social_links where id=1),'')),''),
    'whatsapp_channel_url',
      nullif(trim(coalesce((select whatsapp_channel_url from public.platform_social_links where id=1),'')),'')
  );
end;
$function$;

create or replace function public.set_platform_support_settings(
  p_whatsapp_number text,
  p_support_email text default null,
  p_privacy_url text default null,
  p_facebook_url text default null,
  p_whatsapp_channel_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_facebook_url text := nullif(trim(coalesce(p_facebook_url,'')),'');
  v_whatsapp_channel_url text := nullif(trim(coalesce(p_whatsapp_channel_url,'')),'');
begin
  if v_user is null or not exists (
    select 1 from public.platform_admins where user_id=v_user
  ) then
    raise exception 'permission_denied';
  end if;

  if v_facebook_url is not null
     and v_facebook_url !~* '^https://(www\.|m\.)?facebook\.com/[^[:space:]]+$' then
    raise exception 'invalid_facebook_url';
  end if;

  if v_whatsapp_channel_url is not null
     and v_whatsapp_channel_url !~* '^https://(www\.)?whatsapp\.com/channel/[^[:space:]]+$' then
    raise exception 'invalid_whatsapp_channel_url';
  end if;

  insert into public.platform_support_settings(
    id,whatsapp_number,support_email,privacy_url,updated_at
  ) values (
    1,
    nullif(regexp_replace(coalesce(p_whatsapp_number,''),'[^0-9+]','','g'),''),
    nullif(trim(coalesce(p_support_email,'')),''),
    nullif(trim(coalesce(p_privacy_url,'')),''),
    timezone('utc',now())
  )
  on conflict(id) do update set
    whatsapp_number=excluded.whatsapp_number,
    support_email=excluded.support_email,
    privacy_url=excluded.privacy_url,
    updated_at=excluded.updated_at;

  insert into public.platform_social_links(
    id,facebook_url,whatsapp_channel_url,updated_at
  ) values (
    1,v_facebook_url,v_whatsapp_channel_url,timezone('utc',now())
  )
  on conflict(id) do update set
    facebook_url=excluded.facebook_url,
    whatsapp_channel_url=excluded.whatsapp_channel_url,
    updated_at=excluded.updated_at;

  return public.get_platform_support_settings();
end;
$function$;

revoke all on function public.set_platform_support_settings(text,text,text,text,text) from public;
grant execute on function public.set_platform_support_settings(text,text,text,text,text) to authenticated;
