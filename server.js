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
const NATIVE_AUDIO_ROOT = path.join(__dirname, 'uploads', 'native-audio');
const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const JSON_LIMIT_BYTES = 16 * 1024;
const CALLBACK_JSON_LIMIT_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 1024 * 1024 * 1024);
const AUDIO_URL_TTL_HOURS = Number(process.env.AUDIO_URL_TTL_HOURS || 24);
const LEMONFOX_ENDPOINT = process.env.LEMONFOX_ENDPOINT || 'https://api.lemonfox.ai/v1/audio/transcriptions';
const LEMONFOX_API_KEY = process.env.LEMONFOX_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Algieba';
const GEMINI_TTS_LANGUAGE = process.env.GEMINI_TTS_LANGUAGE || 'ja';
const GEMINI_API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TTS_CONTEXT = process.env.GEMINI_TTS_CONTEXT
  || "A native Japanese speaker speaking at a natural speed so that an N1-level Japanese learner can clearly understand what they're saying using standard Japanese.";
const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const DEEPSEEK_REQUEST_TIMEOUT_MS = Number(process.env.DEEPSEEK_REQUEST_TIMEOUT_MS || 5 * 60 * 1000);
const DEEPSEEK_MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS || 64000);
const DEEPSEEK_THINKING = ['enabled', 'disabled'].includes(String(process.env.DEEPSEEK_THINKING || '').toLowerCase())
  ? String(process.env.DEEPSEEK_THINKING).toLowerCase()
  : 'disabled';
const DEEPSEEK_REASONING_EFFORT = ['high', 'max'].includes(String(process.env.DEEPSEEK_REASONING_EFFORT || '').toLowerCase())
  ? String(process.env.DEEPSEEK_REASONING_EFFORT).toLowerCase()
  : 'high';
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'japaneast';
const AZURE_PRONUNCIATION_LANGUAGE = process.env.AZURE_PRONUNCIATION_LANGUAGE || 'ja-JP';
const PRONUNCIATION_AUDIO_ROOT = path.join(__dirname, 'uploads', 'pronunciation');
const MAX_PRONUNCIATION_BYTES = Number(process.env.MAX_PRONUNCIATION_BYTES || 8 * 1024 * 1024);
const PROMPT_TEMPLATE_PATH = path.join(__dirname, 'prompt.txt');
let promptTemplate = '';
try {
  promptTemplate = fsSync.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
} catch (error) {
  promptTemplate = '';
}

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
    lemonfox_transcript_text TEXT,
    lemonfox_error TEXT,
    file_token_hash TEXT NOT NULL UNIQUE,
    file_token_expires_at TEXT NOT NULL,
    callback_token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    submitted_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS study_sessions (
    id INTEGER PRIMARY KEY,
    audio_upload_id INTEGER NOT NULL UNIQUE REFERENCES audio_uploads(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    selected_speaker TEXT NOT NULL,
    speaker_label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    error TEXT,
    prompt_text TEXT,
    deepseek_request_json TEXT,
    deepseek_response_json TEXT,
    sentence_count INTEGER NOT NULL DEFAULT 0,
    current_index INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS study_sentences (
    id INTEGER PRIMARY KEY,
    study_session_id INTEGER NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    original_sentence TEXT NOT NULL,
    grade TEXT NOT NULL,
    slightly_corrected_sentence TEXT,
    native_speaker_version TEXT,
    explanation TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(study_session_id, position)
  );

  CREATE TABLE IF NOT EXISTS native_audio (
    id INTEGER PRIMARY KEY,
    study_sentence_id INTEGER NOT NULL UNIQUE REFERENCES study_sentences(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    voice TEXT NOT NULL,
    language TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS native_audio_user_id_idx ON native_audio(user_id);
  CREATE INDEX IF NOT EXISTS native_audio_sentence_id_idx ON native_audio(study_sentence_id);

  CREATE TABLE IF NOT EXISTS pronunciation_assessments (
    id INTEGER PRIMARY KEY,
    study_sentence_id INTEGER NOT NULL UNIQUE REFERENCES study_sentences(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reference_text TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL DEFAULT 'audio/wav',
    size_bytes INTEGER NOT NULL,
    azure_response_json TEXT,
    pron_score REAL,
    accuracy_score REAL,
    fluency_score REAL,
    completeness_score REAL,
    recognition_status TEXT,
    display_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS pronunciation_assessments_user_id_idx ON pronunciation_assessments(user_id);
  CREATE INDEX IF NOT EXISTS pronunciation_assessments_sentence_id_idx ON pronunciation_assessments(study_sentence_id);

  CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS audio_uploads_user_id_idx ON audio_uploads(user_id);
  CREATE INDEX IF NOT EXISTS audio_uploads_file_token_hash_idx ON audio_uploads(file_token_hash);
  CREATE INDEX IF NOT EXISTS audio_uploads_callback_token_hash_idx ON audio_uploads(callback_token_hash);
  CREATE INDEX IF NOT EXISTS study_sessions_user_id_idx ON study_sessions(user_id);
  CREATE INDEX IF NOT EXISTS study_sentences_session_id_idx ON study_sentences(study_session_id);
`);

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

{
  const columns = tableColumns('audio_uploads');
  if (!columns.has('selected_speaker')) {
    db.exec('ALTER TABLE audio_uploads ADD COLUMN selected_speaker TEXT');
  }
  if (!columns.has('speaker_selected_at')) {
    db.exec('ALTER TABLE audio_uploads ADD COLUMN speaker_selected_at TEXT');
  }
  if (!columns.has('lemonfox_transcript_text')) {
    db.exec('ALTER TABLE audio_uploads ADD COLUMN lemonfox_transcript_text TEXT');
  }
  db.exec(`
    UPDATE audio_uploads
    SET status = 'speaker_selection', updated_at = datetime('now')
    WHERE status = 'completed' AND selected_speaker IS NULL
  `);
  db.exec(`
    UPDATE study_sessions
    SET status = 'error', error = 'Server restarted while DeepSeek was processing this session.', updated_at = datetime('now')
    WHERE status = 'processing'
  `);
  db.exec(`
    UPDATE audio_uploads
    SET status = 'study_failed', updated_at = datetime('now')
    WHERE status = 'study_processing'
  `);
}

function buildTranscriptText(lemonfoxResponse) {
  const segments = Array.isArray(lemonfoxResponse?.segments) ? lemonfoxResponse.segments : [];
  const lines = [];
  for (const segment of segments) {
    const speakerRaw = segment?.speaker ?? segment?.speaker_label ?? segment?.speaker_id;
    const textRaw = segment?.text;
    const speaker = speakerRaw === undefined || speakerRaw === null ? '' : String(speakerRaw).trim();
    const text = textRaw === undefined || textRaw === null ? '' : String(textRaw).replace(/\s+/g, ' ').trim();
    if (!speaker || !text) continue;
    lines.push(`${speaker}: ${text}`);
  }
  return lines.join('\n');
}

function speakerFriendlyLabel(value) {
  const v = String(value ?? '').trim();
  if (!v) return 'Speaker';
  const numeric = v.match(/^(?:speaker[_\s-]?)?0*(\d+)$/i);
  if (numeric) return `Speaker ${numeric[1]}`;
  return v;
}

function buildFriendlyTranscriptText(lemonfoxResponse) {
  const segments = Array.isArray(lemonfoxResponse?.segments) ? lemonfoxResponse.segments : [];
  const lines = [];
  for (const segment of segments) {
    const speakerRaw = segment?.speaker ?? segment?.speaker_label ?? segment?.speaker_id;
    const textRaw = segment?.text;
    const speaker = speakerRaw === undefined || speakerRaw === null ? '' : String(speakerRaw).trim();
    const text = textRaw === undefined || textRaw === null ? '' : String(textRaw).replace(/\s+/g, ' ').trim();
    if (!speaker || !text) continue;
    lines.push(`${speakerFriendlyLabel(speaker)}: ${text}`);
  }
  return lines.join('\n');
}

function buildDeepseekPrompt(transcriptText, selectedSpeaker) {
  if (!promptTemplate) {
    throw new Error('Prompt template is missing on the server.');
  }
  const friendlyLabel = speakerFriendlyLabel(selectedSpeaker);
  const withSpeaker = promptTemplate.replace(/Speaker\s*1/g, friendlyLabel);
  const transcript = String(transcriptText || '').trim();
  const filled = withSpeaker.replace(
    /<TRANSCRIPT>[\s\S]*?<\/TRANSCRIPT>/,
    `<TRANSCRIPT>\n${transcript}\n</TRANSCRIPT>`
  );
  return `${filled}\n\nReturn the response as a JSON object with a single key "sentences" whose value is the JSON array described above. Do not include any other keys or surrounding text.`;
}

function backfillTranscriptTextForExistingRows() {
  const rows = db.prepare(`
    SELECT id, lemonfox_response_json
    FROM audio_uploads
    WHERE lemonfox_response_json IS NOT NULL
  `).all();

  const update = db.prepare(`
    UPDATE audio_uploads
    SET lemonfox_transcript_text = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      let parsed = null;
      try {
        parsed = JSON.parse(row.lemonfox_response_json);
      } catch {
        parsed = null;
      }
      const transcriptText = buildTranscriptText(parsed);
      update.run(transcriptText || null, row.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

backfillTranscriptTextForExistingRows();

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
    RETURNING id, user_id, title, original_filename, mime_type, size_bytes, status, selected_speaker, created_at, updated_at, completed_at
  `),
  listAudioUploads: db.prepare(`
    SELECT
      a.id, a.title, a.original_filename, a.mime_type, a.size_bytes, a.status,
      a.selected_speaker, a.lemonfox_error, a.created_at, a.updated_at,
      a.submitted_at, a.completed_at,
      s.id AS study_id,
      s.status AS study_status, s.error AS study_error,
      s.sentence_count AS study_sentence_count,
      s.completed_count AS study_completed_count,
      s.current_index AS study_current_index,
      (SELECT AVG(pa.pron_score)
         FROM pronunciation_assessments pa
         JOIN study_sentences ssx ON pa.study_sentence_id = ssx.id
        WHERE ssx.study_session_id = s.id AND pa.pron_score IS NOT NULL) AS study_avg_pron_score
    FROM audio_uploads a
    LEFT JOIN study_sessions s ON s.audio_upload_id = a.id
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
    LIMIT 50
  `),
  getAudioUploadForUser: db.prepare(`
    SELECT id, title, original_filename, mime_type, size_bytes, status, selected_speaker, lemonfox_error, lemonfox_response_json, lemonfox_transcript_text, created_at, updated_at, submitted_at, completed_at
    FROM audio_uploads
    WHERE id = ? AND user_id = ?
  `),
  getAudioUploadPlaybackForUser: db.prepare(`
    SELECT id, original_filename, storage_path, mime_type, size_bytes
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
    SET status = 'speaker_selection', lemonfox_response_json = ?, lemonfox_transcript_text = ?, lemonfox_error = NULL,
        completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `),
  selectUploadSpeaker: db.prepare(`
    UPDATE audio_uploads
    SET selected_speaker = ?, status = 'study_processing',
        speaker_selected_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
    RETURNING id, title, original_filename, mime_type, size_bytes, status, selected_speaker, lemonfox_error, created_at, updated_at, submitted_at, completed_at
  `),
  setUploadStudyStatus: db.prepare(`
    UPDATE audio_uploads
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  upsertStudySession: db.prepare(`
    INSERT INTO study_sessions (audio_upload_id, user_id, selected_speaker, speaker_label, status)
    VALUES (?, ?, ?, ?, 'processing')
    ON CONFLICT(audio_upload_id) DO UPDATE SET
      user_id = excluded.user_id,
      selected_speaker = excluded.selected_speaker,
      speaker_label = excluded.speaker_label,
      status = 'processing',
      error = NULL,
      sentence_count = 0,
      current_index = 0,
      completed_count = 0,
      completed_at = NULL,
      updated_at = datetime('now')
    RETURNING id
  `),
  markStudySessionReady: db.prepare(`
    UPDATE study_sessions
    SET status = 'ready', error = NULL,
        prompt_text = ?, deepseek_request_json = ?, deepseek_response_json = ?,
        sentence_count = ?, completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `),
  markStudySessionError: db.prepare(`
    UPDATE study_sessions
    SET status = 'error', error = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  markStudySessionDeepseekError: db.prepare(`
    UPDATE study_sessions
    SET status = 'error', error = ?,
        prompt_text = ?,
        deepseek_request_json = ?,
        deepseek_response_json = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `),
  deleteStudySentencesForSession: db.prepare(`
    DELETE FROM study_sentences WHERE study_session_id = ?
  `),
  insertStudySentence: db.prepare(`
    INSERT INTO study_sentences (
      study_session_id, position, original_sentence, grade,
      slightly_corrected_sentence, native_speaker_version, explanation
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getStudySessionForUser: db.prepare(`
    SELECT id, audio_upload_id, user_id, selected_speaker, speaker_label, status, error,
           sentence_count, current_index, completed_count, created_at, updated_at, completed_at
    FROM study_sessions
    WHERE audio_upload_id = ? AND user_id = ?
  `),
  getStudySentencesForSession: db.prepare(`
    SELECT ss.id, ss.position, ss.original_sentence, ss.grade,
           ss.slightly_corrected_sentence, ss.native_speaker_version,
           ss.explanation, ss.done,
           pa.pron_score AS pron_score
    FROM study_sentences ss
    LEFT JOIN pronunciation_assessments pa ON pa.study_sentence_id = ss.id
    WHERE ss.study_session_id = ?
    ORDER BY ss.position ASC
  `),
  getStudySessionAvgScore: db.prepare(`
    SELECT AVG(pa.pron_score) AS avg_pron_score
    FROM pronunciation_assessments pa
    JOIN study_sentences ss ON pa.study_sentence_id = ss.id
    WHERE ss.study_session_id = ? AND pa.pron_score IS NOT NULL
  `),
  updateAudioUploadTitle: db.prepare(`
    UPDATE audio_uploads
    SET title = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
    RETURNING id, title, original_filename, mime_type, size_bytes, status, selected_speaker, lemonfox_error, created_at, updated_at, submitted_at, completed_at
  `),
  updateStudyCurrentIndex: db.prepare(`
    UPDATE study_sessions
    SET current_index = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  setStudySentenceDone: db.prepare(`
    UPDATE study_sentences
    SET done = ?
    WHERE id = ? AND study_session_id = ?
  `),
  recountStudyCompleted: db.prepare(`
    UPDATE study_sessions
    SET completed_count = (
      SELECT COUNT(*) FROM study_sentences
      WHERE study_session_id = study_sessions.id AND (done = 1 OR grade = 'correct')
    ),
    updated_at = datetime('now')
    WHERE id = ?
  `),
  getStudySentenceForUser: db.prepare(`
    SELECT ss.id, ss.original_sentence, ss.native_speaker_version,
           ss.slightly_corrected_sentence, ss.study_session_id,
           sess.user_id
    FROM study_sentences ss
    JOIN study_sessions sess ON sess.id = ss.study_session_id
    WHERE ss.id = ? AND sess.user_id = ?
  `),
  getNativeAudioForSentence: db.prepare(`
    SELECT id, study_sentence_id, user_id, text, voice, language,
           stored_filename, storage_path, mime_type, size_bytes, created_at
    FROM native_audio
    WHERE study_sentence_id = ? AND user_id = ?
  `),
  insertNativeAudio: db.prepare(`
    INSERT INTO native_audio (
      study_sentence_id, user_id, text, voice, language,
      stored_filename, storage_path, mime_type, size_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id, study_sentence_id, user_id, text, voice, language,
              stored_filename, storage_path, mime_type, size_bytes, created_at
  `),
  deleteNativeAudio: db.prepare(`
    DELETE FROM native_audio WHERE id = ?
  `),
  getPronunciationAssessmentForSentence: db.prepare(`
    SELECT id, study_sentence_id, user_id, reference_text, stored_filename, storage_path,
           mime_type, size_bytes, azure_response_json, pron_score, accuracy_score,
           fluency_score, completeness_score, recognition_status, display_text,
           created_at, updated_at
    FROM pronunciation_assessments
    WHERE study_sentence_id = ? AND user_id = ?
  `),
  upsertPronunciationAssessment: db.prepare(`
    INSERT INTO pronunciation_assessments (
      study_sentence_id, user_id, reference_text, stored_filename, storage_path,
      mime_type, size_bytes, azure_response_json, pron_score, accuracy_score,
      fluency_score, completeness_score, recognition_status, display_text,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(study_sentence_id) DO UPDATE SET
      user_id = excluded.user_id,
      reference_text = excluded.reference_text,
      stored_filename = excluded.stored_filename,
      storage_path = excluded.storage_path,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      azure_response_json = excluded.azure_response_json,
      pron_score = excluded.pron_score,
      accuracy_score = excluded.accuracy_score,
      fluency_score = excluded.fluency_score,
      completeness_score = excluded.completeness_score,
      recognition_status = excluded.recognition_status,
      display_text = excluded.display_text,
      updated_at = datetime('now')
    RETURNING id, study_sentence_id, user_id, reference_text, stored_filename, storage_path,
              mime_type, size_bytes, azure_response_json, pron_score, accuracy_score,
              fluency_score, completeness_score, recognition_status, display_text,
              created_at, updated_at
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

function textPreview(value, maxChars = 4000) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      serializationError: error?.message || String(error),
      preview: textPreview(String(value), 1000),
    });
  }
}

function deepseekErrorRecord(error) {
  const content = typeof error?.deepseekContent === 'string' ? error.deepseekContent : null;
  return {
    error: errorDetail(error),
    status: error?.deepseekStatus || null,
    finishReason: error?.deepseekFinishReason || null,
    responseBody: error?.deepseekBody || null,
    contentBytes: content == null ? null : Buffer.byteLength(content),
    contentPreview: textPreview(content, 12000),
    parseError: error?.deepseekParseError ? errorDetail(error.deepseekParseError) : null,
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
  const payload = {
    id: row.id,
    title: row.title,
    filename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    selectedSpeaker: row.selected_speaker || null,
    error: row.lemonfox_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    completedAt: row.completed_at || null,
  };
  if (row.study_status !== undefined) {
    payload.study = {
      status: row.study_status || null,
      error: row.study_error || null,
      sentenceCount: row.study_sentence_count || 0,
      completedCount: row.study_completed_count || 0,
      currentIndex: row.study_current_index || 0,
      avgPronScore: row.study_avg_pron_score != null ? Number(row.study_avg_pron_score) : null,
    };
  }
  return payload;
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

function speakersFromTranscript(transcript) {
  const speakers = new Set();
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  for (const segment of segments) {
    const speaker = segment?.speaker ?? segment?.speaker_label ?? segment?.speaker_id;
    if (speaker !== undefined && speaker !== null && String(speaker).trim()) {
      speakers.add(String(speaker).trim());
    }
  }
  return [...speakers];
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

async function streamAudioUpload(req, res, upload) {
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

  const fileSize = stat.size;
  const baseHeaders = {
    'Content-Type': upload.mime_type || 'application/octet-stream',
    'Content-Disposition': `inline; filename="${encodeURIComponent(upload.original_filename)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };

  let start = 0;
  let end = fileSize - 1;
  let status = 200;

  const range = String(req.headers.range || '');
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    if (match[1] === '' && match[2] !== '') {
      const suffixLength = Number(match[2]);
      start = Math.max(0, fileSize - suffixLength);
    } else {
      start = Number(match[1] || 0);
      if (match[2] !== '') end = Number(match[2]);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= fileSize) {
      res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    end = Math.min(end, fileSize - 1);
    status = 206;
  }

  const contentLength = end - start + 1;
  res.writeHead(status, {
    ...baseHeaders,
    'Content-Length': contentLength,
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${fileSize}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();

  addRequestLogEvent(req, 'audio_playback_stream_started', {
    uploadId: upload.id,
    status,
    start,
    end,
  });

  const stream = fsSync.createReadStream(upload.storage_path, { start, end });
  stream.once('error', (error) => {
    markRequestLogError(req, 500, 'Audio playback stream failed.', {
      uploadId: upload.id,
      code: error.code || null,
      message: error.message,
    });
    res.destroy(error);
  });
  return stream.pipe(res);
}

function parseUploadIdAndToken(pathname, prefix) {
  const parts = pathname.slice(prefix.length).split('/').filter(Boolean);
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return null;
  return { id: Number(parts[0]), token: parts[1] };
}

function parseUploadChildPath(pathname, child) {
  const match = pathname.match(new RegExp(`^/api/audio/uploads/(\\d+)/${child}$`));
  return match ? Number(match[1]) : null;
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

function publicStudySession(row, sentences = []) {
  if (!row) return null;
  const scored = sentences
    .map(s => (s.pron_score != null ? Number(s.pron_score) : null))
    .filter(v => Number.isFinite(v));
  const avgPronScore = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  return {
    id: row.id,
    audioUploadId: row.audio_upload_id,
    selectedSpeaker: row.selected_speaker,
    speakerLabel: row.speaker_label,
    status: row.status,
    error: row.error || null,
    sentenceCount: row.sentence_count || 0,
    currentIndex: row.current_index || 0,
    completedCount: row.completed_count || 0,
    avgPronScore,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    sentences: sentences.map(s => ({
      id: s.id,
      position: s.position,
      originalSentence: s.original_sentence,
      grade: s.grade,
      slightlyCorrectedSentence: s.slightly_corrected_sentence,
      nativeSpeakerVersion: s.native_speaker_version,
      explanation: s.explanation,
      done: !!s.done,
      pronScore: s.pron_score != null ? Number(s.pron_score) : null,
    })),
  };
}

function extractSentencesArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed.sentences)) return parsed.sentences;
  for (const value of Object.values(parsed)) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

function normalizeStudySentence(item, position) {
  if (!item || typeof item !== 'object') return null;
  const original = String(item.original_sentence ?? item.original ?? '').trim();
  if (!original) return null;
  const gradeRaw = String(item.grade ?? '').trim().toLowerCase();
  const grade = ['correct', 'slightly unnatural', 'incorrect'].includes(gradeRaw)
    ? gradeRaw
    : 'slightly unnatural';
  const slightly = item.slightly_corrected_sentence == null
    ? null
    : String(item.slightly_corrected_sentence).trim() || null;
  const native = item.native_speaker_version == null
    ? null
    : String(item.native_speaker_version).trim() || null;
  const explanation = item.explanation == null
    ? null
    : String(item.explanation).trim() || null;
  return {
    position,
    original_sentence: original,
    grade,
    slightly_corrected_sentence: slightly,
    native_speaker_version: native,
    explanation,
  };
}

async function callDeepseek(prompt) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('Set DEEPSEEK_API_KEY before processing study sessions.');
  }
  const requestBody = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: 'Return only valid json. Do not include markdown or any surrounding text.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    max_tokens: DEEPSEEK_MAX_TOKENS,
    thinking: { type: DEEPSEEK_THINKING },
    stream: false,
  };
  if (DEEPSEEK_THINKING === 'enabled') {
    requestBody.reasoning_effort = DEEPSEEK_REASONING_EFFORT;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEEPSEEK_REQUEST_TIMEOUT_MS);

  // --- ADDED LOG ---
  console.log(`[DeepSeek] 🚀 Starting API request using model "${DEEPSEEK_MODEL}"...`);
  const startTime = Date.now();

  let response;
  try {
    response = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    
    // --- ADDED LOG ---
    console.error(`[DeepSeek] ❌ Request failed after ${Date.now() - startTime}ms`, error.message);
    
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`DeepSeek request timed out after ${DEEPSEEK_REQUEST_TIMEOUT_MS}ms.`);
      timeoutError.deepseekRequestBody = requestBody;
      throw timeoutError;
    }
    const requestError = new Error(`DeepSeek request failed: ${error?.message || error}`);
    requestError.deepseekRequestBody = requestBody;
    throw requestError;
  }

  // --- ADDED LOG ---
  const durationMs = Date.now() - startTime;
  console.log(`[DeepSeek] ⏳ API responded in ${durationMs}ms with status ${response.status}.`);

  let bodyText;
  try {
    bodyText = await response.text();
  } catch (error) {
    clearTimeout(timer);
    console.error(`[DeepSeek] ❌ Failed to read response body after ${Date.now() - startTime}ms`, error.message);
    const readError = new Error(`DeepSeek response body read failed: ${error?.message || error}`);
    readError.deepseekStatus = response.status;
    readError.deepseekRequestBody = requestBody;
    throw readError;
  }
  clearTimeout(timer);

  let parsedBody;
  try {
    parsedBody = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    parsedBody = { raw: bodyText };
  }

  if (!response.ok) {
    const message = parsedBody?.error?.message || parsedBody?.message || `DeepSeek returned ${response.status}.`;
    
    // --- ADDED LOG ---
    console.error(`[DeepSeek] ❌ Error response: ${message}`);
    
    const error = new Error(String(message));
    error.deepseekStatus = response.status;
    error.deepseekBody = parsedBody;
    error.deepseekRequestBody = requestBody;
    throw error;
  }

  const choice = parsedBody?.choices?.[0];
  const content = choice?.message?.content;
  if (!content || typeof content !== 'string') {
    // --- ADDED LOG ---
    console.error(`[DeepSeek] ❌ Missing message content in response.`);
    
    const error = new Error('DeepSeek returned no message content.');
    error.deepseekStatus = response.status;
    error.deepseekBody = parsedBody;
    error.deepseekRequestBody = requestBody;
    error.deepseekFinishReason = choice?.finish_reason || null;
    throw error;
  }
  if (choice.finish_reason === 'length') {
    const error = new Error(`DeepSeek response was truncated. Increase DEEPSEEK_MAX_TOKENS above ${DEEPSEEK_MAX_TOKENS}.`);
    error.deepseekStatus = response.status;
    error.deepseekBody = parsedBody;
    error.deepseekContent = content;
    error.deepseekRequestBody = requestBody;
    error.deepseekFinishReason = choice.finish_reason;
    throw error;
  }

  let parsedContent;
  try {
    parsedContent = JSON.parse(content);
    console.log(`[DeepSeek] ✅ Successfully parsed JSON response.`);
  } catch (parseError) {
    const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
      parsedContent = JSON.parse(trimmed);
      console.log(`[DeepSeek] ✅ Successfully parsed JSON response (from markdown code block).`);
    } catch (markdownParseError) {
      // --- ADDED LOG ---
      console.error(`[DeepSeek] ❌ Failed to parse response as JSON.`);
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        message: 'deepseek_invalid_json_content',
        status: response.status,
        finishReason: choice?.finish_reason || null,
        contentBytes: Buffer.byteLength(content),
        contentPreview: textPreview(content, 4000),
        parseError: errorDetail(markdownParseError),
      }));
      
      const error = new Error('DeepSeek response was not valid JSON.');
      error.deepseekStatus = response.status;
      error.deepseekBody = parsedBody;
      error.deepseekContent = content;
      error.deepseekRequestBody = requestBody;
      error.deepseekFinishReason = choice?.finish_reason || null;
      error.deepseekParseError = markdownParseError;
      error.deepseekInitialParseError = parseError;
      throw error;
    }
  }

  return { requestBody, responseBody: parsedBody, content: parsedContent };
}

async function processStudySession({ uploadId, userId, selectedSpeaker, transcriptText, lemonfoxResponse, logTag = {} }) {
  const friendlyTranscript = buildFriendlyTranscriptText(lemonfoxResponse) || transcriptText || '';
  const studyRow = statements.upsertStudySession.get(
    uploadId,
    userId,
    selectedSpeaker,
    speakerFriendlyLabel(selectedSpeaker)
  );
  const studyId = studyRow?.id;
  if (!studyId) {
    logLine('error', 'study_session_upsert_failed', { uploadId, ...logTag });
    return;
  }

  let prompt;
  try {
    prompt = buildDeepseekPrompt(friendlyTranscript, selectedSpeaker);
  } catch (error) {
    statements.markStudySessionError.run(error.message || String(error), studyId);
    statements.setUploadStudyStatus.run('study_failed', uploadId);
    logLine('error', 'study_prompt_build_failed', {
      uploadId, studyId, error: errorDetail(error), ...logTag,
    });
    return;
  }

  logLine('info', 'deepseek_submit_started', {
    uploadId, studyId, model: DEEPSEEK_MODEL, promptBytes: Buffer.byteLength(prompt), ...logTag,
  });

  let result;
  try {
    result = await callDeepseek(prompt);
  } catch (error) {
    const message = error.message || 'DeepSeek call failed.';
    const responseRecord = deepseekErrorRecord(error);
    statements.markStudySessionDeepseekError.run(
      message,
      prompt,
      error.deepseekRequestBody ? safeJsonStringify(error.deepseekRequestBody) : null,
      safeJsonStringify(responseRecord),
      studyId
    );
    statements.setUploadStudyStatus.run('study_failed', uploadId);
    logLine('error', 'deepseek_submit_failed', {
      uploadId, studyId, error: errorDetail(error),
      deepseekStatus: error.deepseekStatus || null,
      finishReason: error.deepseekFinishReason || null,
      contentBytes: responseRecord.contentBytes,
      contentPreview: responseRecord.contentPreview ? textPreview(responseRecord.contentPreview, 2000) : null,
      parseError: responseRecord.parseError,
      ...logTag,
    });
    return;
  }

  const sentencesRaw = extractSentencesArray(result.content);
  if (!Array.isArray(sentencesRaw) || !sentencesRaw.length) {
    statements.markStudySessionError.run('DeepSeek did not return any sentences.', studyId);
    statements.setUploadStudyStatus.run('study_failed', uploadId);
    logLine('error', 'deepseek_no_sentences', {
      uploadId, studyId, contentKeys: result.content && typeof result.content === 'object' ? Object.keys(result.content) : null,
      ...logTag,
    });
    return;
  }

  const normalized = sentencesRaw
    .map((item, idx) => normalizeStudySentence(item, idx))
    .filter(Boolean);

  if (!normalized.length) {
    statements.markStudySessionError.run('DeepSeek sentences were empty after normalization.', studyId);
    statements.setUploadStudyStatus.run('study_failed', uploadId);
    return;
  }

  db.exec('BEGIN');
  try {
    statements.deleteStudySentencesForSession.run(studyId);
    for (const item of normalized) {
      statements.insertStudySentence.run(
        studyId,
        item.position,
        item.original_sentence,
        item.grade,
        item.slightly_corrected_sentence,
        item.native_speaker_version,
        item.explanation
      );
    }
    statements.markStudySessionReady.run(
      prompt,
      JSON.stringify(result.requestBody),
      JSON.stringify(result.responseBody),
      normalized.length,
      studyId
    );
    statements.recountStudyCompleted.run(studyId);
    statements.setUploadStudyStatus.run('study_ready', uploadId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    statements.markStudySessionError.run(error.message || 'Failed to save study sentences.', studyId);
    statements.setUploadStudyStatus.run('study_failed', uploadId);
    logLine('error', 'study_session_save_failed', {
      uploadId, studyId, error: errorDetail(error), ...logTag,
    });
    return;
  }

  logLine('info', 'study_session_ready', {
    uploadId, studyId, sentenceCount: normalized.length, ...logTag,
  });
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

    const status = submitResponse.text || submitResponse.segments ? 'speaker_selection' : 'processing';
    if (status === 'speaker_selection') {
      statements.completeAudioUpload.run(
        JSON.stringify(submitResponse),
        buildTranscriptText(submitResponse) || null,
        upload.id
      );
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

function pcmToWav(pcm, { sampleRate, bitsPerSample = 16, numChannels = 1 }) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function packageGeminiAudio(rawAudio, mimeType) {
  const lower = String(mimeType || '').toLowerCase();
  if (lower.includes('audio/l16') || lower.includes('audio/pcm') || lower.includes('codec=pcm')) {
    const rateMatch = lower.match(/rate=(\d+)/);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    return { buffer: pcmToWav(rawAudio, { sampleRate }), mime: 'audio/wav', extension: '.wav' };
  }
  if (lower.includes('audio/wav') || lower.includes('audio/x-wav')) {
    return { buffer: rawAudio, mime: 'audio/wav', extension: '.wav' };
  }
  if (lower.includes('audio/mpeg') || lower.includes('audio/mp3')) {
    return { buffer: rawAudio, mime: 'audio/mpeg', extension: '.mp3' };
  }
  if (lower.includes('audio/ogg')) {
    return { buffer: rawAudio, mime: 'audio/ogg', extension: '.ogg' };
  }
  return { buffer: pcmToWav(rawAudio, { sampleRate: 24000 }), mime: 'audio/wav', extension: '.wav' };
}

async function synthesizeNativeAudio({ text, userId, sentenceId, req }) {
  if (!GEMINI_API_KEY) {
    const error = new Error('Set GEMINI_API_KEY before requesting native audio.');
    error.status = 500;
    throw error;
  }

  const trimmed = String(text || '').trim();
  if (!trimmed) {
    const error = new Error('No native sentence text is available to synthesize.');
    error.status = 400;
    throw error;
  }

  const promptText = `## Sample Context:\n${GEMINI_TTS_CONTEXT}\n\n## Transcript:\n${trimmed}`;

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [{ text: promptText }],
    }],
    generationConfig: {
      responseModalities: ['audio'],
      temperature: 1,
      speech_config: {
        voice_config: {
          prebuilt_voice_config: {
            voice_name: GEMINI_TTS_VOICE,
          },
        },
      },
    },
  };

  const endpoint = `${GEMINI_API_BASE}/models/${encodeURIComponent(GEMINI_TTS_MODEL)}:streamGenerateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  addRequestLogEvent(req, 'native_audio_tts_started', {
    sentenceId,
    provider: 'gemini',
    model: GEMINI_TTS_MODEL,
    voice: GEMINI_TTS_VOICE,
    inputLength: trimmed.length,
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();

  if (!response.ok) {
    let parsedMessage = '';
    try {
      const parsed = responseText ? JSON.parse(responseText) : null;
      const errNode = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
      parsedMessage = errNode?.message || (typeof errNode === 'string' ? errNode : '') || parsed?.message || '';
    } catch {
      parsedMessage = responseText.slice(0, 200);
    }
    const message = parsedMessage || `Gemini TTS returned ${response.status}.`;
    addRequestLogEvent(req, 'native_audio_tts_failed', {
      sentenceId,
      status: response.status,
      message,
    });
    const error = new Error(String(message));
    error.status = 502;
    throw error;
  }

  let chunks;
  try {
    chunks = JSON.parse(responseText);
  } catch {
    addRequestLogEvent(req, 'native_audio_tts_parse_failed', {
      sentenceId,
      preview: responseText.slice(0, 200),
    });
    const error = new Error('Gemini TTS returned an unparseable response.');
    error.status = 502;
    throw error;
  }
  if (!Array.isArray(chunks)) chunks = [chunks];

  const audioParts = [];
  let detectedMime = '';
  for (const chunk of chunks) {
    const candidates = Array.isArray(chunk?.candidates) ? chunk.candidates : [];
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      for (const part of parts) {
        const inline = part?.inlineData || part?.inline_data;
        if (inline?.data) {
          audioParts.push(Buffer.from(inline.data, 'base64'));
          if (!detectedMime && (inline.mimeType || inline.mime_type)) {
            detectedMime = inline.mimeType || inline.mime_type;
          }
        }
      }
    }
  }

  if (!audioParts.length) {
    addRequestLogEvent(req, 'native_audio_tts_empty', { sentenceId });
    const error = new Error('Gemini TTS returned no audio data.');
    error.status = 502;
    throw error;
  }

  const rawAudio = Buffer.concat(audioParts);
  const { buffer, mime, extension } = packageGeminiAudio(rawAudio, detectedMime);

  const dir = path.join(NATIVE_AUDIO_ROOT, String(userId));
  await fs.mkdir(dir, { recursive: true });
  const storedFilename = `${sentenceId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`;
  const storagePath = path.join(dir, storedFilename);
  await fs.writeFile(storagePath, buffer);

  let row;
  try {
    row = statements.insertNativeAudio.get(
      sentenceId,
      userId,
      trimmed,
      GEMINI_TTS_VOICE,
      GEMINI_TTS_LANGUAGE,
      storedFilename,
      storagePath,
      mime,
      buffer.length
    );
  } catch (error) {
    await fs.unlink(storagePath).catch(() => {});
    throw error;
  }

  addRequestLogEvent(req, 'native_audio_tts_saved', {
    sentenceId,
    sizeBytes: buffer.length,
    nativeAudioId: row.id,
    mimeType: mime,
    upstreamMime: detectedMime || null,
  });

  return { row, buffer, mime };
}

async function readRequestBodyToBuffer(req, limitBytes) {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength && contentLength > limitBytes) {
    const error = new Error('Audio file is too large.');
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error('Audio file is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    const error = new Error('Empty audio body.');
    error.status = 400;
    throw error;
  }
  return Buffer.concat(chunks);
}

function publicPronunciationAssessment(row) {
  if (!row) return null;
  let azureResponse = null;
  if (row.azure_response_json) {
    try { azureResponse = JSON.parse(row.azure_response_json); } catch {}
  }
  return {
    id: row.id,
    studySentenceId: row.study_sentence_id,
    referenceText: row.reference_text,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    pronScore: row.pron_score,
    accuracyScore: row.accuracy_score,
    fluencyScore: row.fluency_score,
    completenessScore: row.completeness_score,
    recognitionStatus: row.recognition_status,
    displayText: row.display_text,
    azureResponse,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function callAzurePronunciationAssessment({ referenceText, audioBuffer, mimeType }) {
  if (!AZURE_SPEECH_KEY) {
    const error = new Error('Azure Speech API key is not configured on the server.');
    error.status = 500;
    throw error;
  }
  const params = {
    ReferenceText: referenceText,
    GradingSystem: 'HundredMark',
    Granularity: 'Word',
    Dimension: 'Comprehensive',
    EnableMiscue: true,
  };
  const pronHeader = Buffer.from(JSON.stringify(params), 'utf8').toString('base64');
  const url = `https://${AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(AZURE_PRONUNCIATION_LANGUAGE)}&format=detailed`;
  const contentType = mimeType && mimeType.startsWith('audio/ogg')
    ? 'audio/ogg; codecs=opus'
    : 'audio/wav; codecs=audio/pcm; samplerate=16000';

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
        'Content-Type': contentType,
        Accept: 'application/json',
        'Pronunciation-Assessment': pronHeader,
      },
      body: audioBuffer,
    });
  } catch (cause) {
    const error = new Error('Unable to reach Azure Speech service.');
    error.status = 502;
    error.cause = cause;
    throw error;
  }

  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}

  if (!response.ok) {
    const error = new Error(
      (parsed && (parsed.message || parsed.error)) ||
      `Azure Speech request failed (${response.status}).`
    );
    error.status = response.status === 401 || response.status === 403 ? 502 : 502;
    error.azureStatus = response.status;
    error.azureBody = text.slice(0, 2000);
    throw error;
  }

  if (!parsed) {
    const error = new Error('Azure Speech returned an unparseable response.');
    error.status = 502;
    error.azureBody = text.slice(0, 2000);
    throw error;
  }

  return parsed;
}

function sendNativeAudioBuffer(res, buffer, mimeType) {
  res.writeHead(200, {
    'Content-Type': mimeType || 'audio/wav',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none',
  });
  res.end(buffer);
}

async function handleAudio(req, res, url) {
  if (url.pathname === '/api/audio/uploads' && req.method === 'GET') {
    const user = requireUser(req, res);
    if (!user) return;
    const uploads = statements.listAudioUploads.all(user.id).map(publicAudioUpload);
    addRequestLogDetail(req, { uploadCount: uploads.length });
    return json(res, 200, { uploads });
  }

  {
    const nativeMatch = url.pathname.match(/^\/api\/audio\/study-sentences\/(\d+)\/native-audio$/);
    if (nativeMatch && (req.method === 'GET' || req.method === 'POST' || req.method === 'HEAD')) {
      if (req.method === 'POST' && !isSameOrigin(req)) {
        markRequestLogError(req, 403, 'Invalid request origin.', { origin: req.headers.origin || null });
        return json(res, 403, { error: 'Invalid request origin.' });
      }

      const user = requireUser(req, res);
      if (!user) return;

      const sentenceId = Number(nativeMatch[1]);
      const sentenceRow = statements.getStudySentenceForUser.get(sentenceId, user.id);
      if (!sentenceRow) {
        markRequestLogError(req, 404, 'Study sentence not found.', { sentenceId });
        return json(res, 404, { error: 'Sentence not found.' });
      }

      const cached = statements.getNativeAudioForSentence.get(sentenceId, user.id);
      if (cached) {
        try {
          const buffer = await fs.readFile(cached.storage_path);
          addRequestLogEvent(req, 'native_audio_served_cached', {
            sentenceId,
            nativeAudioId: cached.id,
            sizeBytes: buffer.length,
          });
          return sendNativeAudioBuffer(res, buffer, cached.mime_type || 'audio/wav');
        } catch (error) {
          addRequestLogEvent(req, 'native_audio_cache_missing', {
            sentenceId,
            nativeAudioId: cached.id,
            code: error.code || null,
          });
          statements.deleteNativeAudio.run(cached.id);
        }
      }

      if (req.method !== 'POST') {
        return json(res, 404, { error: 'Native audio not synthesized yet.' });
      }

      const inputText = sentenceRow.native_speaker_version || sentenceRow.original_sentence;
      if (!inputText || !String(inputText).trim()) {
        return json(res, 400, { error: 'No native sentence text is available to synthesize.' });
      }

      try {
        const { buffer, mime } = await synthesizeNativeAudio({
          text: inputText,
          userId: user.id,
          sentenceId,
          req,
        });
        return sendNativeAudioBuffer(res, buffer, mime || 'audio/wav');
      } catch (error) {
        const status = error.status || 500;
        markRequestLogError(req, status, error.message || 'Unable to synthesize native audio.', {
          sentenceId,
        });
        return json(res, status, { error: error.message || 'Unable to synthesize native audio.' });
      }
    }
  }

  {
    const assessMatch = url.pathname.match(/^\/api\/audio\/study-sentences\/(\d+)\/pronunciation-assessment$/);
    if (assessMatch) {
      const sentenceId = Number(assessMatch[1]);

      if (req.method === 'GET') {
        const user = requireUser(req, res);
        if (!user) return;
        const sentenceRow = statements.getStudySentenceForUser.get(sentenceId, user.id);
        if (!sentenceRow) return json(res, 404, { error: 'Sentence not found.' });
        const row = statements.getPronunciationAssessmentForSentence.get(sentenceId, user.id);
        return json(res, 200, { assessment: publicPronunciationAssessment(row) });
      }

      if (req.method === 'POST') {
        if (!isSameOrigin(req)) {
          markRequestLogError(req, 403, 'Invalid request origin.', { origin: req.headers.origin || null });
          return json(res, 403, { error: 'Invalid request origin.' });
        }
        const user = requireUser(req, res);
        if (!user) return;

        const sentenceRow = statements.getStudySentenceForUser.get(sentenceId, user.id);
        if (!sentenceRow) {
          markRequestLogError(req, 404, 'Study sentence not found.', { sentenceId });
          return json(res, 404, { error: 'Sentence not found.' });
        }

        const referenceText = String(
          sentenceRow.native_speaker_version || sentenceRow.original_sentence || ''
        ).trim();
        if (!referenceText) {
          return json(res, 400, { error: 'No reference text is available for this sentence.' });
        }

        const incomingType = String(req.headers['content-type'] || '').toLowerCase();
        const isOgg = incomingType.includes('audio/ogg');
        const audioBuffer = await readRequestBodyToBuffer(req, MAX_PRONUNCIATION_BYTES);

        addRequestLogEvent(req, 'pronunciation_assessment_received', {
          sentenceId,
          sizeBytes: audioBuffer.length,
          contentType: incomingType || null,
        });

        let azureResult;
        try {
          azureResult = await callAzurePronunciationAssessment({
            referenceText,
            audioBuffer,
            mimeType: isOgg ? 'audio/ogg' : 'audio/wav',
          });
          {
            const b = azureResult && Array.isArray(azureResult.NBest) ? azureResult.NBest[0] : null;
            const p = b ? (b.PronunciationAssessment || b) : null;
            addRequestLogEvent(req, 'pronunciation_azure_response', {
              sentenceId,
              recognitionStatus: azureResult && azureResult.RecognitionStatus,
              displayText: azureResult && azureResult.DisplayText,
              pronScore: p ? p.PronScore : null,
            });
          }
        } catch (error) {
          const status = error.status || 502;
          logLine('error', 'pronunciation_azure_failed', {
            sentenceId,
            azureStatus: error.azureStatus || null,
            azureBody: error.azureBody || null,
            error: errorDetail(error),
          });
          markRequestLogError(req, status, error.message || 'Azure pronunciation assessment failed.', {
            sentenceId,
            azureStatus: error.azureStatus || null,
            azureBody: error.azureBody || null,
          });
          return json(res, status, {
            error: error.message || 'Pronunciation assessment failed.',
            azureStatus: error.azureStatus || null,
            azureBody: error.azureBody || null,
          });
        }

        const dir = path.join(PRONUNCIATION_AUDIO_ROOT, String(user.id));
        await fs.mkdir(dir, { recursive: true });
        const ext = isOgg ? '.ogg' : '.wav';
        const storedFilename = `${sentenceId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
        const storagePath = path.join(dir, storedFilename);
        await fs.writeFile(storagePath, audioBuffer);

        const existing = statements.getPronunciationAssessmentForSentence.get(sentenceId, user.id);
        if (existing && existing.storage_path && existing.storage_path !== storagePath) {
          fs.unlink(existing.storage_path).catch(() => {});
        }

        const best = Array.isArray(azureResult.NBest) && azureResult.NBest.length ? azureResult.NBest[0] : null;
        const pron = best ? (best.PronunciationAssessment || best) : null;
        const recognitionStatus = String(azureResult.RecognitionStatus || '');
        const displayText = String(azureResult.DisplayText || (best && best.Display) || '');
        const mimeType = isOgg ? 'audio/ogg' : 'audio/wav';
        const numOrNull = (v) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };

        const row = statements.upsertPronunciationAssessment.get(
          sentenceId,
          user.id,
          referenceText,
          storedFilename,
          storagePath,
          mimeType,
          audioBuffer.length,
          JSON.stringify(azureResult),
          pron ? numOrNull(pron.PronScore) : null,
          pron ? numOrNull(pron.AccuracyScore) : null,
          pron ? numOrNull(pron.FluencyScore) : null,
          pron ? numOrNull(pron.CompletenessScore) : null,
          recognitionStatus || null,
          displayText || null
        );

        const pronScoreNum = pron ? numOrNull(pron.PronScore) : null;
        const shouldMarkDone = pronScoreNum != null && pronScoreNum >= 85 ? 1 : 0;
        statements.setStudySentenceDone.run(shouldMarkDone, sentenceId, sentenceRow.study_session_id);
        statements.recountStudyCompleted.run(sentenceRow.study_session_id);

        addRequestLogEvent(req, 'pronunciation_assessment_saved', {
          sentenceId,
          recognitionStatus,
          pronScore: pron ? pron.PronScore : null,
          markedDone: !!shouldMarkDone,
        });

        return json(res, 200, { assessment: publicPronunciationAssessment(row) });
      }
    }

    const recordingMatch = url.pathname.match(/^\/api\/audio\/study-sentences\/(\d+)\/user-recording$/);
    if (recordingMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const user = requireUser(req, res);
      if (!user) return;
      const sentenceId = Number(recordingMatch[1]);
      const row = statements.getPronunciationAssessmentForSentence.get(sentenceId, user.id);
      if (!row) {
        return text(res, 404, 'Not Found\n');
      }
      let buffer;
      try {
        buffer = await fs.readFile(row.storage_path);
      } catch {
        return text(res, 404, 'Not Found\n');
      }
      res.writeHead(200, {
        'Content-Type': row.mime_type || 'audio/wav',
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'none',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(buffer);
    }
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
    const title = originalFilename || 'Audio session';

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

  if (url.pathname.startsWith('/api/audio/uploads/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const playbackUploadId = parseUploadChildPath(url.pathname, 'source');
    if (playbackUploadId !== null) {
      const user = requireUser(req, res);
      if (!user) return;

      const upload = statements.getAudioUploadPlaybackForUser.get(playbackUploadId, user.id);
      if (!upload) {
        markRequestLogError(req, 404, 'Upload audio source not found.', { uploadId: playbackUploadId });
        return text(res, 404, 'Not Found\n');
      }

      return streamAudioUpload(req, res, upload);
    }

    const studyUploadId = parseUploadChildPath(url.pathname, 'study');
    if (studyUploadId !== null && req.method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return;

      const upload = statements.getAudioUploadForUser.get(studyUploadId, user.id);
      if (!upload) {
        markRequestLogError(req, 404, 'Upload not found.', { uploadId: studyUploadId });
        return text(res, 404, 'Not Found\n');
      }

      const studyRow = statements.getStudySessionForUser.get(studyUploadId, user.id);
      if (!studyRow) {
        return json(res, 200, { upload: publicAudioUpload(upload), study: null });
      }

      const sentenceRows = statements.getStudySentencesForSession.all(studyRow.id);
      return json(res, 200, {
        upload: publicAudioUpload(upload),
        study: publicStudySession(studyRow, sentenceRows),
      });
    }
  }

  if (url.pathname.startsWith('/api/audio/uploads/') && req.method === 'POST') {
    const titleUploadId = parseUploadChildPath(url.pathname, 'title');
    if (titleUploadId !== null) {
      if (!isSameOrigin(req)) {
        markRequestLogError(req, 403, 'Invalid request origin.', { origin: req.headers.origin || null });
        return json(res, 403, { error: 'Invalid request origin.' });
      }
      const user = requireUser(req, res);
      if (!user) return;

      const body = await readJson(req);
      const rawTitle = String(body.title ?? '').replace(/\s+/g, ' ').trim();
      if (!rawTitle) return json(res, 400, { error: 'Enter a session name.' });
      if (rawTitle.length > 180) return json(res, 400, { error: 'Session name is too long.' });

      const updated = statements.updateAudioUploadTitle.get(rawTitle, titleUploadId, user.id);
      if (!updated) {
        markRequestLogError(req, 404, 'Upload not found.', { uploadId: titleUploadId });
        return text(res, 404, 'Not Found\n');
      }
      const refreshed = statements.getAudioUploadForUser.get(titleUploadId, user.id);
      return json(res, 200, { upload: publicAudioUpload(refreshed || updated) });
    }

    const speakerUploadId = parseUploadChildPath(url.pathname, 'speaker');
    if (speakerUploadId !== null) {
      if (!isSameOrigin(req)) {
        markRequestLogError(req, 403, 'Invalid request origin.', {
          origin: req.headers.origin || null,
        });
        return json(res, 403, { error: 'Invalid request origin.' });
      }

      const user = requireUser(req, res);
      if (!user) return;

      const upload = statements.getAudioUploadForUser.get(speakerUploadId, user.id);
      if (!upload) {
        markRequestLogError(req, 404, 'Upload not found.', { uploadId: speakerUploadId });
        return text(res, 404, 'Not Found\n');
      }

      const body = await readJson(req);
      const speaker = String(body.speaker ?? '').trim();
      if (!speaker || speaker.length > 80) {
        return json(res, 400, { error: 'Choose a speaker from the transcript.' });
      }

      const transcript = transcriptForAudioUpload(upload, req);
      const speakers = speakersFromTranscript(transcript);
      if (!speakers.length) {
        return json(res, 409, { error: 'No speaker labels were found in this transcript.' });
      }
      if (!speakers.includes(speaker)) {
        return json(res, 400, { error: 'Choose one of the speakers Lemonfox found in this transcript.' });
      }
      if (!['speaker_selection', 'completed', 'speaker_selected', 'study_processing', 'study_ready', 'study_failed'].includes(upload.status)) {
        return json(res, 409, { error: 'Speaker selection is not available for this upload yet.' });
      }

      const updated = statements.selectUploadSpeaker.get(speaker, upload.id, user.id);
      addRequestLogEvent(req, 'audio_speaker_selected', {
        uploadId: upload.id,
        speaker,
      });

      const lemonfoxResponse = transcript;
      const transcriptText = upload.lemonfox_transcript_text || buildTranscriptText(lemonfoxResponse);
      processStudySession({
        uploadId: upload.id,
        userId: user.id,
        selectedSpeaker: speaker,
        transcriptText,
        lemonfoxResponse,
        logTag: { route: 'speaker_select' },
      }).catch(error => {
        logLine('error', 'study_session_unhandled_error', {
          uploadId: upload.id,
          error: errorDetail(error),
        });
      });

      const refreshed = statements.getAudioUploadForUser.get(upload.id, user.id);
      return json(res, 200, { upload: publicAudioUpload(refreshed || updated), transcript });
    }

    const progressMatch = url.pathname.match(/^\/api\/audio\/uploads\/(\d+)\/study\/progress$/);
    if (progressMatch) {
      if (!isSameOrigin(req)) {
        markRequestLogError(req, 403, 'Invalid request origin.', { origin: req.headers.origin || null });
        return json(res, 403, { error: 'Invalid request origin.' });
      }

      const user = requireUser(req, res);
      if (!user) return;

      const studyUploadId = Number(progressMatch[1]);
      const studyRow = statements.getStudySessionForUser.get(studyUploadId, user.id);
      if (!studyRow) {
        return json(res, 404, { error: 'No study session found for this upload.' });
      }
      if (studyRow.status !== 'ready') {
        return json(res, 409, { error: 'Study session is not ready yet.' });
      }

      const body = await readJson(req);
      const updates = [];

      if (body.currentIndex !== undefined && body.currentIndex !== null) {
        const idx = Number(body.currentIndex);
        if (Number.isInteger(idx) && idx >= 0 && idx < (studyRow.sentence_count || 0) + 50) {
          statements.updateStudyCurrentIndex.run(idx, studyRow.id);
          updates.push('currentIndex');
        }
      }

      if (Array.isArray(body.sentenceUpdates)) {
        for (const item of body.sentenceUpdates) {
          if (!item || typeof item !== 'object') continue;
          const id = Number(item.id);
          if (!Number.isInteger(id)) continue;
          const done = item.done ? 1 : 0;
          statements.setStudySentenceDone.run(done, id, studyRow.id);
          updates.push(`sentence:${id}`);
        }
        statements.recountStudyCompleted.run(studyRow.id);
      }

      const refreshed = statements.getStudySessionForUser.get(studyUploadId, user.id);
      const sentenceRows = statements.getStudySentencesForSession.all(refreshed.id);
      return json(res, 200, {
        ok: true,
        applied: updates,
        study: publicStudySession(refreshed, sentenceRows),
      });
    }
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
    statements.completeAudioUpload.run(
      JSON.stringify(body),
      buildTranscriptText(body) || null,
      upload.id
    );
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
