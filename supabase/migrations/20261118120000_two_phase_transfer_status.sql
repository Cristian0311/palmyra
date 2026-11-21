-- Two-phase inventory transfers: a dispatch leaves the origin warehouse while
-- the merchandise is in transit, and the destination confirms reception.
-- `posted` stays for historical one-step transfers; `received` supersedes it
-- for new operations.
alter type public.transfer_status add value if not exists 'in_transit';
alter type public.transfer_status add value if not exists 'received';

-- A bulk dispatch creates one transfer row per product; batch_id keeps the
-- group together so the destination can receive the whole shipment at once.
alter table public.transfers add column if not exists batch_id uuid;

create index if not exists transfers_batch_id_idx
  on public.transfers (batch_id)
  where batch_id is not null;

create index if not exists transfers_status_idx
  on public.transfers (company_id, status, created_at desc);

alter table public.transfers add column if not exists received_at timestamptz;
alter table public.transfers add column if not exists received_by uuid;
