-- Performance: evaluate has_access() ONCE per query (not per row) and add a
-- composite index matching the viewer's ORDER BY. Without this, reads of many
-- rows hit "canceling statement due to statement timeout".
drop policy if exists "access read dimensions"  on public.dimensions;
drop policy if exists "access read transactions" on public.transactions;

create policy "access read dimensions" on public.dimensions
  for select to authenticated using ((select public.has_access()));
create policy "access read transactions" on public.transactions
  for select to authenticated using ((select public.has_access()));

create index if not exists idx_txn_dim_proj_seq
  on public.transactions (cost_dimension, project, seq);
