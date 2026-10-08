-- Enterprise security baseline: make function execution explicit for exposed public schema.
-- Existing authenticated RPC behavior is preserved; anonymous execution remains disabled.
begin;
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;
commit;
