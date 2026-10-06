revoke all on function public.get_platform_support_settings() from public;
revoke all on function public.get_platform_support_settings() from anon;
grant execute on function public.get_platform_support_settings() to authenticated;

revoke all on function public.set_platform_support_settings(text,text,text) from public;
revoke all on function public.set_platform_support_settings(text,text,text) from anon;
grant execute on function public.set_platform_support_settings(text,text,text) to authenticated;

revoke all on function public.create_support_request(text,text,text,text,jsonb) from public;
revoke all on function public.create_support_request(text,text,text,text,jsonb) from anon;
grant execute on function public.create_support_request(text,text,text,text,jsonb) to authenticated;

revoke all on function public.get_platform_support_requests(text,integer) from public;
revoke all on function public.get_platform_support_requests(text,integer) from anon;
grant execute on function public.get_platform_support_requests(text,integer) to authenticated;
