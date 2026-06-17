-- Run after supabase_setup.sql.
-- This sets the admin invite code used by admin-signup.html.

insert into public.app_private_config (key, value)
values ('admin_invite_code', 'MPADMIN')
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

-- First admin email to create from the app:
-- shahreyar202020@gmail.com
