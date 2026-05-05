const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.join(__dirname, 'gengo.sqlite');
const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const JSON_LIMIT_BYTES = 16 * 1024;

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = DELETE;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
`);

const statements = {
  createUser: db.prepare(`
    INSERT INTO users (email, name, password_salt, password_hash)
    VALUES (?, ?, ?, ?)
    RETURNING id, email, name
  `),
  getUserByEmail: db.prepare(`
    SELECT id, email, name, password_salt, password_hash
    FROM users
    WHERE email = ?
  `),
  createSession: db.prepare(`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (?, ?, datetime('now', ?))
  `),
  getSessionUser: db.prepare(`
    SELECT users.id, users.email, users.name
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > datetime('now')
  `),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
};

statements.deleteExpiredSessions.run();

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function text(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

function validateEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 256;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64')) {
  const hash = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
  return { salt, hash: hash.toString('base64') };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const actual = Buffer.from(hash, 'base64');
  const expected = Buffer.from(expectedHash, 'base64');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function sessionCookie(req, token) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return [
    `gengo_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_SECONDS}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function clearSessionCookie() {
  return 'gengo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const expected = new URL(`http://${req.headers.host || `${HOST}:${PORT}`}`);
    const actual = new URL(origin);
    return actual.host === expected.host;
  } catch {
    return false;
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON.');
    error.status = 400;
    throw error;
  }
}

function getUserFromRequest(req) {
  const token = parseCookies(req.headers.cookie).gengo_session;
  if (!token) return null;
  return statements.getSessionUser.get(hashSessionToken(token)) || null;
}

function createSession(req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  statements.createSession.run(userId, hashSessionToken(token), `+${SESSION_DAYS} days`);
  return sessionCookie(req, token);
}

async function handleAuth(req, res, url) {
  if (req.method !== 'GET' && !isSameOrigin(req)) {
    return json(res, 403, { error: 'Invalid request origin.' });
  }

  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const user = getUserFromRequest(req);
    return json(res, 200, { user: user ? publicUser(user) : null });
  }

  if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const name = String(body.name || '').trim();

    if (!validateEmail(email)) return json(res, 400, { error: 'Enter a valid email address.' });
    if (!validatePassword(password)) return json(res, 400, { error: 'Password must be at least 8 characters.' });
    if (!name || name.length > 80) return json(res, 400, { error: 'Enter your name.' });

    const passwordRecord = hashPassword(password);

    try {
      const user = statements.createUser.get(email, name, passwordRecord.salt, passwordRecord.hash);
      return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': createSession(req, user.id) });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067) {
        return json(res, 409, { error: 'An account already exists for that email.' });
      }
      throw error;
    }
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');

    if (!validateEmail(email) || !validatePassword(password)) {
      return json(res, 401, { error: 'Invalid email or password.' });
    }

    const user = statements.getUserByEmail.get(email);
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      return json(res, 401, { error: 'Invalid email or password.' });
    }

    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': createSession(req, user.id) });
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req.headers.cookie).gengo_session;
    if (token) statements.deleteSession.run(hashSessionToken(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  return text(res, 404, 'Not Found\n');
}

async function serveIndex(req, res) {
  const html = await fs.readFile(path.join(__dirname, 'index.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (url.pathname.startsWith('/api/auth/')) {
      return await handleAuth(req, res, url);
    }

    if ((url.pathname === '/' || url.pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      return await serveIndex(req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return text(res, 405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
    }

    return text(res, 404, 'Not Found\n');
  } catch (error) {
    console.error('Server error:', error);
    return json(res, error.status || 500, { error: error.status ? error.message : 'Internal Server Error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
  console.log(`SQLite database: ${DB_PATH}`);
});
