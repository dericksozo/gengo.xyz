const http = require('node:http');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fsSync.existsSync(envPath)) return;
  const lines = fsSync.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.join(__dirname, 'gengo.sqlite');
const UPLOAD_ROOT = path.join(__dirname, 'uploads', 'audio');
const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const JSON_LIMIT_BYTES = 16 * 1024;
const CALLBACK_JSON_LIMIT_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 1024 * 1024 * 1024);
const AUDIO_URL_TTL_HOURS = Number(process.env.AUDIO_URL_TTL_HOURS || 24);
const LEMONFOX_ENDPOINT = process.env.LEMONFOX_ENDPOINT || 'https://api.lemonfox.ai/v1/audio/transcriptions';
const LEMONFOX_API_KEY = process.env.LEMONFOX_API_KEY || '';

const ALLOWED_AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.flac', '.aac', '.opus', '.ogg', '.m4a',
  '.mp4', '.mpeg', '.mpg', '.mov', '.webm', '.m4v',
]);

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

  CREATE TABLE IF NOT EXISTS audio_uploads (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploaded',
    lemonfox_request_json TEXT,
    lemonfox_submit_response_json TEXT,
    lemonfox_response_json TEXT,
    lemonfox_error TEXT,
    file_token_hash TEXT NOT NULL UNIQUE,
    file_token_expires_at TEXT NOT NULL,
    callback_token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    submitted_at TEXT,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS audio_uploads_user_id_idx ON audio_uploads(user_id);
  CREATE INDEX IF NOT EXISTS audio_uploads_file_token_hash_idx ON audio_uploads(file_token_hash);
  CREATE INDEX IF NOT EXISTS audio_uploads_callback_token_hash_idx ON audio_uploads(callback_token_hash);
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
  createAudioUpload: db.prepare(`
    INSERT INTO audio_uploads (
      user_id, title, original_filename, stored_filename, storage_path, mime_type,
      size_bytes, status, file_token_hash, file_token_expires_at, callback_token_hash
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, datetime('now', ?), ?)
    RETURNING id, user_id, title, original_filename, mime_type, size_bytes, status, created_at, updated_at, completed_at
  `),
  listAudioUploads: db.prepare(`
    SELECT id, title, original_filename, mime_type, size_bytes, status, lemonfox_error, created_at, updated_at, submitted_at, completed_at
    FROM audio_uploads
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `),
  getAudioUploadForUser: db.prepare(`
    SELECT id, title, original_filename, mime_type, size_bytes, status, lemonfox_error, lemonfox_response_json, created_at, updated_at, submitted_at, completed_at
    FROM audio_uploads
    WHERE id = ? AND user_id = ?
  `),
  getAudioUploadForSourceToken: db.prepare(`
    SELECT id, original_filename, storage_path, mime_type, size_bytes
    FROM audio_uploads
    WHERE id = ?
      AND file_token_hash = ?
      AND file_token_expires_at > datetime('now')
  `),
  getAudioUploadForCallbackToken: db.prepare(`
    SELECT id
    FROM audio_uploads
    WHERE id = ?
      AND callback_token_hash = ?
  `),
  markAudioSubmitted: db.prepare(`
    UPDATE audio_uploads
    SET status = ?, lemonfox_request_json = ?, lemonfox_submit_response_json = ?, lemonfox_error = NULL,
        submitted_at = COALESCE(submitted_at, datetime('now')), updated_at = datetime('now')
    WHERE id = ?
  `),
  markAudioError: db.prepare(`
    UPDATE audio_uploads
    SET status = 'error', lemonfox_error = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  completeAudioUpload: db.prepare(`
    UPDATE audio_uploads
    SET status = 'completed', lemonfox_response_json = ?, lemonfox_error = NULL,
        completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `),
};

statements.deleteExpiredSessions.run();

function redactedPath(url) {
  const redacted = url.pathname
    .replace(/^(\/api\/audio\/source\/\d+)\/[^/]+$/, '$1/[redacted]')
    .replace(/^(\/api\/audio\/lemonfox\/callback\/\d+)\/[^/]+$/, '$1/[redacted]');
  const queryKeys = [...url.searchParams.keys()];
  return queryKeys.length ? `${redacted}?${queryKeys.map((key) => `${key}=[redacted]`).join('&')}` : redacted;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || null;
}

function logUser(req) {
  if (req.logUser) return req.logUser;

  try {
    const user = getUserFromRequest(req);
    return user ? publicUser(user) : null;
  } catch {
    return null;
  }
}

function setLogUser(req, user) {
  if (user) req.logUser = publicUser(user);
}

function logLine(level, message, detail = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...detail,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') return console.error(line);
  if (level === 'warn') return console.warn(line);
  return console.log(line);
}

function errorDetail(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
    stack: process.env.LOG_STACKS === '1' ? error?.stack : undefined,
  };
}

function captureRequestLog(req, res, url) {
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();
  const entry = {
    timestamp: startedIso,
    method: req.method,
    path: redactedPath(url),
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] || null,
    referer: req.headers.referer || null,
    user: null,
    status: null,
    durationMs: null,
  };
  req.requestLog = entry;
  req.requestStartedAt = startedAt;

  logLine('info', 'request_started', {
    method: entry.method,
    path: entry.path,
    ip: entry.ip,
    userAgent: entry.userAgent,
    referer: entry.referer,
  });

  let logged = false;
  const writeEntry = () => {
    if (logged) return;
    logged = true;
    entry.status = res.statusCode;
    entry.durationMs = Date.now() - startedAt;
    entry.user = logUser(req);
    const level = entry.error || entry.status >= 500 ? 'error' : entry.status >= 400 ? 'warn' : 'info';
    logLine(level, 'request_finished', entry);
  };

  res.on('finish', writeEntry);
  res.on('close', () => {
    if (!res.writableEnded && !entry.error) {
      entry.error = {
        status: res.statusCode || null,
        message: 'Response closed before finish.',
      };
    }
    writeEntry();
  });

  return entry;
}

function requestLogElapsedMs(req) {
  return req.requestStartedAt ? Date.now() - req.requestStartedAt : null;
}

function addRequestLogDetail(req, detail) {
  if (!req.requestLog) return;
  req.requestLog.details = { ...(req.requestLog.details || {}), ...detail };
}

function addRequestLogEvent(req, event, detail = {}) {
  if (!req.requestLog) return;
  const entry = {
    event,
    atMs: requestLogElapsedMs(req),
    ...detail,
  };
  if (!Array.isArray(req.requestLog.events)) req.requestLog.events = [];
  req.requestLog.events.push(entry);
  logLine('info', event, {
    request: {
      method: req.requestLog.method,
      path: req.requestLog.path,
      user: logUser(req),
    },
    ...entry,
  });
}

function markRequestLogError(req, status, message, detail = {}) {
  if (!req.requestLog) return;
  req.requestLog.error = {
    status,
    message,
    ...detail,
  };
  logLine(status >= 500 ? 'error' : 'warn', 'request_error', {
    request: {
      method: req.requestLog.method,
      path: req.requestLog.path,
      user: logUser(req),
    },
    status,
    error: message,
    ...detail,
  });
}

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

function hashSecret(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function makeSecret() {
  return crypto.randomBytes(32).toString('base64url');
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

function requireUser(req, res) {
  const user = getUserFromRequest(req);
  if (!user) {
    markRequestLogError(req, 401, 'Authentication required.');
    json(res, 401, { error: 'Sign in before uploading audio.' });
    return null;
  }
  setLogUser(req, user);
  return user;
}

function safeOriginalFilename(value) {
  const fallback = 'audio-upload';
  const name = path.basename(String(value || fallback)).replace(/[^\w .()\-]+/g, '_').trim();
  return name.slice(0, 180) || fallback;
}

function audioExtensionFor(filename, contentType) {
  const ext = path.extname(filename).toLowerCase();
  if (ALLOWED_AUDIO_EXTENSIONS.has(ext)) return ext;

  const subtype = String(contentType || '').split(';')[0].toLowerCase();
  const byMime = {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/flac': '.flac',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-m4v': '.m4v',
  };
  return byMime[subtype] || '';
}

function publicBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

function publicAudioUpload(row) {
  return {
    id: row.id,
    title: row.title,
    filename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    error: row.lemonfox_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    completedAt: row.completed_at || null,
  };
}

function transcriptForAudioUpload(row, req = null) {
  if (!row?.lemonfox_response_json) return null;
  try {
    return JSON.parse(row.lemonfox_response_json);
  } catch {
    if (req) addRequestLogEvent(req, 'audio_transcript_parse_failed', { uploadId: row.id });
    return null;
  }
}

async function writeRequestBodyToFile(req, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength && contentLength > MAX_AUDIO_BYTES) {
    const error = new Error('Audio file is too large.');
    error.status = 413;
    throw error;
  }

  const out = fsSync.createWriteStream(destinationPath, { flags: 'wx' });
  let size = 0;

  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) {
        const error = new Error('Audio file is too large.');
        error.status = 413;
        throw error;
      }
      if (!out.write(chunk)) {
        await new Promise((resolve, reject) => {
          out.once('drain', resolve);
          out.once('error', reject);
        });
      }
    }
  } catch (error) {
    out.destroy();
    await fs.rm(destinationPath, { force: true }).catch(() => {});
    throw error;
  }

  await new Promise((resolve, reject) => {
    out.end(resolve);
    out.once('error', reject);
  });

  if (size === 0) {
    await fs.rm(destinationPath, { force: true }).catch(() => {});
    const error = new Error('Choose an audio file to upload.');
    error.status = 400;
    throw error;
  }

  return size;
}

function parseUploadIdAndToken(pathname, prefix) {
  const parts = pathname.slice(prefix.length).split('/').filter(Boolean);
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return null;
  return { id: Number(parts[0]), token: parts[1] };
}

async function readJsonWithLimit(req, limitBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
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
      setLogUser(req, user);
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

    setLogUser(req, user);
    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': createSession(req, user.id) });
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const user = getUserFromRequest(req);
    setLogUser(req, user);
    const token = parseCookies(req.headers.cookie).gengo_session;
    if (token) statements.deleteSession.run(hashSessionToken(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  return text(res, 404, 'Not Found\n');
}

async function submitToLemonfox(req, upload, fileToken, callbackToken) {
  const sourceUrl = `${publicBaseUrl(req)}/api/audio/source/${upload.id}/${fileToken}`;
  const callbackUrl = `${publicBaseUrl(req)}/api/audio/lemonfox/callback/${upload.id}/${callbackToken}`;
  const requestRecord = {
    endpoint: LEMONFOX_ENDPOINT,
    file_url_path: `/api/audio/source/${upload.id}/[redacted]`,
    callback_url_path: `/api/audio/lemonfox/callback/${upload.id}/[redacted]`,
    language: 'japanese',
    response_format: 'verbose_json',
    speaker_labels: true,
    translate: false,
  };

  if (!LEMONFOX_API_KEY) {
    addRequestLogEvent(req, 'lemonfox_submit_skipped', {
      uploadId: upload.id,
      reason: 'missing_api_key',
    });
    statements.markAudioError.run('Set LEMONFOX_API_KEY before submitting audio to Lemonfox.', upload.id);
    return;
  }

  const form = new FormData();
  form.append('file', sourceUrl);
  form.append('language', 'japanese');
  form.append('response_format', 'verbose_json');
  form.append('speaker_labels', 'true');
  form.append('translate', 'false');
  form.append('callback_url', callbackUrl);

  try {
    addRequestLogEvent(req, 'lemonfox_submit_started', {
      uploadId: upload.id,
      endpoint: LEMONFOX_ENDPOINT,
      fileUrlPath: requestRecord.file_url_path,
      callbackUrlPath: requestRecord.callback_url_path,
    });

    const response = await fetch(LEMONFOX_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LEMONFOX_API_KEY}` },
      body: form,
    });

    const bodyText = await response.text();
    let submitResponse;
    try {
      submitResponse = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      submitResponse = { raw: bodyText };
    }

    addRequestLogEvent(req, 'lemonfox_submit_response', {
      uploadId: upload.id,
      status: response.status,
      ok: response.ok,
      bodyBytes: Buffer.byteLength(bodyText),
    });

    if (!response.ok) {
      const message = submitResponse.error || submitResponse.message || `Lemonfox returned ${response.status}.`;
      addRequestLogDetail(req, {
        lemonfox: {
          uploadId: upload.id,
          status: response.status,
          error: String(message),
        },
      });
      statements.markAudioError.run(String(message), upload.id);
      return;
    }

    const status = submitResponse.text || submitResponse.segments ? 'completed' : 'processing';
    if (status === 'completed') {
      statements.completeAudioUpload.run(JSON.stringify(submitResponse), upload.id);
    }
    statements.markAudioSubmitted.run(status, JSON.stringify(requestRecord), JSON.stringify(submitResponse), upload.id);
    addRequestLogEvent(req, 'lemonfox_submit_saved', {
      uploadId: upload.id,
      uploadStatus: status,
    });
  } catch (error) {
    addRequestLogEvent(req, 'lemonfox_submit_failed', {
      uploadId: upload.id,
      message: error.message || 'Unable to submit audio to Lemonfox.',
    });
    statements.markAudioError.run(error.message || 'Unable to submit audio to Lemonfox.', upload.id);
  }
}

async function handleAudio(req, res, url) {
  if (url.pathname === '/api/audio/uploads' && req.method === 'GET') {
    const user = requireUser(req, res);
    if (!user) return;
    const uploads = statements.listAudioUploads.all(user.id).map(publicAudioUpload);
    addRequestLogDetail(req, { uploadCount: uploads.length });
    return json(res, 200, { uploads });
  }

  if (url.pathname === '/api/audio/uploads' && req.method === 'POST') {
    if (!isSameOrigin(req)) {
      markRequestLogError(req, 403, 'Invalid request origin.', {
        origin: req.headers.origin || null,
      });
      return json(res, 403, { error: 'Invalid request origin.' });
    }

    const user = requireUser(req, res);
    if (!user) return;

    const originalFilename = safeOriginalFilename(
      url.searchParams.get('filename') || req.headers['x-file-name'] || 'audio-upload'
    );
    const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    const ext = audioExtensionFor(originalFilename, contentType);
    addRequestLogDetail(req, {
      upload: {
        originalFilename,
        contentType,
        contentLength: Number(req.headers['content-length'] || 0) || null,
        detectedExtension: ext || null,
      },
    });
    addRequestLogEvent(req, 'audio_upload_started', {
      originalFilename,
      contentType,
      contentLength: Number(req.headers['content-length'] || 0) || null,
    });

    if (!ext) {
      markRequestLogError(req, 415, 'Unsupported audio upload type.', {
        originalFilename,
        contentType,
      });
      return json(res, 415, { error: 'Upload an audio or video file such as mp3, m4a, wav, mp4, mov, or webm.' });
    }

    const storedFilename = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
    const storagePath = path.join(UPLOAD_ROOT, String(user.id), storedFilename);
    const sizeBytes = await writeRequestBodyToFile(req, storagePath);
    addRequestLogEvent(req, 'audio_file_saved', {
      storedFilename,
      sizeBytes,
    });
    addRequestLogDetail(req, {
      upload: {
        ...(req.requestLog?.details?.upload || {}),
        storedFilename,
        sizeBytes,
      },
    });
    const fileToken = makeSecret();
    const callbackToken = makeSecret();
    const title = originalFilename.replace(/\.[^.]+$/, '') || 'Audio session';

    const upload = statements.createAudioUpload.get(
      user.id,
      title,
      originalFilename,
      storedFilename,
      storagePath,
      contentType || 'application/octet-stream',
      sizeBytes,
      hashSecret(fileToken),
      `+${AUDIO_URL_TTL_HOURS} hours`,
      hashSecret(callbackToken)
    );
    addRequestLogEvent(req, 'audio_upload_record_created', {
      uploadId: upload.id,
      status: upload.status,
    });
    addRequestLogDetail(req, {
      upload: {
        ...(req.requestLog?.details?.upload || {}),
        id: upload.id,
        status: upload.status,
      },
    });

    await submitToLemonfox(req, upload, fileToken, callbackToken);

    const refreshed = statements.getAudioUploadForUser.get(upload.id, user.id);
    addRequestLogEvent(req, 'audio_upload_response_ready', {
      uploadId: upload.id,
      status: refreshed?.status || upload.status,
      error: refreshed?.lemonfox_error || null,
    });
    addRequestLogDetail(req, {
      upload: {
        ...(req.requestLog?.details?.upload || {}),
        status: refreshed?.status || upload.status,
        error: refreshed?.lemonfox_error || null,
      },
    });
    const transcript = transcriptForAudioUpload(refreshed, req);
    return json(res, 201, { upload: publicAudioUpload(refreshed || upload), transcript });
  }

  if (url.pathname.startsWith('/api/audio/uploads/') && req.method === 'GET') {
    const user = requireUser(req, res);
    if (!user) return;

    const id = Number(url.pathname.slice('/api/audio/uploads/'.length));
    if (!Number.isInteger(id)) {
      markRequestLogError(req, 404, 'Invalid upload id.');
      return text(res, 404, 'Not Found\n');
    }

    const upload = statements.getAudioUploadForUser.get(id, user.id);
    if (!upload) {
      markRequestLogError(req, 404, 'Upload not found.', { uploadId: id });
      return text(res, 404, 'Not Found\n');
    }
    addRequestLogDetail(req, {
      upload: {
        id: upload.id,
        status: upload.status,
        error: upload.lemonfox_error || null,
      },
    });

    const transcript = transcriptForAudioUpload(upload, req);

    return json(res, 200, { upload: publicAudioUpload(upload), transcript });
  }

  if (url.pathname.startsWith('/api/audio/source/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const match = parseUploadIdAndToken(url.pathname, '/api/audio/source/');
    if (!match) {
      markRequestLogError(req, 404, 'Invalid source URL.');
      return text(res, 404, 'Not Found\n');
    }
    addRequestLogDetail(req, { sourceRequest: { uploadId: match.id } });

    const upload = statements.getAudioUploadForSourceToken.get(match.id, hashSecret(match.token));
    if (!upload) {
      markRequestLogError(req, 404, 'Audio source token not found or expired.', { uploadId: match.id });
      return text(res, 404, 'Not Found\n');
    }

    let stat;
    try {
      stat = await fs.stat(upload.storage_path);
    } catch (error) {
      markRequestLogError(req, 404, 'Audio source file missing on disk.', {
        uploadId: upload.id,
        code: error.code || null,
      });
      return text(res, 404, 'Not Found\n');
    }
    addRequestLogDetail(req, {
      sourceRequest: {
        uploadId: upload.id,
        mimeType: upload.mime_type,
        sizeBytes: stat.size,
      },
    });
    addRequestLogEvent(req, 'audio_source_stream_started', {
      uploadId: upload.id,
      sizeBytes: stat.size,
    });

    res.writeHead(200, {
      'Content-Type': upload.mime_type || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(upload.original_filename)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fsSync.createReadStream(upload.storage_path);
    stream.once('error', (error) => {
      markRequestLogError(req, 500, 'Audio source stream failed.', {
        uploadId: upload.id,
        code: error.code || null,
        message: error.message,
      });
      res.destroy(error);
    });
    return stream.pipe(res);
  }

  if (url.pathname.startsWith('/api/audio/lemonfox/callback/') && req.method === 'POST') {
    const match = parseUploadIdAndToken(url.pathname, '/api/audio/lemonfox/callback/');
    if (!match) {
      markRequestLogError(req, 404, 'Invalid Lemonfox callback URL.');
      return text(res, 404, 'Not Found\n');
    }
    addRequestLogDetail(req, { lemonfoxCallback: { uploadId: match.id } });

    const upload = statements.getAudioUploadForCallbackToken.get(match.id, hashSecret(match.token));
    if (!upload) {
      markRequestLogError(req, 404, 'Lemonfox callback token not found.', { uploadId: match.id });
      return text(res, 404, 'Not Found\n');
    }

    const body = await readJsonWithLimit(req, CALLBACK_JSON_LIMIT_BYTES);
    statements.completeAudioUpload.run(JSON.stringify(body), upload.id);
    addRequestLogEvent(req, 'lemonfox_callback_saved', {
      uploadId: upload.id,
      bodyKeys: Object.keys(body || {}).slice(0, 20),
    });
    return json(res, 200, { ok: true });
  }

  markRequestLogError(req, 404, 'Audio endpoint not found.');
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
  let requestLog = null;

  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    requestLog = captureRequestLog(req, res, url);

    if (url.pathname.startsWith('/api/auth/')) {
      return await handleAuth(req, res, url);
    }

    if (url.pathname.startsWith('/api/audio/')) {
      return await handleAudio(req, res, url);
    }

    if ((url.pathname === '/' || url.pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      return await serveIndex(req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return text(res, 405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
    }

    return text(res, 404, 'Not Found\n');
  } catch (error) {
    logLine('error', 'server_error', {
      request: requestLog ? {
        method: requestLog.method,
        path: requestLog.path,
        user: logUser(req),
      } : null,
      error: errorDetail(error),
    });
    if (requestLog) {
      markRequestLogError(req, error.status || 500, error.message || 'Unknown server error.', {
        stack: process.env.LOG_STACKS === '1' ? error.stack : undefined,
      });
    }
    return json(res, error.status || 500, { error: error.status ? error.message : 'Internal Server Error' });
  }
});

server.listen(PORT, HOST, () => {
  logLine('info', 'server_started', {
    url: `http://${HOST}:${PORT}/`,
    host: HOST,
    port: PORT,
    databasePath: DB_PATH,
    uploadRoot: UPLOAD_ROOT,
    lemonfoxConfigured: Boolean(LEMONFOX_API_KEY),
  });
});

process.on('unhandledRejection', (error) => {
  logLine('error', 'unhandled_rejection', { error: errorDetail(error) });
});

process.on('uncaughtException', (error) => {
  logLine('error', 'uncaught_exception', { error: errorDetail(error) });
  setImmediate(() => process.exit(1));
});
