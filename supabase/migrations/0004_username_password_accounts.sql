-- Admin-created username/password accounts (auth user lives in auth.users; this
-- table records which accounts are authorized + their username/label).
create table if not exists public.app_users (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null,
  label      text,
  created_at timestamptz not null default now()
);
alter table public.app_users enable row level security;  -- private (service role only)

-- Unified access check: allowlisted phone OR an admin-created login account.
create or replace function public.has_access()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_allowed_phone()
      or exists (select 1 from public.app_users where id = auth.uid());
$$;
revoke all on function public.has_access() from public;
grant execute on function public.has_access() to authenticated;

-- Point the read policies at the unified check.
drop policy if exists "allowed read dimensions"  on public.dimensions;
drop policy if exists "allowed read transactions" on public.transactions;

create policy "access read dimensions" on public.dimensions
  for select to authenticated using (public.has_access());
create policy "access read transactions" on public.transactions
  for select to authenticated using (public.has_access());
