-- Cost dimensions (Material, Labor, Equipment, Overhead, ...)
create table if not exists public.dimensions (
  name        text primary key,
  sort_order  int  not null default 99,
  account     text,
  period_from text,
  period_to   text,
  updated_at  timestamptz not null default now()
);

-- Flat transactions table; the viewer recomputes running balance per project (ordered by seq).
create table if not exists public.transactions (
  id            bigint generated always as identity primary key,
  cost_dimension text not null references public.dimensions(name) on delete cascade,
  project       text not null,
  seq           int  not null default 0,
  txn_date      date,
  ts            int  not null default 0,   -- yyyymmdd, for fast range filtering
  voucher_type  text,
  voucher_no    text,
  ref_no        text,
  memo          text,
  debit         numeric(18,3) not null default 0,
  credit        numeric(18,3) not null default 0
);

create index if not exists idx_txn_dimension on public.transactions (cost_dimension);
create index if not exists idx_txn_project   on public.transactions (project);
create index if not exists idx_txn_ts        on public.transactions (ts);

-- Row Level Security: public READ, no public WRITE.
alter table public.dimensions   enable row level security;
alter table public.transactions enable row level security;

drop policy if exists "public read dimensions"   on public.dimensions;
drop policy if exists "public read transactions"  on public.transactions;

create policy "public read dimensions"  on public.dimensions
  for select to anon, authenticated using (true);
create policy "public read transactions" on public.transactions
  for select to anon, authenticated using (true);

-- No insert/update/delete policies are defined, so anon/authenticated cannot write.
-- Writes happen only via the `ingest` Edge Function using the service_role key.
