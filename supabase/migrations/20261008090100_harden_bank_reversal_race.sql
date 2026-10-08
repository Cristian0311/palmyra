-- Final hardening for bank reversal concurrency.
create or replace function public.palmyra_delete_bank_internal_transfer(p_operation_id uuid,p_company_id uuid) returns jsonb
language plpgsql security definer set search_path to public, private, pg_temp as $function$
declare v_auth uuid:=auth.uid(); t record; v_updated_id uuid;
begin
 if v_auth is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) or not private.has_permission(p_company_id,'settings.manage') then raise exception 'permission_denied'; end if;
 perform pg_advisory_xact_lock(hashtext(p_company_id::text||':bank-transfer'));
 for t in select * from public.bank_transactions where company_id=p_company_id and reference=p_operation_id::text for update loop
  if lower(t.transaction_type)='deposit' then
   update public.bank_accounts set balance=balance-t.amount,updated_at=timezone('utc',now()) where id=t.bank_account_id and company_id=p_company_id and balance>=t.amount returning id into v_updated_id;
   if v_updated_id is null then raise exception 'bank_transfer_delete_insufficient_balance'; end if;
  else
   update public.bank_accounts set balance=balance+t.amount,updated_at=timezone('utc',now()) where id=t.bank_account_id and company_id=p_company_id returning id into v_updated_id;
   if v_updated_id is null then raise exception 'bank_account_not_found'; end if;
  end if;
  v_updated_id:=null;
 end loop;
 delete from public.bank_transactions where company_id=p_company_id and reference=p_operation_id::text;
 return jsonb_build_object('success',true,'operation_id',p_operation_id);
end;
$function$;

create or replace function public.palmyra_delete_bank_transaction(p_transaction_id uuid,p_company_id uuid) returns jsonb
language plpgsql security definer set search_path to public, private, pg_temp as $function$
declare v_auth uuid:=auth.uid(); t public.bank_transactions%rowtype; v_updated_id uuid;
begin
 if v_auth is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) or not private.has_permission(p_company_id,'settings.manage') then raise exception 'permission_denied'; end if;
 select * into t from public.bank_transactions where id=p_transaction_id and company_id=p_company_id for update;
 if not found then return jsonb_build_object('success',true,'already_deleted',true); end if;
 if lower(coalesce(t.transaction_type,'')) in ('deposit','payment_received') then
  update public.bank_accounts set balance=balance-t.amount,updated_at=timezone('utc',now()) where id=t.bank_account_id and company_id=p_company_id and balance>=t.amount returning id into v_updated_id;
  if v_updated_id is null then raise exception 'bank_transaction_delete_insufficient_balance'; end if;
 else
  update public.bank_accounts set balance=balance+t.amount,updated_at=timezone('utc',now()) where id=t.bank_account_id and company_id=p_company_id returning id into v_updated_id;
  if v_updated_id is null then raise exception 'bank_account_not_found'; end if;
 end if;
 delete from public.bank_transactions where id=t.id and company_id=p_company_id;
 return jsonb_build_object('success',true,'already_deleted',false,'id',t.id);
end;
$function$;
