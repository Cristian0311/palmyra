-- Harden bank transfers against concurrent overspending and unsafe reversal.
-- Applied to production during the audit; keep this migration in repository history.

create or replace function public.palmyra_bank_internal_transfer(
  p_operation_id uuid, p_company_id uuid, p_from_bank_account_id uuid,
  p_to_bank_account_id uuid, p_amount numeric, p_target_amount numeric,
  p_date timestamptz, p_reason text
) returns jsonb
language plpgsql security definer
set search_path to public, private, pg_temp
as $function$
declare
  v_auth uuid := auth.uid();
  a public.bank_accounts%rowtype;
  b public.bank_accounts%rowtype;
  out_id uuid;
  in_id uuid;
  target numeric;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) or not private.has_permission(p_company_id,'settings.manage') then raise exception 'permission_denied'; end if;
  if p_from_bank_account_id=p_to_bank_account_id or p_amount<=0 then raise exception 'invalid_bank_transfer'; end if;
  perform pg_advisory_xact_lock(hashtext(p_company_id::text||':bank-transfer'));
  if exists(select 1 from public.bank_transactions bt where bt.reference=p_operation_id::text and bt.company_id=p_company_id) then
    return jsonb_build_object('success',true,'already_existed',true,'operation_id',p_operation_id);
  end if;
  select * into a from public.bank_accounts where id=p_from_bank_account_id and company_id=p_company_id and active for update;
  select * into b from public.bank_accounts where id=p_to_bank_account_id and company_id=p_company_id and active for update;
  if a.id is null or b.id is null then raise exception 'bank_account_not_found'; end if;
  if a.balance<p_amount then raise exception 'insufficient_bank_balance'; end if;
  target:=greatest(0,coalesce(p_target_amount,p_amount));
  out_id:=gen_random_uuid(); in_id:=gen_random_uuid();
  insert into public.bank_transactions(id,company_id,bank_account_id,transaction_type,amount,currency_code,reference,note,created_by,created_at)
  values (out_id,p_company_id,a.id,'withdrawal',p_amount,a.currency_code,p_operation_id::text,coalesce(p_reason,'Transferencia interna'),v_auth,coalesce(p_date,timezone('utc',now()))),
         (in_id,p_company_id,b.id,'deposit',target,b.currency_code,p_operation_id::text,coalesce(p_reason,'Transferencia interna'),v_auth,coalesce(p_date,timezone('utc',now())));
  update public.bank_accounts set balance=balance-p_amount,updated_at=timezone('utc',now()) where id=a.id and company_id=p_company_id;
  update public.bank_accounts set balance=balance+target,updated_at=timezone('utc',now()) where id=b.id and company_id=p_company_id;
  return jsonb_build_object('success',true,'already_existed',false,'operation_id',p_operation_id,'from_transaction_id',out_id,'to_transaction_id',in_id);
end;
$function$;

create or replace function public.palmyra_delete_bank_internal_transfer(p_operation_id uuid,p_company_id uuid) returns jsonb
language plpgsql security definer set search_path to public, private, pg_temp as $function$
declare v_auth uuid:=auth.uid(); t record; v_affected numeric;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) or not private.has_permission(p_company_id,'settings.manage') then raise exception 'permission_denied'; end if;
  perform pg_advisory_xact_lock(hashtext(p_company_id::text||':bank-transfer'));
  for t in select * from public.bank_transactions where company_id=p_company_id and reference=p_operation_id::text for update loop
    if lower(t.transaction_type)='deposit' then
      if exists(select 1 from public.bank_accounts ba where ba.id=t.bank_account_id and ba.company_id=p_company_id and ba.balance<t.amount) then raise exception 'bank_transfer_delete_insufficient_balance'; end if;
      v_affected:=-t.amount;
    else v_affected:=t.amount; end if;
    update public.bank_accounts set balance=balance+v_affected,updated_at=timezone('utc',now()) where id=t.bank_account_id and company_id=p_company_id;
  end loop;
  delete from public.bank_transactions where company_id=p_company_id and reference=p_operation_id::text;
  return jsonb_build_object('success',true,'operation_id',p_operation_id);
end;
$function$;

create or replace function public.palmyra_delete_bank_transaction(p_transaction_id uuid,p_company_id uuid) returns jsonb
language plpgsql security definer set search_path to public, private, pg_temp as $function$
declare v_auth uuid:=auth.uid(); t public.bank_transactions%rowtype; v_delta numeric;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) or not private.has_permission(p_company_id,'settings.manage') then raise exception 'permission_denied'; end if;
  select * into t from public.bank_transactions where id=p_transaction_id and company_id=p_company_id for update;
  if not found then return jsonb_build_object('success',true,'already_deleted',true); end if;
  if lower(coalesce(t.transaction_type,'')) in ('deposit','payment_received') then
    if exists(select 1 from public.bank_accounts ba where ba.id=t.bank_account_id and ba.company_id=p_company_id and ba.balance<t.amount) then raise exception 'bank_transaction_delete_insufficient_balance'; end if;
    v_delta:=-t.amount;
  else v_delta:=t.amount; end if;
  update public.bank_accounts set balance=balance+v_delta,updated_at=timezone('utc',now()) where id=t.bank_account_id and company_id=p_company_id;
  delete from public.bank_transactions where id=t.id and company_id=p_company_id;
  return jsonb_build_object('success',true,'already_deleted',false,'id',t.id);
end;
$function$;
