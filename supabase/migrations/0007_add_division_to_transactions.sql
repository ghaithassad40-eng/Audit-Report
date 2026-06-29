-- Add Division (a grouping level above Cost Dimension). Empty string = no division.
alter table public.transactions add column if not exists division text not null default '';
create index if not exists idx_txn_division on public.transactions (division);
create index if not exists idx_txn_div_dim_proj_seq on public.transactions (division, cost_dimension, project, seq);
