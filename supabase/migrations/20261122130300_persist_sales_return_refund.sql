begin;

-- Persistencia del reembolso de devoluciones.
--
-- Antes: la UI cobraba el reembolso (egreso en caja o retiro bancario) y
-- actualizaba el estado solo en el navegador. sales_returns nunca recibía
-- refund_bank_card_id / refund_transaction_id / refunded_at y
-- refund_currency_code estaba declarada como "character" (un solo carácter),
-- así que 'CUP' no podía guardarse.
--
-- Aquí: se corrige el tipo de la moneda, se agregan las columnas del pago y se
-- crea palmyra_record_return_refund(...), la única vía autenticada para
-- registrar el reembolso. No se modifica ninguna fila existente.

alter table public.sales_returns
  alter column refund_currency_code type text using refund_currency_code::text;

alter table public.sales_returns
  add column if not exists refund_bank_card_id uuid,
  add column if not exists refund_transaction_id uuid,
  add column if not exists refunded_at timestamptz;

create index if not exists sales_returns_company_refund_status_idx
  on public.sales_returns (company_id, refund_status);

create or replace function public.palmyra_record_return_refund(
  p_return_id uuid,
  p_company_id uuid,
  p_status text,
  p_amount numeric,
  p_currency text,
  p_method text,
  p_bank_card_id uuid,
  p_transaction_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_row public.sales_returns%rowtype;
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_method text := nullif(lower(btrim(coalesce(p_method, ''))), '');
  v_currency text := nullif(upper(btrim(coalesce(p_currency, ''))), '');
  v_amount numeric := round(coalesce(p_amount, 0), 6);
  v_refunded_at timestamptz;
begin
  if v_auth is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;

  if not private.has_permission(p_company_id, 'sales.refund') then
    raise exception 'permission_denied';
  end if;

  select *
    into v_row
    from public.sales_returns
   where id = p_return_id
     and company_id = p_company_id
     for update;

  if not found then
    raise exception 'return_not_found';
  end if;

  if v_status not in ('not_required', 'pending', 'approved', 'paid', 'rejected') then
    raise exception 'invalid_refund_status';
  end if;

  -- Un reembolso ya pagado no se revierte desde el cliente; si se repite la
  -- misma operación se responde de forma idempotente.
  if v_row.refund_status = 'paid' and v_status <> 'paid' then
    raise exception 'refund_already_paid';
  end if;

  if v_status = 'paid' then
    if v_amount <= 0 then
      raise exception 'invalid_refund_amount';
    end if;

    -- Se admite reembolso parcial, nunca superior al total del caso.
    if v_amount > round(coalesce(v_row.total, 0), 6) + 0.01 then
      raise exception 'refund_exceeds_total';
    end if;

    if v_method is null or v_method not in ('cash', 'transfer', 'store_credit') then
      raise exception 'invalid_refund_method';
    end if;

    if v_method = 'transfer' and p_bank_card_id is null then
      raise exception 'refund_bank_card_required';
    end if;

    if v_currency is null or length(v_currency) <> 3 then
      raise exception 'invalid_refund_currency';
    end if;

    -- Solo una cuenta bancaria de la misma empresa.
    if v_method = 'transfer' then
      if not exists (
        select 1
          from public.bank_accounts ba
         where ba.id = p_bank_card_id
           and ba.company_id = p_company_id
      ) then
        raise exception 'refund_bank_card_not_found';
      end if;
    end if;

    -- Idempotencia: mismo pago repetido no toca la fila.
    if v_row.refund_status = 'paid'
       and round(coalesce(v_row.refund_amount, 0), 6) = v_amount
       and v_row.refund_currency_code is not distinct from v_currency
       and v_row.refund_method is not distinct from v_method then
      return jsonb_build_object(
        'success', true,
        'already_paid', true,
        'refund_status', v_row.refund_status,
        'refunded_at', v_row.refunded_at
      );
    end if;

    v_refunded_at := coalesce(v_row.refunded_at, timezone('utc', now()));
  else
    v_refunded_at := v_row.refunded_at;
  end if;

  update public.sales_returns
     set refund_status = v_status,
         refund_amount = v_amount,
         refund_currency_code = v_currency,
         refund_method = v_method,
         refund_bank_card_id = p_bank_card_id,
         refund_transaction_id = p_transaction_id,
         refunded_at = v_refunded_at,
         updated_at = timezone('utc', now())
   where id = p_return_id
     and company_id = p_company_id;

  return jsonb_build_object(
    'success', true,
    'already_paid', false,
    'refund_status', v_status,
    'refunded_at', v_refunded_at
  );
end;
$function$;

revoke all on function public.palmyra_record_return_refund(uuid, uuid, text, numeric, text, text, uuid, uuid)
  from public, anon;
grant execute on function public.palmyra_record_return_refund(uuid, uuid, text, numeric, text, text, uuid, uuid)
  to authenticated;

commit;
