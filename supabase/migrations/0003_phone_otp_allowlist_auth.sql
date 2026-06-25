-- Switch from public read to authenticated + allowlisted read (phone OTP login).

-- Allowlist of approved phone numbers (digits only, E.164 without '+').
create table if not exists public.allowed_users (
  phone    text primary key,
  label    text,
  added_at timestamptz not null default now()
);
alter table public.allowed_users enable row level security;  -- no policies => private (service role only)

-- True when the logged-in user's phone (from JWT) is on the allowlist.
-- SECURITY DEFINER so the policy can read allowed_users despite its RLS.
create or replace function public.is_allowed_phone()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_users
    where phone = regexp_replace(coalesce(auth.jwt() ->> 'phone', ''), '\D', '', 'g')
  );
$$;
revoke all on function public.is_allowed_phone() from public;
grant execute on function public.is_allowed_phone() to authenticated;

-- Replace public-read policies with allowlisted authenticated read.
drop policy if exists "public read dimensions"  on public.dimensions;
drop policy if exists "public read transactions" on public.transactions;

create policy "allowed read dimensions" on public.dimensions
  for select to authenticated using (public.is_allowed_phone());
create policy "allowed read transactions" on public.transactions
  for select to authenticated using (public.is_allowed_phone());

-- Add approved numbers like this (digits only, no '+'):
--   insert into public.allowed_users (phone, label) values ('96550000000', 'Ghaith') on conflict do nothing;
