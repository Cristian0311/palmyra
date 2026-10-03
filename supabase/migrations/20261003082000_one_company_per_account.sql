-- PALMYRA: one SaaS account belongs to exactly one company
create unique index if not exists company_memberships_one_company_per_user_uidx
on public.company_memberships(user_id);
