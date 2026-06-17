-- Run this if you already ran supabase_setup.sql before the QR solution fix.

create table if not exists public.published_solutions (
  exam_id text primary key,
  published boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

alter table public.published_solutions enable row level security;

drop policy if exists "published_solutions_public_read" on public.published_solutions;
create policy "published_solutions_public_read" on public.published_solutions
for select to anon, authenticated using (published = true);

drop policy if exists "published_solutions_admin_all" on public.published_solutions;
create policy "published_solutions_admin_all" on public.published_solutions
for all to authenticated using (public.is_admin()) with check (public.is_admin());
