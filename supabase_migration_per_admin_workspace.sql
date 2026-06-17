-- Run this once if your Supabase database was created before per-admin workspaces.
-- It assigns the existing shared workspace to the first admin below, then every
-- admin account gets its own isolated app_settings row.

begin;

alter table public.app_settings
add column if not exists owner_id uuid references public.profiles(id) on delete cascade;

alter table public.students
add column if not exists owner_id uuid references public.profiles(id) on delete set null;

alter table public.attempts
add column if not exists owner_id uuid references public.profiles(id) on delete set null;

alter table public.published_solutions
add column if not exists owner_id uuid references public.profiles(id) on delete set null;

do $$
declare
  first_admin_id uuid;
  old_check_name text;
begin
  select id into first_admin_id
  from public.profiles
  where role = 'admin'
    and lower(email) = lower('shahreyar202020@gmail.com')
  limit 1;

  if first_admin_id is null then
    select id into first_admin_id
    from public.profiles
    where role = 'admin'
    order by created_at asc
    limit 1;
  end if;

  if first_admin_id is null then
    raise exception 'No admin profile found. Create/login the first admin, then run this migration again.';
  end if;

  update public.app_settings
  set owner_id = coalesce(owner_id, updated_by, first_admin_id),
      updated_by = coalesce(updated_by, first_admin_id)
  where owner_id is null;

  update public.exams
  set owner_id = coalesce(owner_id, first_admin_id)
  where owner_id is null;

  update public.questions
  set owner_id = coalesce(owner_id, first_admin_id)
  where owner_id is null;

  update public.students
  set owner_id = coalesce(owner_id, first_admin_id)
  where owner_id is null;

  update public.attempts
  set owner_id = coalesce(owner_id, first_admin_id)
  where owner_id is null;

  update public.omr_uploads
  set created_by = coalesce(created_by, first_admin_id)
  where created_by is null;

  update public.published_solutions
  set owner_id = coalesce(owner_id, updated_by, first_admin_id),
      updated_by = coalesce(updated_by, first_admin_id)
  where owner_id is null;

  select conname into old_check_name
  from pg_constraint
  where conrelid = 'public.app_settings'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%id = 1%';

  if old_check_name is not null then
    execute format('alter table public.app_settings drop constraint %I', old_check_name);
  end if;
end $$;

create unique index if not exists app_settings_owner_unique
on public.app_settings (owner_id);

alter table public.app_settings
alter column owner_id set not null;

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
  where owner_id = auth.uid()
  for update;

  if current_version is null then
    insert into public.app_settings (id, owner_id)
    values (
      coalesce((select max(id) + 1 from public.app_settings), 1),
      auth.uid()
    );
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
  where owner_id = auth.uid();

  return query select true, next_version, false;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('super_admin', 'admin')
      and active = true
  );
$$;

drop policy if exists "profiles_self_read" on public.profiles;
create policy "profiles_self_read" on public.profiles
for select to authenticated using (id = auth.uid());

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
for update to authenticated using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "app_settings_admin_read" on public.app_settings;
create policy "app_settings_admin_read" on public.app_settings
for select to authenticated using (public.is_admin() and owner_id = auth.uid());

drop policy if exists "app_settings_admin_update" on public.app_settings;
create policy "app_settings_admin_update" on public.app_settings
for update to authenticated using (public.is_admin() and owner_id = auth.uid())
with check (public.is_admin() and owner_id = auth.uid());

drop policy if exists "exams_admin_all" on public.exams;
create policy "exams_admin_all" on public.exams
for all to authenticated using (public.is_admin() and owner_id = auth.uid())
with check (public.is_admin() and owner_id = auth.uid());

drop policy if exists "questions_admin_all" on public.questions;
create policy "questions_admin_all" on public.questions
for all to authenticated using (public.is_admin() and owner_id = auth.uid())
with check (public.is_admin() and owner_id = auth.uid());

drop policy if exists "students_admin_all" on public.students;
create policy "students_admin_all" on public.students
for all to authenticated using (public.is_admin() and owner_id = auth.uid())
with check (public.is_admin() and owner_id = auth.uid());

drop policy if exists "attempts_admin_all" on public.attempts;
create policy "attempts_admin_all" on public.attempts
for all to authenticated using (public.is_admin() and owner_id = auth.uid())
with check (public.is_admin() and owner_id = auth.uid());

drop policy if exists "omr_uploads_admin_all" on public.omr_uploads;
create policy "omr_uploads_admin_all" on public.omr_uploads
for all to authenticated using (public.is_admin() and created_by = auth.uid())
with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "published_solutions_admin_all" on public.published_solutions;
create policy "published_solutions_admin_all" on public.published_solutions
for all to authenticated using (public.is_admin() and owner_id = auth.uid())
with check (public.is_admin() and owner_id = auth.uid());

commit;
