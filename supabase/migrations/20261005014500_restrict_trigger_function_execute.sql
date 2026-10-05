-- PALMYRA security hardening
-- These functions are trigger infrastructure, not public RPC APIs.
-- Revoke the default/public role execution surface while preserving
-- explicit grants used by the application roles.
revoke execute on function public.enforce_subscription_trial_policy() from public;
revoke execute on function public.set_updated_at() from public;
