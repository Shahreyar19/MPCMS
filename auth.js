(() => {
  const SESSION_KEY = 'megaprep-session-v1';
  const DASHBOARD_URL = 'index.html';
  const CLOUDFLARE_API = (window.MPQM_CLOUDFLARE_API || '').replace(/\/+$/, '');
  const BACKEND = window.MPQM_BACKEND || 'cloudflare';
  let supabaseClientPromise = null;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  function init() {
    redirectIfAdminAlreadyLoggedIn();
    bindAdminLogin();
    bindAdminSignup();
    bindStudentLogin();
    bindStudentSignup();
  }

  async function apiRequest(path, { method = 'GET', body, token = getSession()?.token } = {}) {
    if (BACKEND === 'supabase') return supabaseRequest(path, { method, body });
    if (!CLOUDFLARE_API) throw new Error('Cloudflare API URL missing.');
    const response = await fetch(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${response.status})`);
    return data;
  }

  async function supabaseRequest(path, { method = 'GET', body } = {}) {
    const client = await getSupabaseClient();
    if (path === '/auth/session') {
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData?.user) throw new Error('Login required.');
      const profile = await getProfile(client, userData.user.id);
      return { ok: true, user: profile };
    }
    if (path === '/auth/login' && method === 'POST') {
      const { data, error } = await client.auth.signInWithPassword({
        email: body.identifier,
        password: body.password,
      });
      if (error) throw error;
      const profile = await getProfile(client, data.user.id);
      if (profile.active === false) {
        await client.auth.signOut();
        throw new Error('This account is disabled.');
      }
      if (body.role === 'admin' && !['admin', 'super_admin'].includes(profile.role)) {
        await client.auth.signOut();
        throw new Error('Invalid role for this login.');
      }
      if (body.role && body.role !== 'admin' && profile.role !== body.role) {
        await client.auth.signOut();
        throw new Error('Invalid role for this login.');
      }
      return { ok: true, token: data.session.access_token, user: profile, expires_at: data.session.expires_at };
    }
    if (path === '/auth/register-admin' && method === 'POST') {
      const { data, error } = await client.auth.signUp({
        email: body.email,
        password: body.password,
        options: {
          data: {
            role: 'admin',
            full_name: body.full_name,
            department: body.department,
            phone: body.phone,
            admin_invite_code: body.invite_code,
          },
        },
      });
      if (error) throw error;
      return { ok: true, user: data.user };
    }
    if (path === '/auth/register-student' && method === 'POST') {
      const { data, error } = await client.auth.signUp({
        email: body.email,
        password: body.password,
        options: {
          data: {
            role: 'student',
            full_name: body.full_name,
            student_id: body.student_id,
            phone: body.phone,
            class_name: body.class_name,
          },
        },
      });
      if (error) throw error;
      return { ok: true, user: data.user };
    }
    throw new Error(`Unsupported Supabase path: ${path}`);
  }

  async function getSupabaseClient() {
    if (supabaseClientPromise) return supabaseClientPromise;
    supabaseClientPromise = (async () => {
      if (!window.supabase?.createClient) await loadExternalScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
      const url = window.MPQM_SUPABASE_URL;
      const anonKey = window.MPQM_SUPABASE_ANON_KEY;
      if (!url || !anonKey || /PASTE_/.test(url + anonKey)) throw new Error('Supabase URL/anon key missing in firebase-config.js.');
      return window.supabase.createClient(url, anonKey);
    })();
    return supabaseClientPromise;
  }

  async function getProfile(client, userId) {
    const { data, error } = await client.from('profiles').select('*').eq('id', userId).single();
    if (error) throw error;
    return {
      id: data.id,
      role: data.role,
      permissions: data.permissions || {},
      active: data.active !== false,
      email: data.email || '',
      student_id: data.student_id || '',
      full_name: data.full_name || '',
    };
  }

  function loadExternalScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing?.dataset.loaded === 'true') return resolve();
      const script = existing || document.createElement('script');
      script.src = src;
      script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      if (!existing) document.head.appendChild(script);
    });
  }

  async function redirectIfAdminAlreadyLoggedIn() {
    if (!/admin-login\.html|admin-signup\.html/.test(window.location.pathname)) return;
    const session = getSession();
    if (!session?.token || !['admin', 'super_admin'].includes(session?.user?.role)) return;
    try {
      await apiRequest('/auth/session');
      window.location.replace(DASHBOARD_URL);
    } catch {
      clearSession();
    }
  }

  function bindAdminLogin() {
    const form = document.getElementById('adminLoginForm');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      setBusy(submitBtn, true);
      try {
        const email = form.querySelector('input[type="email"]').value.trim();
        const password = form.querySelector('input[type="password"]').value;
        const data = await apiRequest('/auth/login', {
          method: 'POST',
          token: '',
          body: { role: 'admin', identifier: email, password },
        });
        saveSession(data);
        window.location.replace(DASHBOARD_URL);
      } catch (error) {
        alert(error?.message || 'Invalid admin credentials.');
      } finally {
        setBusy(submitBtn, false);
      }
    });
  }

  function bindAdminSignup() {
    const form = document.getElementById('adminSignupForm');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      setBusy(submitBtn, true);
      try {
        const inputs = form.querySelectorAll('input');
        const password = inputs[4].value;
        const confirm = inputs[5].value;
        if (password !== confirm) throw new Error('Password confirmation does not match.');
        await apiRequest('/auth/register-admin', {
          method: 'POST',
          token: '',
          body: {
            full_name: inputs[0].value.trim(),
            department: inputs[1].value.trim(),
            email: inputs[2].value.trim(),
            phone: inputs[3].value.trim(),
            password,
            invite_code: inputs[6].value.trim(),
          },
        });
        alert('Admin account created. Please login.');
        window.location.href = 'admin-login.html';
      } catch (error) {
        alert(error?.message || 'Admin signup failed.');
      } finally {
        setBusy(submitBtn, false);
      }
    });
  }

  function bindStudentLogin() {
    const form = document.getElementById('studentLoginForm');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      setBusy(submitBtn, true);
      try {
        const identifier = form.querySelector('input[type="text"]').value.trim();
        const password = form.querySelector('input[type="password"]').value;
        const data = await apiRequest('/auth/login', {
          method: 'POST',
          token: '',
          body: { role: 'student', identifier, password },
        });
        saveSession(data);
        window.location.href = 'student-profile.html';
      } catch (error) {
        alert(error?.message || 'Student login failed.');
      } finally {
        setBusy(submitBtn, false);
      }
    });
  }

  function bindStudentSignup() {
    const form = document.getElementById('studentSignupForm');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      setBusy(submitBtn, true);
      try {
        const inputs = form.querySelectorAll('input');
        await apiRequest('/auth/register-student', {
          method: 'POST',
          token: '',
          body: {
            full_name: inputs[0].value.trim(),
            student_id: inputs[1].value.trim(),
            email: inputs[2].value.trim(),
            phone: inputs[3].value.trim(),
            class_name: inputs[4].value.trim(),
            password: inputs[5].value,
          },
        });
        alert('Student account created. Please login.');
        window.location.href = 'student-login.html';
      } catch (error) {
        alert(error?.message || 'Student signup failed.');
      } finally {
        setBusy(submitBtn, false);
      }
    });
  }

  function saveSession(data) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      token: data.token,
      user: data.user,
      role: data.user?.role,
      identifier: data.user?.email || data.user?.student_id || data.user?.id,
      deviceId: `${data.user?.role || 'user'}-${Math.random().toString(36).slice(2, 8)}`,
      label: ['admin', 'super_admin'].includes(data.user?.role) ? 'Admin Browser Session' : 'Student Browser Session',
      expiresAt: data.expires_at,
      createdAt: new Date().toISOString(),
    }));
  }

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.dataset.originalText ||= button.textContent;
    button.textContent = busy ? 'Please wait...' : button.dataset.originalText;
  }
})();
