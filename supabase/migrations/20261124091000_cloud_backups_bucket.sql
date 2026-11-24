-- PENDIENTE DE APLICAR
-- Cubo privado para el respaldo cifrado fuera del sitio (F6-C).
--
-- Contexto:
--  * El cliente sube el MISMO sobre cifrado del respaldo local (.pmlr, AES-256-GCM
--    con PBKDF2-SHA256) y un manifiesto .pmlr.json. El servidor nunca ve datos en
--    claro ni la frase: no hay descifrado del lado de la nube.
--  * Ruta obligatoria: <companyId>/<deviceId>/<YYYY-MM-DD>.pmlr[.json].
--  * Sin acceso público: el cubo es privado y cada usuario autenticado solo puede
--    operar dentro del prefijo de SU empresa (primera carpeta del nombre).
--  * Tope por archivo de 200 MB; el cliente aplica el mismo límite antes de subir.
--
-- Notas de seguridad:
--  * Aunque un usuario adivinara la ruta de otra empresa, la política compara la
--    primera carpeta con sus membresías activas y lo rechaza.
--  * No se permite listar el cubo completo: `list` del cliente siempre va con
--    prefijo y RLS filtra cada objeto.
--  * Todo es idempotente: se puede reejecutar sin efectos secundarios.
begin;

-- ---------------------------------------------------------------------------
-- 1. Cubo privado (200 MB por archivo, solo binario y JSON del manifiesto).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'palmyra-backups',
  'palmyra-backups',
  false,
  209715200,
  array['application/octet-stream', 'application/json']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Prefijo de empresa a partir del nombre del objeto.
--    storage.foldername('a/b/c.pmlr') = {a,b}; la primera carpeta es la empresa.
-- ---------------------------------------------------------------------------
create or replace function private.cloud_backup_company(p_name text)
returns uuid
language plpgsql
immutable
set search_path = pg_catalog, storage, pg_temp
as $$
declare
  v_folder text;
begin
  if p_name is null or length(p_name) = 0 then
    return null;
  end if;
  v_folder := (storage.foldername(p_name))[1];
  if v_folder is null or v_folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_folder::uuid;
exception
  when others then
    return null;
end;
$$;

-- Membresía activa del usuario autenticado en la empresa dueña del prefijo.
create or replace function private.cloud_backup_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_company_id is not null
    and auth.uid() is not null
    and exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = p_company_id
        and cm.user_id = auth.uid()
        and cm.status = 'active'
    );
$$;

revoke all on function private.cloud_backup_company(text) from public;
revoke all on function private.cloud_backup_member(uuid) from public;
grant execute on function private.cloud_backup_company(text) to authenticated;
grant execute on function private.cloud_backup_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Políticas sobre storage.objects, acotadas al prefijo de la empresa.
-- ---------------------------------------------------------------------------
drop policy if exists cloud_backups_select on storage.objects;
drop policy if exists cloud_backups_insert on storage.objects;
drop policy if exists cloud_backups_update on storage.objects;
drop policy if exists cloud_backups_delete on storage.objects;

create policy cloud_backups_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'palmyra-backups'
    and private.cloud_backup_member(private.cloud_backup_company(name))
  );

create policy cloud_backups_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'palmyra-backups'
    and private.cloud_backup_member(private.cloud_backup_company(name))
  );

-- `upsert` de la API de Storage reescribe el mismo día: hace falta UPDATE.
create policy cloud_backups_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'palmyra-backups'
    and private.cloud_backup_member(private.cloud_backup_company(name))
  )
  with check (
    bucket_id = 'palmyra-backups'
    and private.cloud_backup_member(private.cloud_backup_company(name))
  );

create policy cloud_backups_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'palmyra-backups'
    and private.cloud_backup_member(private.cloud_backup_company(name))
  );

-- El cubo es privado y solo hay políticas para `authenticated`: un usuario
-- anónimo no tiene ninguna política que le permita leer ni escribir aquí.
commit;
