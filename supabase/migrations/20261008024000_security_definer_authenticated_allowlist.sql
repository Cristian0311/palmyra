begin;

-- PALMYRA: SECURITY DEFINER execution allowlist.
-- Internal/legacy SECURITY DEFINER functions remain usable by trusted
-- database code, but are no longer callable by authenticated users through
-- the Data API. Only the verified application/admin RPC surface is granted.
do $$
declare
  r record;
  client_rpc constant text[] := array[
    'palmyra_adjust_inventory','palmyra_approve_audit','palmyra_archive_product',
    'palmyra_bank_internal_transfer','palmyra_cancel_cash_session','palmyra_close_cash_session',
    'palmyra_complete_audit','palmyra_complete_return','palmyra_create_return',
    'palmyra_delete_bank_internal_transfer','palmyra_delete_bank_transaction',
    'palmyra_delete_cash_movement','palmyra_list_open_cash_sessions',
    'palmyra_onboard_company','palmyra_onboard_company_with_payment',
    'palmyra_onboard_company_with_payment_v2','palmyra_open_cash_session',
    'palmyra_process_bank_transaction','palmyra_receive_purchase','palmyra_record_cash_movement',
    'palmyra_record_sale','palmyra_request_audit_recount','palmyra_reserve_ncf_range',
    'palmyra_save_audit_count','palmyra_start_audit','palmyra_transfer_inventory',
    'palmyra_update_cash_session_metadata','palmyra_update_sale_metadata','palmyra_void_sale',
    'sync_product_secure','ensure_cash_register_secure','create_employee_secure',
    'create_employee_with_invitation','create_employee_pos_secure','verify_employee_pos_password',
    'create_company_invitation','revoke_company_invitation','delete_company_employee',
    'set_company_employee_status','accept_company_invitation','upsert_company_role',
    'get_compensation_settings','upsert_compensation_settings','set_employee_compensation',
    'get_my_devices','register_current_device','revoke_my_device','revoke_other_devices',
    'touch_current_device','get_my_plan_request','get_my_billing_invoices','select_company_plan',
    'select_company_plan_with_payment','has_pending_plan_request','is_current_device_active',
    'verify_pos_access_password','get_platform_companies','get_pending_plan_requests',
    'approve_plan_request','reject_plan_request','set_platform_company_status',
    'set_platform_company_plan','get_platform_support_settings','get_platform_support_requests',
    'set_platform_support_settings','create_support_request','get_company_members_for_admin',
    'get_platform_plans','get_platform_control_center','get_platform_infrastructure_metrics',
    'update_platform_plan','set_manual_cash_payment'
  ];
begin
  for r in
    select p.oid, n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    if r.proname = any(client_rpc) then
      execute format('grant execute on function %I.%I(%s) to authenticated',
        r.nspname, r.proname, r.args);
    else
      execute format('revoke execute on function %I.%I(%s) from authenticated',
        r.nspname, r.proname, r.args);
    end if;
  end loop;
end
$$;

revoke execute on function public.next_billing_invoice_number(uuid) from authenticated;
revoke execute on function public.platform_database_size_bytes() from authenticated;
revoke execute on function public.process_subscription_expirations() from authenticated;

commit;
