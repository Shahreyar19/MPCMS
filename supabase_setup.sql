-- MegaPrep Supabase production schema.
-- Run in Supabase Dashboard > SQL Editor.

begin;

create extension if not exists "pgcrypto";

create table if not exists public.app_private_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'student' check (role in ('admin', 'student')),
  full_name text not null default '',
  email text,
  student_id text,
  phone text,
  class_name text,
  department text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_email_unique on public.profiles (lower(email)) where email is not null and email <> '';
create unique index if not exists profiles_student_id_unique on public.profiles (lower(student_id)) where student_id is not null and student_id <> '';

create table if not exists public.app_settings (
  id integer primary key check (id = 1),
  workspace_data jsonb not null default '{}'::jsonb,
  dark_mode boolean not null default false,
  print_config jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.app_settings (id) values (1)
on conflict (id) do nothing;

create table if not exists public.exams (
  id text primary key,
  owner_id uuid references public.profiles(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  published boolean not null default false,
  solution_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.questions (
  id text primary key,
  owner_id uuid references public.profiles(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.students (
  id text primary key,
  profile_id uuid references public.profiles(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attempts (
  id text primary key,
  exam_id text,
  student_id text,
  payload jsonb not null default '{}'::jsonb,
  score numeric not null default 0,
  total numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.omr_uploads (
  id uuid primary key default gen_random_uuid(),
  attempt_id text references public.attempts(id) on delete cascade,
  exam_id text,
  student_id text,
  file_path text,
  template_version text,
  detected jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.published_solutions (
  exam_id text primary key,
  published boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and active = true
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_role text;
  invite_code text;
  expected_code text;
begin
  requested_role := coalesce(new.raw_user_meta_data ->> 'role', 'student');
  invite_code := coalesce(new.raw_user_meta_data ->> 'admin_invite_code', '');

  if requested_role = 'admin' then
    select value into expected_code
    from public.app_private_config
    where key = 'admin_invite_code';

    if expected_code is null or invite_code <> expected_code then
      raise exception 'Invalid admin invite code';
    end if;
  end if;

  insert into public.profiles (
    id,
    role,
    full_name,
    email,
    student_id,
    phone,
    class_name,
    department
  )
  values (
    new.id,
    case when requested_role = 'admin' then 'admin' else 'student' end,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.email,
    nullif(new.raw_user_meta_data ->> 'student_id', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    nullif(new.raw_user_meta_data ->> 'class_name', ''),
    nullif(new.raw_user_meta_data ->> 'department', '')
  )
  on conflict (id) do update set
    full_name = excluded.full_name,
    email = excluded.email,
    student_id = excluded.student_id,
    phone = excluded.phone,
    class_name = excluded.class_name,
    department = excluded.department,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.save_workspace(
  p_workspace_data jsonb,
  p_dark_mode boolean,
  p_print_config jsonb,
  p_expected_version integer
)
returns table(ok boolean, version integer, conflict boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_version integer;
  next_version integer;
begin
  if not public.is_admin() then
    raise exception 'Forbidden';
  end if;

  select app_settings.version into current_version
  from public.app_settings
  where id = 1
  for update;

  if current_version is null then
    insert into public.app_settings (id) values (1);
    current_version := 0;
  end if;

  if p_expected_version is not null and p_expected_version > 0 and p_expected_version <> current_version then
    return query select false, current_version, true;
    return;
  end if;

  next_version := current_version + 1;

  update public.app_settings
  set workspace_data = coalesce(p_workspace_data, '{}'::jsonb),
      dark_mode = coalesce(p_dark_mode, false),
      print_config = coalesce(p_print_config, '{}'::jsonb),
      version = next_version,
      updated_at = now(),
      updated_by = auth.uid()
  where id = 1;

  return query select true, next_version, false;
end;
$$;

alter table public.app_private_config enable row level security;
alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.exams enable row level security;
alter table public.questions enable row level security;
alter table public.students enable row level security;
alter table public.attempts enable row level security;
alter table public.omr_uploads enable row level security;
alter table public.published_solutions enable row level security;

drop policy if exists "app_private_config_admin_read" on public.app_private_config;
create policy "app_private_config_admin_read" on public.app_private_config
for select to authenticated using (public.is_admin());

drop policy if exists "profiles_self_read" on public.profiles;
create policy "profiles_self_read" on public.profiles
for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
for update to authenticated using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

drop policy if exists "app_settings_admin_read" on public.app_settings;
create policy "app_settings_admin_read" on public.app_settings
for select to authenticated using (public.is_admin());

drop policy if exists "app_settings_admin_update" on public.app_settings;
create policy "app_settings_admin_update" on public.app_settings
for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "exams_admin_all" on public.exams;
create policy "exams_admin_all" on public.exams
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "questions_admin_all" on public.questions;
create policy "questions_admin_all" on public.questions
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "students_admin_all" on public.students;
create policy "students_admin_all" on public.students
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "attempts_admin_all" on public.attempts;
create policy "attempts_admin_all" on public.attempts
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "omr_uploads_admin_all" on public.omr_uploads;
create policy "omr_uploads_admin_all" on public.omr_uploads
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "published_solutions_public_read" on public.published_solutions;
create policy "published_solutions_public_read" on public.published_solutions
for select to anon, authenticated using (published = true);

drop policy if exists "published_solutions_admin_all" on public.published_solutions;
create policy "published_solutions_admin_all" on public.published_solutions
for all to authenticated using (public.is_admin()) with check (public.is_admin());

commit;
