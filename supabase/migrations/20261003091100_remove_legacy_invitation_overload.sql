-- PALMYRA: remove obsolete invitation RPC overload; employee-linked invitations are canonical.
drop function if exists public.create_company_invitation(uuid,text,uuid,uuid[]);
