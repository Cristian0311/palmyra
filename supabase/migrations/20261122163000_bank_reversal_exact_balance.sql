-- Bank reversals must be the exact inverse of the original movement.
-- The previous definitions clamped the restored balance with greatest(0, ...),
-- which silently kept part of the money when concurrent movements had already
-- spent it. Now the delta is always applied in full and, if the exact result
-- would be negative, the whole reversal aborts so the ledger and the account
-- balance can never drift apart.
begin;

create or replace function public.palmyra_delete_bank_transaction(
  p_transaction_id uuid,
  p_company_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to public, private, pg_temp
as $function$
declare
  v_auth uuid := auth.uid();
  t public.bank_transactions%rowtype;
  v_type text;
  v_delta numeric;
  v_balance numeric;
  v_account_name text;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id)
     or not private.has_permission(p_company_id,'settings.manage') then
    raise exception 'permission_denied';
  end if;

  select * into t
  from public.bank_transactions
  where id=p_transaction_id and company_id=p_company_id
  for update;

  if not found then
    return jsonb_build_object('success',true,'already_deleted',true);
  end if;

  -- Canonical values are credit/debit; legacy rows keep the UI vocabulary.
  v_type := case lower(trim(coalesce(t.transaction_type,'')))
    when 'credit' then 'credit'
    when 'deposit' then 'credit'
    when 'payment_received' then 'credit'
    when 'debit' then 'debit'
    when 'withdrawal' then 'debit'
    when 'supplier_payment' then 'debit'
    else null
  end;

  if v_type is null then
    raise exception 'invalid_bank_transaction_type';
  end if;

  -- Exact inverse: a credit is taken back, a debit is returned.
  v_delta := case when v_type='credit' then -t.amount else t.amount end;

  update public.bank_accounts
  set balance=balance+v_delta,
      updated_at=timezone('utc',now())
  where id=t.bank_account_id and company_id=p_company_id
  returning balance, name into v_balance, v_account_name;

  if v_balance is null then
    raise exception 'bank_account_not_found';
  end if;

  if v_delta < 0 and v_balance < 0 then
    raise exception
      'bank reversal blocked for account % (%): balance % + reversal % = %, negative balance is not allowed',
      coalesce(v_account_name,''), t.bank_account_id, v_balance-v_delta, v_delta, v_balance;
  end if;

  delete from public.bank_transactions
  where id=t.id and company_id=p_company_id;

  return jsonb_build_object(
    'success',true,
    'already_deleted',false,
    'id',t.id,
    'balance',v_balance,
    'delta',v_delta
  );
end;
$function$;

create or replace function public.palmyra_delete_bank_internal_transfer(
  p_operation_id uuid,
  p_company_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to public, private, pg_temp
as $function$
declare
  v_auth uuid := auth.uid();
  t record;
  v_type text;
  v_delta numeric;
  v_balance numeric;
  v_account_name text;
  v_from_card_id uuid;
  v_to_card_id uuid;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id)
     or not private.has_permission(p_company_id,'settings.manage') then
    raise exception 'permission_denied';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_company_id::text||':bank-transfer'));

  for t in
    select *
    from public.bank_transactions
    where company_id=p_company_id
      and reference=p_operation_id::text
    order by case when lower(transaction_type) in ('debit','withdrawal','supplier_payment') then 0 else 1 end
    for update
  loop
    v_type := case lower(trim(coalesce(t.transaction_type,'')))
      when 'credit' then 'credit'
      when 'deposit' then 'credit'
      when 'payment_received' then 'credit'
      when 'debit' then 'debit'
      when 'withdrawal' then 'debit'
      when 'supplier_payment' then 'debit'
      else null
    end;

    if v_type is null then
      raise exception 'invalid_bank_transfer_transaction_type';
    end if;

    -- Exact inverse of each leg: return the outgoing amount and take back the
    -- incoming amount, with no clamping.
    v_delta := case when v_type='credit' then -t.amount else t.amount end;

    update public.bank_accounts
    set balance=balance+v_delta,
        updated_at=timezone('utc',now())
    where id=t.bank_account_id and company_id=p_company_id
    returning balance, name into v_balance, v_account_name;

    if v_balance is null then
      raise exception 'bank_account_not_found';
    end if;

    if v_delta < 0 and v_balance < 0 then
      raise exception
        'bank reversal blocked for account % (%): balance % + reversal % = %, negative balance is not allowed',
        coalesce(v_account_name,''), t.bank_account_id, v_balance-v_delta, v_delta, v_balance;
    end if;

    if v_type='credit' then
      v_to_card_id := t.bank_account_id;
    else
      v_from_card_id := t.bank_account_id;
    end if;
  end loop;

  delete from public.bank_transactions
  where company_id=p_company_id
    and reference=p_operation_id::text;

  return jsonb_build_object(
    'success',true,
    'operation_id',p_operation_id,
    'from_card_id',v_from_card_id,
    'to_card_id',v_to_card_id,
    'from_balance',(
      select balance from public.bank_accounts
      where id=v_from_card_id and company_id=p_company_id
    ),
    'to_balance',(
      select balance from public.bank_accounts
      where id=v_to_card_id and company_id=p_company_id
    )
  );
end;
$function$;

revoke all on function public.palmyra_delete_bank_transaction(uuid,uuid) from public, anon;
revoke all on function public.palmyra_delete_bank_internal_transfer(uuid,uuid) from public, anon;
grant execute on function public.palmyra_delete_bank_transaction(uuid,uuid) to authenticated;
grant execute on function public.palmyra_delete_bank_internal_transfer(uuid,uuid) to authenticated;

commit;
