const SESSION_TTL_SECONDS = 60 * 60 * 12;
const PASSWORD_ITERATIONS = 210000;
const MAX_WORKSPACE_BYTES = 3_500_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return cors(request, env, new Response(null, { status: 204 }));
    if (url.pathname === '/health') return cors(request, env, json({ ok: true, service: 'mpqm-worker' }));

    try {
      if (url.pathname === '/auth/login' && method === 'POST') return cors(request, env, await login(request, env));
      if (url.pathname === '/auth/register-admin' && method === 'POST') return cors(request, env, await registerAdmin(request, env));
      if (url.pathname === '/auth/register-student' && method === 'POST') return cors(request, env, await registerStudent(request, env));
      if (url.pathname === '/auth/session' && method === 'GET') return cors(request, env, json({ ok: true, user: await requireSession(request, env) }));
      if (url.pathname === '/auth/logout' && method === 'POST') return cors(request, env, await logout(request, env));
      if (url.pathname === '/auth/change-password' && method === 'POST') {
        const user = await requireSession(request, env, 'admin');
        return cors(request, env, await changePassword(request, env, user));
      }

      if (url.pathname === '/workspace' && method === 'GET') {
        await requireSession(request, env, 'admin');
        const row = await env.DB.prepare('SELECT id, workspace_data, dark_mode, print_config, version, updated_at FROM app_settings WHERE id = 1').first();
        return cors(request, env, json({ ok: true, data: row || null }));
      }

      if (url.pathname === '/workspace' && method === 'PUT') {
        await requireSession(request, env, 'admin');
        return cors(request, env, await updateWorkspace(request, env));
      }

      if (url.pathname === '/profiles/upsert' && method === 'POST') {
        await requireSession(request, env, 'admin');
        return cors(request, env, await upsertProfile(request, env));
      }

      return cors(request, env, json({ ok: false, error: 'Not found' }, 404));
    } catch (error) {
      const status = Number(error?.status || 500);
      const message = status === 500 ? 'Internal server error' : error.message;
      return cors(request, env, json({ ok: false, error: message }, status));
    }
  },
};

async function login(request, env) {
  const payload = await readJson(request);
  const role = payload.role === 'student' ? 'student' : 'admin';
  const identifier = normalize(payload.identifier || payload.email || payload.student_id);
  const password = String(payload.password || '');
  if (!identifier || !password) throw httpError(400, 'Identifier and password are required.');

  const user = await env.DB.prepare(`
    SELECT * FROM users
    WHERE role = ? AND active = 1 AND (lower(email) = ? OR lower(student_id) = ?)
    LIMIT 1
  `).bind(role, identifier, identifier).first();
  if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash, user.iterations))) {
    throw httpError(401, 'Invalid credentials.');
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = nowSeconds() + SESSION_TTL_SECONDS;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, role, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, user.id, user.role, expiresAt)
    .run();

  return json({ ok: true, token, user: publicUser(user), expires_at: expiresAt });
}

async function registerAdmin(request, env) {
  const payload = await readJson(request);
  if (!env.ADMIN_INVITE_CODE || payload.invite_code !== env.ADMIN_INVITE_CODE) throw httpError(403, 'Invalid admin invite code.');
  return registerUser(env, {
    role: 'admin',
    email: payload.email,
    full_name: payload.full_name,
    department: payload.department,
    phone: payload.phone,
    password: payload.password,
  });
}

async function registerUser(env, input) {
  const email = normalize(input.email);
  const studentId = normalize(input.student_id);
  const fullName = String(input.full_name || '').trim();
  const password = String(input.password || '');
  if (!fullName || password.length < 8) throw httpError(400, 'Name and an 8+ character password are required.');
  if (input.role === 'admin' && !email) throw httpError(400, 'Admin email is required.');
  if (input.role === 'student' && !studentId && !email) throw httpError(400, 'Student ID or email is required.');

  const salt = randomToken(18);
  const passwordHash = await hashPassword(password, salt, PASSWORD_ITERATIONS);
  const id = `${input.role}-${crypto.randomUUID()}`;
  try {
    await env.DB.prepare(`
      INSERT INTO users (id, role, email, student_id, full_name, department, phone, class_name, password_hash, password_salt, iterations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      input.role,
      email || null,
      studentId || null,
      fullName,
      input.department || null,
      input.phone || null,
      input.class_name || null,
      passwordHash,
      salt,
      PASSWORD_ITERATIONS,
    ).run();
  } catch (error) {
    if (/unique|constraint/i.test(error?.message || '')) throw httpError(409, 'Account already exists.');
    throw error;
  }

  await env.DB.prepare(`
    INSERT INTO profiles (id, role, full_name, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET role = excluded.role, full_name = excluded.full_name, updated_at = CURRENT_TIMESTAMP
  `).bind(id, input.role, fullName).run();

  return json({ ok: true, user: { id, role: input.role, email, student_id: studentId, full_name: fullName } }, 201);
}

async function registerStudent(request, env) {
  const payload = await readJson(request);
  return registerUser(env, {
    role: 'student',
    email: payload.email,
    student_id: payload.student_id,
    full_name: payload.full_name,
    phone: payload.phone,
    class_name: payload.class_name,
    password: payload.password,
  });
}

async function changePassword(request, env, user) {
  const payload = await readJson(request);
  const current = String(payload.current_password || '');
  const next = String(payload.new_password || '');
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  if (!row || !(await verifyPassword(current, row.password_salt, row.password_hash, row.iterations))) throw httpError(403, 'Current password incorrect.');
  if (next.length < 8) throw httpError(400, 'New password must be at least 8 characters.');
  const salt = randomToken(18);
  const passwordHash = await hashPassword(next, salt, PASSWORD_ITERATIONS);
  await env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(passwordHash, salt, PASSWORD_ITERATIONS, user.id)
    .run();
  return json({ ok: true });
}

async function logout(request, env) {
  const token = bearerToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true });
}

async function updateWorkspace(request, env) {
  const payload = await readJson(request);
  const workspace = JSON.stringify(payload.workspace_data || {});
  if (workspace.length > MAX_WORKSPACE_BYTES) throw httpError(413, 'Workspace payload is too large. Store images outside workspace JSON.');
  const printConfig = JSON.stringify(payload.print_config || {});
  const darkMode = payload.dark_mode ? 1 : 0;
  const expectedVersion = Number(payload.version || 0);
  const current = await env.DB.prepare('SELECT version FROM app_settings WHERE id = 1').first();
  const currentVersion = Number(current?.version || 0);
  if (expectedVersion && currentVersion && expectedVersion !== currentVersion) {
    return json({ ok: false, error: 'Workspace changed on another device. Reload before saving.', conflict: true, version: currentVersion }, 409);
  }
  const nextVersion = currentVersion + 1;
  await env.DB.prepare(`
    INSERT INTO app_settings (id, workspace_data, dark_mode, print_config, credentials, version, updated_at)
    VALUES (1, ?, ?, ?, '{}', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      workspace_data = excluded.workspace_data,
      dark_mode = excluded.dark_mode,
      print_config = excluded.print_config,
      credentials = '{}',
      version = excluded.version,
      updated_at = CURRENT_TIMESTAMP
  `).bind(workspace, darkMode, printConfig, nextVersion).run();
  return json({ ok: true, version: nextVersion });
}

async function upsertProfile(request, env) {
  const payload = await readJson(request);
  if (!payload.id) throw httpError(400, 'id is required');
  await env.DB.prepare(`
    INSERT INTO profiles (id, role, full_name, updated_at)
    VALUES (?, COALESCE(?, 'admin'), ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      full_name = excluded.full_name,
      updated_at = CURRENT_TIMESTAMP
  `).bind(payload.id, payload.role || 'admin', payload.full_name || '').run();
  return json({ ok: true });
}

async function requireSession(request, env, role) {
  const token = bearerToken(request);
  if (!token) throw httpError(401, 'Login required.');
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT sessions.expires_at, users.id, users.role, users.email, users.student_id, users.full_name, users.active
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).bind(tokenHash).first();
  if (!row || !row.active || Number(row.expires_at) < nowSeconds()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    throw httpError(401, 'Session expired. Login again.');
  }
  if (role && row.role !== role) throw httpError(403, 'Forbidden.');
  return publicUser(row);
}

function bearerToken(request) {
  const auth = request.headers.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

async function readJson(request) {
  return request.json().catch(() => {
    throw httpError(400, 'Invalid JSON body.');
  });
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email || '',
    student_id: user.student_id || '',
    full_name: user.full_name || '',
  };
}

async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: utf8(salt), iterations, hash: 'SHA-256' }, key, 256);
  return base64(bits);
}

async function verifyPassword(password, salt, expected, iterations) {
  const actual = await hashPassword(password, salt, iterations || PASSWORD_ITERATIONS);
  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', utf8(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data)).replace(/[+/=]/g, '');
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function base64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function cors(request, env, response) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!origin) {
    headers.set('access-control-allow-origin', 'null');
  } else if (!allowed.length || allowed.includes(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }
  headers.set('access-control-allow-methods', 'GET,PUT,POST,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type,authorization');
  return new Response(response.body, { status: response.status, headers });
}
