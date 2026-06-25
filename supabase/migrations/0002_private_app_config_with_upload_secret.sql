-- Private config (RLS on, NO policies => anon/authenticated cannot read or write).
-- Only the service_role (Edge Function) can access it.
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
alter table public.app_config enable row level security;

-- Generate a random upload secret if one doesn't already exist.
insert into public.app_config (key, value)
values ('upload_secret', replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;
