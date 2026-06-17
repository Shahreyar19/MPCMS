-- Run once to add super admin role and per-admin permissions.
-- The first super admin is shahreyar202020@gmail.com.

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
    permissions = '{}'::jsonb,
    active = true,
    updated_at = now()
where lower(email) = lower('shahreyar202020@gmail.com')
  and role in ('admin', 'super_admin');

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

create or replace function public.list_admin_profiles()
returns table(
  id uuid,
  role text,
  full_name text,
  email text,
  permissions jsonb,
  active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Forbidden';
  end if;

  return query
  select p.id, p.role, p.full_name, p.email, coalesce(p.permissions, '{}'::jsonb), p.active, p.created_at, p.updated_at
  from public.profiles p
  where p.role in ('super_admin', 'admin')
  order by case when p.role = 'super_admin' then 0 else 1 end, p.created_at asc;
end;
$$;

create or replace function public.update_admin_permissions(
  p_admin_id uuid,
  p_permissions jsonb,
  p_active boolean default true
)
returns table(ok boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Forbidden';
  end if;

  if p_admin_id = auth.uid() then
    raise exception 'You cannot change your own super admin access.';
  end if;

  update public.profiles
  set permissions = coalesce(p_permissions, '{}'::jsonb),
      active = coalesce(p_active, true),
      updated_at = now()
  where id = p_admin_id
    and role = 'admin';

  if not found then
    raise exception 'Admin profile not found.';
  end if;

  return query select true;
end;
$$;

drop policy if exists "profiles_self_read" on public.profiles;
create policy "profiles_self_read" on public.profiles
for select to authenticated using (id = auth.uid() or public.is_super_admin());

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
for update to authenticated using (id = auth.uid())
with check (id = auth.uid());

commit;
