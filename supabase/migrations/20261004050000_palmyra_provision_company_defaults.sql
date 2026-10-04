create or replace function public.palmyra_provision_company_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.company_settings(company_id, settings)
  values (
    new.id,
    jsonb_build_object(
      'storeConfig', jsonb_build_object(
        'storeName', coalesce(new.name, ''),
        'address', '',
        'phone', '',
        'receiptNotes', '',
        'darkMode', false,
        'manualOfflineSync', true
      ),
      'receiptConfig', jsonb_build_object(
        'showLogo', true,
        'showAddress', true,
        'showPhone', true,
        'showFooter', true,
        'footerText', 'Gracias por su compra.',
        'businessName', coalesce(new.name, ''),
        'businessAddress', '',
        'businessPhone', '',
        'printerWidth', '80mm',
        'autoPrint', false
      )
    )
  )
  on conflict (company_id) do nothing;
  return new;
end;
$$;

revoke all on function public.palmyra_provision_company_defaults() from public;
revoke all on function public.palmyra_provision_company_defaults() from anon;
revoke all on function public.palmyra_provision_company_defaults() from authenticated;

drop trigger if exists companies_provision_defaults on public.companies;
create trigger companies_provision_defaults
after insert on public.companies
for each row
execute function public.palmyra_provision_company_defaults();

insert into public.company_settings(company_id, settings)
select
  c.id,
  jsonb_build_object(
    'storeConfig', jsonb_build_object(
      'storeName', coalesce(c.name, ''),
      'address', '',
      'phone', '',
      'receiptNotes', '',
      'darkMode', false,
      'manualOfflineSync', true
    ),
    'receiptConfig', jsonb_build_object(
      'showLogo', true,
      'showAddress', true,
      'showPhone', true,
      'showFooter', true,
      'footerText', 'Gracias por su compra.',
      'businessName', coalesce(c.name, ''),
      'businessAddress', '',
      'businessPhone', '',
      'printerWidth', '80mm',
      'autoPrint', false
    )
  )
from public.companies c
left join public.company_settings s on s.company_id = c.id
where s.company_id is null;