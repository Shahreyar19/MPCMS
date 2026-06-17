-- Run this if any normal admin can see another admin/super-admin workspace.
-- It keeps the super admin workspace, creates empty workspaces for every admin,
-- and clears normal-admin workspace JSON to remove leaked Question Bank/exam data.

begin;

alter table public.profiles
add column if not exists permissions jsonb not null default '{}'::jsonb;

alter table public.profiles
drop constraint if exists profiles_role_check;

alter table public.profiles
add constraint profiles_role_check
check (role in ('super_admin', 'admin', 'student'));

update public.profiles
set role = 'super_admin',
    active = true,
    updated_at = now()
where lower(email) = lower('shahreyar202020@gmail.com')
  and role in ('admin', 'super_admin');

alter table public.app_settings
add column if not exists owner_id uuid references public.profiles(id) on delete cascade;

do $$
declare
  super_admin_id uuid;
  old_check_name text;
begin
  select id into super_admin_id
  from public.profiles
  where role = 'super_admin'
  order by created_at asc
  limit 1;

  if super_admin_id is null then
    select id into super_admin_id
    from public.profiles
    where role = 'admin'
    order by created_at asc
    limit 1;
  end if;

  if super_admin_id is null then
    raise exception 'No admin profile found. Create the first admin, then run this migration again.';
  end if;

  select conname into old_check_name
  from pg_constraint
  where conrelid = 'public.app_settings'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%id = 1%';

  if old_check_name is not null then
    execute format('alter table public.app_settings drop constraint %I', old_check_name);
  end if;

  update public.app_settings
  set owner_id = coalesce(owner_id, updated_by, super_admin_id),
      updated_by = coalesce(updated_by, super_admin_id)
  where owner_id is null;
end $$;

delete from public.app_settings newer
using public.app_settings older
where newer.owner_id = older.owner_id
  and newer.owner_id is not null
  and newer.id > older.id;

create unique index if not exists app_settings_owner_unique
on public.app_settings (owner_id);

insert into public.app_settings (id, owner_id, workspace_data, dark_mode, print_config, version, updated_by)
select
  coalesce((select max(id) from public.app_settings), 0)
    + row_number() over (order by p.created_at),
  p.id,
  '{}'::jsonb,
  false,
  '{}'::jsonb,
  0,
  p.id
from public.profiles p
where p.role in ('super_admin', 'admin')
  and not exists (
    select 1
    from public.app_settings s
    where s.owner_id = p.id
  );

-- Clear normal-admin workspaces so leaked super-admin Question Bank/exam data disappears.
update public.app_settings s
set workspace_data = '{}'::jsonb,
    dark_mode = false,
    print_config = '{}'::jsonb,
    version = s.version + 1,
    updated_at = now(),
    updated_by = s.owner_id
from public.profiles p
where p.id = s.owner_id
  and p.role = 'admin';

alter table public.app_settings
alter column owner_id set not null;

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

create or replace function public.is_super_admin()
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
      and role = 'super_admin'
      and active = true
  );
$$;

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
    insert into public.app_settings (id, owner_id, workspace_data, dark_mode, print_config, updated_by)
    values (
      coalesce((select max(id) + 1 from public.app_settings), 1),
      auth.uid(),
      '{}'::jsonb,
      false,
      '{}'::jsonb,
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

drop policy if exists "app_settings_admin_read" on public.app_settings;
create policy "app_settings_admin_read" on public.app_settings
for select to authenticated using (public.is_admin() and owner_id = auth.uid());

drop policy if exists "app_settings_admin_update" on public.app_settings;
create policy "app_settings_admin_update" on public.app_settings
for update to authenticated using (public.is_admin() and owner_id = auth.uid())
with check (public.is_admin() and owner_id = auth.uid());

drop policy if exists "app_settings_admin_insert" on public.app_settings;
create policy "app_settings_admin_insert" on public.app_settings
for insert to authenticated with check (public.is_admin() and owner_id = auth.uid());

commit;
