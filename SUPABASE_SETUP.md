# MegaPrep Supabase Setup

## What Codex Needs From You

To connect this project to your Supabase project, provide:

1. Supabase Project URL
2. Supabase anon public key
3. Admin invite code you want to use: `MPADMIN`
4. First admin email: `shahreyar202020@gmail.com`
5. Production site URL for Auth redirect/CORS settings

Do not share the service role key unless you explicitly want server-side automation. The browser app only needs the anon public key.

## 1. Create Supabase Project

1. Go to Supabase Dashboard.
2. Create a new project.
3. Copy:
   - Project URL
   - anon public key

Supabase JS uses `createClient`, `auth.signUp`, and `auth.signInWithPassword` for password auth, and RLS controls table access with `auth.uid()`.

Sources:
- https://supabase.com/docs/reference/javascript/auth-signinwithpassword
- https://supabase.com/docs/guides/database/postgres/row-level-security

## 2. Run Database Schema

Open Supabase Dashboard > SQL Editor, paste and run:

```sql
-- paste contents of supabase_setup.sql
```

If you already ran an older schema where every admin saw the same data, run this once after the main schema:

```sql
-- paste contents of supabase_migration_per_admin_workspace.sql
```

This assigns the old shared workspace to `shahreyar202020@gmail.com`; every new admin gets a separate empty workspace.

To enable Super Admin access control, run this once too:

```sql
-- paste contents of supabase_migration_super_admin_permissions.sql
```

This makes `shahreyar202020@gmail.com` the first `super_admin`. Super admin can open `super-admin.html` and choose which modules each normal admin can access.

If any normal admin can already see another admin's exams/questions/students, run this cleanup migration once:

```sql
-- paste contents of supabase_migration_strict_workspace_isolation.sql
```

This keeps the super admin workspace and clears normal-admin workspaces so leaked Question Bank/exam data disappears. After this, each admin starts with their own empty workspace unless they already create new data after the cleanup.

Then set your admin invite code:

```sql
insert into public.app_private_config (key, value)
values ('admin_invite_code', 'MPADMIN')
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
```

Or run this file in SQL Editor after the schema:

```sql
-- paste contents of supabase_seed_admin.sql
```

## 3. Configure Frontend

Edit `firebase-config.js`:

```js
window.MPQM_BACKEND = 'supabase';
window.MPQM_SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
window.MPQM_SUPABASE_ANON_KEY = 'YOUR_ANON_PUBLIC_KEY';
window.MPQM_PUBLIC_BASE_URL = 'https://your-public-site.com';
```

`MPQM_PUBLIC_BASE_URL` is required for QR codes. Do not leave it as localhost if students will scan from phones.

## 4. Auth Settings

In Supabase Dashboard > Authentication:

1. Enable Email provider.
2. For local testing, disable email confirmation:
   - Authentication > Providers > Email
   - Turn off **Confirm email**
   - Save changes
3. Add Site URL:

```text
http://localhost:5173
```

4. Add production URL later when deployed.

## 5. Create First Admin

1. Run the app.
2. Open `admin-signup.html`.
3. Use this email: `shahreyar202020@gmail.com`.
4. Enter invite code: `MPADMIN`.
5. Then login from `admin-login.html`.

## 6. Local Run

```powershell
cd "C:\Users\MegaPrep\Downloads\QM-codex-latest-szv546\QM-codex-latest-szv546"
npm run dev
```

Open:

```text
http://localhost:5173/admin-signup.html
```

## 7. Production Build

```powershell
npm run build
```

Deploy only the generated `public/` folder for the main CMS.
