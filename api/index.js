const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const wrapper = require('../github/providers/wrapper');

const app = express();

// Playful security responses. They change on every rejected request.
const SECURITY_MESSAGES = [
  'امك ليس هنا يا صغيري.',
  'ارجع من حيث أتيت يا بطل.',
  'حلوة المحاولة... بس لا.',
  'الباب مقفول يا عبقري.',
  'مين سمحلك تفوت؟',
  'واضح إنك نسيت المفتاح بالبيت.',
  'مو هالمرة يا شاطر.',
  'الخادم قال لك: لا يا حبيب.',
  'محاولة لطيفة، النتيجة لا.',
  'هون مو مكانك يا صديقي.',
  'تذاكر الدخول لو سمحت... آه، ما معك.',
  'شكراً على الزيارة، بس ممنوع الدخول.',
  'وقف هون يا أسطورة.',
  'السيرفر شافك وقال: مستحيل.',
  'كان لازم تجيب تصريح دخول.',
  'لا تتعب حالك، الحماية شغالة.',
  'قريب... بس لسا لا.',
  'مين قال لك إن الباب مفتوح؟',
  'جرب مرة ثانية بعد ما تجيب الصلاحية.',
  'المحاولة مرفوضة يا معلم.'
];

function securityMessage() {
  return SECURITY_MESSAGES[crypto.randomInt(SECURITY_MESSAGES.length)];
}

const DEFAULT_PLACEHOLDER_IMAGE =
  "https://images.placeholders.dev/?width=500&height=750&text=Stream+Master&theme=dark";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/150.0.0.0";

const JWT_SECRET = process.env.JWT_SECRET;
const SUBDL_API_KEY = process.env.SUBDL_API_KEY;
const SUBDL_API_BASE = 'https://api.subdl.com';

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error("JWT_SECRET (32+ chars) is required");
if (!SUBDL_API_KEY) throw new Error('SUBDL_API_KEY is required');

// Optional. Without it /api/trailer answers 503 and the app simply hides the Trailer button.
// (The key itself is only ever read from the environment and is never logged or returned.)
if (!process.env.YOUTUBE_API_KEY) {
  console.warn('[TRAILER] YOUTUBE_API_KEY is not set: /api/trailer will answer 503 until it is configured.');
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Where small persistent state lives (registered device keys, ban list).
// On hosts with an ephemeral disk (Render free, Heroku, Railway w/o volume) the
// default ../ folder is WIPED on every deploy/restart: every device then becomes
// "unknown" to the server. Point DATA_DIR at a persistent disk/volume to avoid that.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

// Public liveness/readiness probe (no auth, before the abuse guard). Point an
// uptime pinger at it to keep a sleeping host awake; `ready:false` = DB not loaded.
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(db ? 200 : 503).json({ ok: !!db, ready: !!db });
});

// ============================================================
// Abuse guard — persistent ban layer on top of the per-minute rate
// limiters below. A rate limiter alone only slows a bot down inside
// its own window; it does nothing to a bot that simply stays under
// the limit forever. This tracks how many times a device/IP gets
// rate-limited across a rolling day, and once it crosses the
// threshold, blocks every request from that device/IP outright for
// BAN_DURATION_MS — independent of whether any single request would
// have been allowed by the minute-by-minute limiters.
// The ban list survives restarts (small JSON file next to movies.db).
// ============================================================

const ABUSE_VIOLATION_WINDOW_MS = 24 * 60 * 60 * 1000; // rolling day
const ABUSE_VIOLATION_THRESHOLD = parseInt(process.env.ABUSE_VIOLATION_THRESHOLD, 10) || 40; // 429s within that day
const ABUSE_BAN_DURATION_MS = (parseInt(process.env.ABUSE_BAN_HOURS, 10) || 1) * 60 * 60 * 1000; // default 1 hour (was 7 days)
const ABUSE_BANS_FILE = path.join(DATA_DIR, 'abuse-bans.json');

const abuseViolations = new Map(); // key -> { count, windowStart }
const abuseBans = new Map();       // key -> expiresAtMs

function loadAbuseBans() {
  try {
    if (!fs.existsSync(ABUSE_BANS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ABUSE_BANS_FILE, 'utf8'));
    const now = Date.now();
    for (const [key, expiresAt] of Object.entries(raw)) {
      if (typeof expiresAt === 'number' && expiresAt > now) abuseBans.set(key, expiresAt);
    }
    console.log(`[ABUSE] loaded ${abuseBans.size} active ban(s) from disk.`);
  } catch (err) {
    console.warn('[ABUSE] could not read ban list, starting empty:', err.message);
  }
}

function saveAbuseBans() {
  try {
    const obj = Object.fromEntries(abuseBans);
    fs.writeFileSync(ABUSE_BANS_FILE, JSON.stringify(obj), 'utf8');
  } catch (err) {
    console.warn('[ABUSE] could not persist ban list:', err.message);
  }
}

loadAbuseBans();

/** Prefer the app-generated device id (one per install) over the shared/NAT-ed IP. */
function abuseKey(req) {
  const deviceId = String(req.headers['x-device-id'] || '').trim();
  return deviceId ? `d:${deviceId.slice(0, 128)}` : `ip:${req.ip}`;
}

/** Called by every limiter below when a request gets rate-limited (see abuseAwareHandler). */
function recordAbuseViolation(key) {
  const now = Date.now();
  const entry = abuseViolations.get(key);

  if (!entry || now - entry.windowStart > ABUSE_VIOLATION_WINDOW_MS) {
    abuseViolations.set(key, { count: 1, windowStart: now });
    return;
  }

  entry.count += 1;
  if (entry.count >= ABUSE_VIOLATION_THRESHOLD) {
    abuseBans.set(key, now + ABUSE_BAN_DURATION_MS);
    abuseViolations.delete(key);
    saveAbuseBans();
    console.warn(`[ABUSE] banned ${key} for ${Math.round(ABUSE_BAN_DURATION_MS / 3600000)}h after ${entry.count} rate-limit hits in 24h.`);
  }
}

/** Shared `handler` for every rateLimit() below: counts the violation, then answers 429 as before. */
function abuseAwareHandler(req, res) {
  recordAbuseViolation(abuseKey(req));
  res.status(429).json({ success: false, message: securityMessage() });
}

/** For the auth-bootstrap endpoints: answer 429 but NEVER count towards a ban.
 *  A real app legitimately hits these in bursts (cold start, token expiry); banning
 *  it for that locked people out of the whole API. */
function softLimitHandler(req, res) {
  res.set('Retry-After', '30');
  res.status(429).json({ success: false, message: securityMessage() });
}

function abuseGuard(req, res, next) {
  const key = abuseKey(req);
  const expiresAt = abuseBans.get(key);
  if (expiresAt === undefined) return next();

  if (expiresAt <= Date.now()) {
    abuseBans.delete(key);
    saveAbuseBans();
    return next();
  }

  return res.status(403).json({ success: false, message: securityMessage() });
}

app.use(abuseGuard);
app.use(helmet());
app.use(express.json({ limit: '32kb' }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed'));
  }
}));

const tokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: softLimitHandler
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
  handler: abuseAwareHandler
});

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.auth?.sub || req.ip),
  handler: abuseAwareHandler
});

const subtitleLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: abuseAwareHandler
});

// Registration is rate-limited hard since it is the one endpoint that will
// accept a brand-new, previously-unseen device_id (trust-on-first-use — see
// the route below). Keyed by IP, since the whole point is a device that has
// never talked to us before.
const deviceRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: softLimitHandler
});

// challenge + verify are the day-to-day bootstrap path for every already
// registered device (the only bootstrap path now — /api/token is gone), so this needs to be usable far
// more often than register — but each one only ever proves possession of a
// key that already passed registration, so it is still its own limiter
// rather than sharing the generic apiLimiter.
const deviceAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${String(req.query?.device_id || req.body?.device_id || '')}`,
  handler: softLimitHandler
});

let db = null;
let dbInitAttempts = 0;

async function initDatabase() {
  try {
    const sqlWasmPath = path.join(__dirname, 'sql-wasm.wasm');
    const dbPath = path.join(__dirname, '../movies.db');

    console.log('[DB] Initializing SQLite database...');
    console.log('[DB] sql-wasm path:', sqlWasmPath);
    console.log('[DB] database path:', dbPath);
    console.log('[DB] database exists:', fs.existsSync(dbPath));

    const SQL = await initSqlJs({ locateFile: () => sqlWasmPath });
    const filebuffer = fs.readFileSync(dbPath);

    console.log('[DB] database size:', filebuffer.length, 'bytes');
    console.log('[DB] database header:', filebuffer.subarray(0, 16).toString('utf8'));

    db = new SQL.Database(filebuffer);

    // Verify the database immediately and log the actual schema state.
    const tableCheck = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tables = tableCheck.length && tableCheck[0].values
      ? tableCheck[0].values.map(row => row[0])
      : [];

    console.log('[DB] SQLite database initialized successfully.');
    console.log('[DB] tables:', tables.join(', ') || '(none)');

    for (const table of ['tv_shows', 'episodes']) {
      if (!tables.includes(table)) {
        console.warn(`[DB] table "${table}" not found: /api/series will answer with an empty list.`);
        continue;
      }
      const countResult = db.exec(`SELECT COUNT(*) FROM ${table}`);
      const count = countResult.length ? countResult[0].values[0][0] : 0;
      console.log(`[DB] ${table}:`, count, 'rows');
    }
  } catch (err) {
    console.error('[DB INIT ERROR] message:', err && err.message ? err.message : err);
    console.error('[DB INIT ERROR] stack:', err && err.stack ? err.stack : '(no stack)');
    if (++dbInitAttempts < 6) {
      console.warn(`[DB] retrying in 10s (attempt ${dbInitAttempts}/5)`);
      setTimeout(initDatabase, 10000);
    }
  }
}

initDatabase();

function getFebboxCookie() {
  const cookie = process.env.FEBBOX_COOKIE;
  return cookie ? cookie.trim() : null;
}

function getYoutubeApiKey() {
  const key = process.env.YOUTUBE_API_KEY;
  return key ? key.trim() : null;
}

function queryAll(sql, params = []) {
  if (!db) return [];

  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);

    const results = [];

    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }

    stmt.free();
    return results;
  } catch (e) {
    console.error('[SQL ERROR] message:', e && e.message ? e.message : e);
    console.error('[SQL ERROR] query:', String(sql).replace(/\s+/g, ' ').trim());
    console.error('[SQL ERROR] params:', JSON.stringify(params));
    console.error('[SQL ERROR] stack:', e && e.stack ? e.stack : '(no stack)');
    return [];
  }
}

function queryGet(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function fixImageUrl(poster, backdrop) {
  let rawImg =
    (poster &&
      String(poster).trim() &&
      !['none', 'null', '', 'false'].includes(
        String(poster).trim().toLowerCase()
      ))
      ? poster
      : backdrop;

  if (
    !rawImg ||
    ['none', 'null', '', 'false'].includes(
      String(rawImg).trim().toLowerCase()
    )
  ) {
    return DEFAULT_PLACEHOLDER_IMAGE;
  }

  rawImg = String(rawImg).trim();

  if (
    rawImg.startsWith("http://") ||
    rawImg.startsWith("https://")
  ) {
    return rawImg;
  }

  if (rawImg.startsWith("//")) {
    return "https:" + rawImg;
  }

  if (rawImg.startsWith("/")) {
    return `https://image.tmdb.org/t/p/w500${rawImg}`;
  }

  return `https://image.tmdb.org/t/p/w500/${rawImg}`;
}

function getLangField(m, fieldPrefix, lang) {
  lang = String(lang || 'ar').toLowerCase();

  const targetKey = `${fieldPrefix}_${lang}`;

  if (
    m[targetKey] &&
    String(m[targetKey]).trim() &&
    !['none', 'null', ''].includes(
      String(m[targetKey]).trim().toLowerCase()
    )
  ) {
    return String(m[targetKey]).trim();
  }

  const fallbacks =
    lang === 'es'
      ? ['es', 'en', 'ar', 'local']
      : lang === 'en'
        ? ['en', 'ar', 'es', 'local']
        : ['ar', 'en', 'es', 'local'];

  for (const l of fallbacks) {
    const altKey = `${fieldPrefix}_${l}`;

    if (
      m[altKey] &&
      String(m[altKey]).trim() &&
      !['none', 'null', ''].includes(
        String(m[altKey]).trim().toLowerCase()
      )
    ) {
      return String(m[altKey]).trim();
    }
  }

  for (const alt of ['original_title', 'title_local']) {
    if (
      m[alt] &&
      String(m[alt]).trim() &&
      !['none', 'null', ''].includes(
        String(m[alt]).trim().toLowerCase()
      )
    ) {
      return String(m[alt]).trim();
    }
  }

  return "Untitled";
}

function formatMovie(m, lang = "ar", includeDetails = false) {
  lang = String(lang || 'ar').toLowerCase();

  const title = getLangField(m, "title", lang);

  // NOTE: getLangField() ends by returning original_title / "Untitled", so it can
  // never be "empty". Descriptive fields use pickLang(), which returns '' when the
  // database has nothing (otherwise a missing director showed the movie's TITLE).
  const desc =
    pickLang(m, "overview", lang) ||
    `Watch ${title} now in high quality on Stream Master.`;

  const genre =
    pickLang(m, "genre", lang);

  let posterVal =
    lang === 'en'
      ? (m.poster_en || m.poster)
      : lang === 'es'
        ? (m.poster_es || m.poster)
        : (m.poster_ar || m.poster);

  if (
    !posterVal ||
    ['none', 'null', '', 'false'].includes(
      String(posterVal).trim().toLowerCase()
    )
  ) {
    posterVal = m.backdrop || m.poster;
  }

  const imageUrl = fixImageUrl(posterVal, m.backdrop);

  const formatted = {
    id: m.id,
    tmdb_id: m.tmdb_id,
    title,
    name: title,
    image: imageUrl,
    poster: imageUrl,
    cover: imageUrl,
    description: desc,
    overview: desc,
    vid: String(m.tmdb_id || m.id),
    rating: String(m.rating || "7.5"),
    vote: m.vote_count || 0,
    year: String(m.year || "2025"),
    genre,
    quality: m.quality || "1080p",
    language: m.language || lang.toUpperCase(),
    duration: `${m.runtime || 120} min`,
    media_type: m.media_type || "movie",
    slug: m.slug || ""
  };

  if (includeDetails) {
    const tagline = pickLang(m, "tagline", lang);

    formatted.tagline = tagline || m.tagline || "";
    formatted.budget = Number(m.budget || 0);
    formatted.revenue = Number(m.box_office || m.revenue || 0);
    formatted.box_office = Number(m.box_office || 0);
    formatted.status = m.status || "Released";
    formatted.release_date = m.release_date || m.year || "";

    formatted.genres = genre
      ? String(genre)
          .split(',')
          .map(v => v.trim())
          .filter(Boolean)
      : [];

    formatted.production_companies =
      parseJsonOrListField(m.production_companies);

    formatted.production_countries =
      parseJsonOrListField(m.production_countries);

    formatted.spoken_languages =
      parseJsonOrListField(m.spoken_languages);

    formatted.director =
      pickLang(m, "director", lang);

    formatted.runtime = Number(m.runtime || 0);

    formatted.poster_ar = m.poster_ar || "";
    formatted.poster_en = m.poster_en || "";
    formatted.poster_es = m.poster_es || "";
    formatted.backdrop = m.backdrop || "";
  }

  return formatted;
}

function parseJsonOrListField(value) {
  if (value === null || value === undefined) return [];

  const raw = String(value).trim();
  if (!raw || ['null', 'none', 'false'].includes(raw.toLowerCase())) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (parsed && typeof parsed === 'object') {
      return [parsed];
    }
  } catch (_) {
    // The database currently stores some fields as comma-separated text.
  }

  return raw
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function parseJsonArrayField(value) {
  if (value === null || value === undefined) return [];

  const raw = String(value).trim();
  if (!raw || ['null', 'none', 'false'].includes(raw.toLowerCase())) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function getMovieCast(movie) {
  if (!movie) return [];

  const source = parseJsonArrayField(movie.cast_json);

  return source
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({
      id: item.id ?? index + 1,
      name: item.name || item.original_name || "",
      character: item.character || "",
      profile_path:
        item.profile_path ||
        item.profilePath ||
        item.image ||
        item.profile ||
        "",
      order:
        Number.isFinite(Number(item.order))
          ? Number(item.order)
          : index
    }))
    .filter(item => item.name || item.character || item.profile_path);
}

function getMovieReviews(movie) {
  if (!movie) return [];

  const source = parseJsonArrayField(movie.reviews_json);

  return source
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({
      id: item.id ?? index + 1,
      author:
        item.author ||
        item.author_name ||
        item.username ||
        "",
      rating:
        item.rating === null ||
        item.rating === undefined ||
        item.rating === ""
          ? null
          : Number(item.rating),
      created_at:
        item.created_at ||
        item.date ||
        item.updated_at ||
        "",
      content:
        item.content ||
        item.text ||
        item.review ||
        ""
    }))
    .filter(item => item.author || item.content);
}



// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
//
// The provider architecture remains decentralized:
// providers are still downloaded/executed on the user's device.
// These tokens protect API access only; they do not carry provider code.
//
const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
const STREAM_SESSION_TTL_MS = 90 * 1000;

const streamSessions = new Map();

function cleanupStreamSessions() {
  const now = Date.now();

  for (const [ticket, session] of streamSessions) {
    if (!session || session.expiresAt <= now) {
      streamSessions.delete(ticket);
    }
  }
}

setInterval(cleanupStreamSessions, 30 * 1000).unref();

function createStreamSession(deviceId, streamData) {
  const ticket = crypto.randomBytes(32).toString('base64url');

  streamSessions.set(ticket, {
    deviceId: String(deviceId),
    expiresAt: Date.now() + STREAM_SESSION_TTL_MS,
    streamData
  });

  return ticket;
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(value) {
  const normalized = String(value)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  return Buffer.from(
    normalized +
      '='.repeat((4 - normalized.length % 4) % 4),
    'base64'
  );
}

function signJwt(payload) {
  const header = base64UrlEncode(
    JSON.stringify({
      alg: 'HS256',
      typ: 'JWT'
    })
  );

  const body = base64UrlEncode(
    JSON.stringify(payload)
  );

  const data = `${header}.${body}`;

  const sig = base64UrlEncode(
    crypto
      .createHmac('sha256', JWT_SECRET)
      .update(data)
      .digest()
  );

  return `${data}.${sig}`;
}

function verifyJwt(token) {
  const parts = String(token || '').split('.');

  if (parts.length !== 3) return null;

  const data = `${parts[0]}.${parts[1]}`;

  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest();

  const supplied = base64UrlDecode(parts[2]);

  if (
    expected.length !== supplied.length ||
    !crypto.timingSafeEqual(expected, supplied)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      base64UrlDecode(parts[1]).toString('utf8')
    );

    const now = Math.floor(Date.now() / 1000);

    if (
      !payload ||
      payload.iss !== 'stream-master' ||
      payload.exp <= now
    ) {
      return null;
    }

    return payload;
  } catch (_) {
    return null;
  }
}

function issueTokens(deviceId) {
  const now = Math.floor(Date.now() / 1000);

  const safeDeviceId = String(deviceId || '').slice(0, 128);

  const access = signJwt({
    iss: 'stream-master',
    typ: 'access',
    sub: safeDeviceId,
    iat: now,
    exp: now + ACCESS_TTL_SEC
  });

  const refresh = signJwt({
    iss: 'stream-master',
    typ: 'refresh',
    sub: safeDeviceId,
    iat: now,
    exp: now + REFRESH_TTL_SEC,
    jti: crypto.randomBytes(16).toString('hex')
  });

  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: ACCESS_TTL_SEC
  };
}

// The legacy MASTER_SECRET-based /api/token bootstrap has been removed entirely —
// not just disabled. The Android app never held that secret to begin with in this
// build, and the server no longer accepts it as a way to mint a token either.
// Device auth is Keystore/ECDSA challenge-response only, with no fallback route
// left anywhere in this file. See /api/device/register, /api/device/challenge,
// /api/device/verify below.

app.post('/api/refresh', tokenLimiter, (req, res) => {
  try {
    const refreshToken = String(
      req.body?.refresh_token || ''
    );

    const deviceId = String(
      req.body?.device_id || ''
    ).trim();

    if (
      !refreshToken ||
      !deviceId ||
      deviceId.length > 128
    ) {
      return res.status(401).json({
        success: false,
        message: securityMessage()
      });
    }

    const payload = verifyJwt(refreshToken);

    if (
      !payload ||
      payload.typ !== 'refresh' ||
      payload.sub !== deviceId ||
      !deviceKeys.has(deviceId)
    ) {
      return res.status(401).json({
        success: false,
        message: securityMessage()
      });
    }

    return res.json({
      success: true,
      ...issueTokens(deviceId)
    });
  } catch (_) {
    return res.status(401).json({
      success: false,
      message: securityMessage()
    });
  }
});

// ============================================================
// Device-bound identity (Android Keystore/StrongBox key pair, one per
// install — see DeviceIdentity.kt / SecureNetworkClient.kt client-side).
//
// The Android app no longer holds or uses MASTER_SECRET for any of this.
// register/challenge/verify need nothing but the device's own ECDSA key
// pair, generated on-device and never leaving secure hardware:
//   1) register  - hand the server this install's PUBLIC key. A public key
//                   is not a secret, so this needs no shared-secret gate —
//                   it is protected purely by strict rate limiting
//                   (deviceRegisterLimiter) and validation below. See the
//                   trust-on-first-use note further down for what this
//                   does and does not protect against.
//   2) challenge - get a single-use random nonce
//   3) verify    - prove possession of the matching PRIVATE key by
//                   signing that nonce; on success, issues a short-lived
//                   access token + refresh token.
//
// The only way to get a JWT at all now is to complete step 3, which is
// impossible without the private key that never left that specific
// device's secure hardware. There is no other route left in this file
// that mints a token.
// ============================================================

const DEVICE_KEYS_FILE = path.join(DATA_DIR, 'device-keys.json');
const DEVICE_CHALLENGE_TTL_MS = 2 * 60 * 1000; // single-use, 2 minutes

const deviceKeys = new Map();       // device_id -> base64 SPKI DER public key
const deviceChallenges = new Map(); // device_id -> Map(nonce -> expiresAt)  (several in flight at once)

function loadDeviceKeys() {
  try {
    if (!fs.existsSync(DEVICE_KEYS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DEVICE_KEYS_FILE, 'utf8'));
    for (const [id, key] of Object.entries(raw)) deviceKeys.set(id, key);
    console.log(`[DEVICE] loaded ${deviceKeys.size} registered device key(s).`);
  } catch (err) {
    console.warn('[DEVICE] could not read device key store, starting empty:', err.message);
  }
}

function saveDeviceKeys() {
  try {
    fs.writeFileSync(DEVICE_KEYS_FILE, JSON.stringify(Object.fromEntries(deviceKeys)), 'utf8');
  } catch (err) {
    console.warn('[DEVICE] could not persist device key store:', err.message);
  }
}

loadDeviceKeys();

app.post('/api/device/register', deviceRegisterLimiter, (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ success: false, message: securityMessage() });
  }

  const deviceId = String(req.body?.device_id || '').trim();
  const publicKeyB64 = String(req.body?.public_key || '').trim();

  if (
    !deviceId || deviceId.length > 128 || !/^[0-9a-fA-F]{16,128}$/.test(deviceId) ||
    !publicKeyB64 || publicKeyB64.length > 4096
  ) {
    return res.status(400).json({ success: false, message: securityMessage() });
  }

  // The submitted key must actually be a well-formed EC (P-256) public key.
  let keyObject;
  try {
    keyObject = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki'
    });
    if (keyObject.asymmetricKeyType !== 'ec') throw new Error('not an EC key');
  } catch (_) {
    return res.status(400).json({ success: false, message: securityMessage() });
  }

  const existing = deviceKeys.get(deviceId);

  // Trust-on-first-use: device_id is a 256-bit hash seeded by Android's per-app
  // ANDROID_ID, not something an attacker can predict for someone else's real
  // device, so "first registration wins" is safe for a brand-new id. A SECOND
  // registration for an id that already has a *different* key is either a
  // legitimate reinstall (Keystore data does not survive an uninstall, so a
  // real user's app regenerates a new key pair but keeps the same device_id)
  // or, far less likely, an attempted hijack of that id. Both look identical
  // from the server's side, so this is allowed but logged loudly and kept
  // under a strict, separate rate limit — an operator watching for a device_id
  // rotating repeatedly from different IPs has a real signal to act on; a
  // single one-off rotation is the ordinary reinstall case.
  if (existing && existing !== publicKeyB64) {
    console.warn(`[DEVICE] \u26a0 key rotation for already-registered device ${deviceId} (reinstall, or possible hijack attempt)`);
  } else {
    console.log(`[DEVICE] registered public key for device ${deviceId}`);
  }

  deviceKeys.set(deviceId, publicKeyB64);
  saveDeviceKeys();

  return res.json({ success: true });
});

app.get('/api/device/challenge', deviceAuthLimiter, (req, res) => {
  const deviceId = String(req.query.device_id || '').trim();
  if (!deviceId || deviceId.length > 128 || !deviceKeys.has(deviceId)) {
    return res.status(401).json({ success: false, message: securityMessage() });
  }

  const nonce = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  let pending = deviceChallenges.get(deviceId);
  if (!pending) { pending = new Map(); deviceChallenges.set(deviceId, pending); }
  // The app can start several token bootstraps at once. A single slot per device made
  // the newest challenge overwrite the others, so most of them failed verification.
  for (const [n, exp] of pending) if (exp < now) pending.delete(n);
  while (pending.size >= 10) pending.delete(pending.keys().next().value);
  pending.set(nonce, now + DEVICE_CHALLENGE_TTL_MS);
  return res.json({ success: true, nonce });
});

app.post('/api/device/verify', deviceAuthLimiter, (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ success: false, message: securityMessage() });
  }

  const deviceId = String(req.body?.device_id || '').trim();
  const nonce = String(req.body?.nonce || '').trim();
  const signatureB64 = String(req.body?.signature || '').trim();

  if (!deviceId || !nonce || !signatureB64 || deviceId.length > 128) {
    return res.status(401).json({ success: false, message: securityMessage() });
  }

  const publicKeyB64 = deviceKeys.get(deviceId);
  const pending = deviceChallenges.get(deviceId);
  const expiresAt = pending ? pending.get(nonce) : undefined;
  if (!publicKeyB64 || expiresAt === undefined || expiresAt < Date.now()) {
    return res.status(401).json({ success: false, message: securityMessage() });
  }

  // Single-use: this exact nonce never verifies again, whether this succeeds or not.
  pending.delete(nonce);
  if (pending.size === 0) deviceChallenges.delete(deviceId);

  try {
    const keyObject = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki'
    });
    const verified = crypto.verify(
      'sha256',
      Buffer.from(nonce, 'utf8'),
      keyObject,
      Buffer.from(signatureB64, 'base64')
    );
    if (!verified) return res.status(403).json({ success: false, message: securityMessage() });
  } catch (_) {
    return res.status(403).json({ success: false, message: securityMessage() });
  }

  return res.json({ success: true, ...issueTokens(deviceId) });
});

function authenticateToken(req, res, next) {
  const authHeader =
    req.headers['authorization'] || '';

  const parts = authHeader.split(/\s+/);

  const token =
    parts.length === 2 &&
    /^Bearer$/i.test(parts[0])
      ? parts[1]
      : null;

  const payload = verifyJwt(token);

  const deviceId = String(
    req.headers['x-device-id'] || ''
  ).trim();

  if (
    !payload ||
    payload.typ !== 'access' ||
    !deviceId ||
    payload.sub !== deviceId ||
    // Binds the session to an actual device registration, not just a matching
    // id string: a JWT can only ever have been minted (via /api/device/verify —
    // the only endpoint that issues one) for a device_id that was, at that
    // moment, a real registered ECDSA key. If that registration is ever
    // removed server-side, every outstanding token for it stops working here
    // immediately rather than staying valid until it naturally expires.
    !deviceKeys.has(deviceId)
  ) {
    return res.status(401).json({
      status: 'error',
      message: securityMessage()
    });
  }

  req.auth = payload;
  next();
}

// Public bootstrap/config/refresh. All normal API calls require a short-lived JWT.
app.use('/api', (req, res, next) => {
  if (
    req.path === '/refresh' ||
    req.path === '/device/register' ||
    req.path === '/device/challenge' ||
    req.path === '/device/verify'
  ) {
    return next();
  }

  return authenticateToken(req, res, next);
});

app.use('/api', apiLimiter);

// While the database is still loading (cold start) or failed to load, data routes
// used to answer 200 with EMPTY lists (queryAll returns [] when db is null), which the
// app showed as "no movies". Answer 503 instead so the app can show an error + retry.
app.use('/api', (req, res, next) => {
  if (db || req.path === '/config' || req.path === '/ads/config') return next();
  res.set('Retry-After', '5');
  return res.status(503).json({ status: 'error', message: 'Server is starting, please retry shortly' });
});

// ---------------------------------------------------------------------------
// Remote configuration (GitHub-hosted provider distribution)
// ---------------------------------------------------------------------------
//
// The Android app can fetch its provider scripts (Showbox.js, vixsrc.js, ...) directly from a
// GitHub repo and run them on-device, instead of only going through /api/stream. It needs the
// full set of *_url fields below (see Constants.applyRemoteConfig() in the app). All of them are
// built from the same repo coordinates:
//
// GITHUB_RAW_BASE=https://raw.githubusercontent.com/
// GITHUB_USER=hhhhhhhh798
// GITHUB_REPO=stream-master-config
// GITHUB_BRANCH=main
//
// ...plus one path per file, each defaulting to the path the app itself falls back to when the
// field is missing, so leaving any of these unset in .env still produces a working URL as long as
// that file exists at the default path in GITHUB_REPO:
//
// GITHUB_PROVIDER_JSON=github/provider.json
// GITHUB_CALLBACK_JSON=github/callback.json
// GITHUB_HOST_JSON=github/host.json
// GITHUB_CONFIG_JSON=github/config.json
// GITHUB_SUBS_JSON=github/subs.json
// GITHUB_PROVIDERS_DIR=github/providers/
// GITHUB_PROVIDER_SIGNATURES_JSON=github/provider-signatures.json
// GITHUB_UPDATE_JSON=github/update.json
//
function getGithubRoot() {
  const rawBase = String(process.env.GITHUB_RAW_BASE || '').trim();
  const githubUser = String(process.env.GITHUB_USER || '').trim();
  const githubRepo = String(process.env.GITHUB_REPO || '').trim();
  const githubBranch = String(process.env.GITHUB_BRANCH || '').trim();
  if (!rawBase || !githubUser || !githubRepo || !githubBranch) return '';
  return (
    rawBase.replace(/\/+$/, '') + '/' +
    encodeURIComponent(githubUser) + '/' +
    encodeURIComponent(githubRepo) + '/' +
    encodeURIComponent(githubBranch) + '/'
  );
}

/** [envVar] holds a path (or a whole overriding URL) relative to the repo above; [fallback] is the
 * path used when the app itself finds this field empty, kept identical to Constants.java so the
 * two agree even if this env var is left unset. */
function getGithubFileUrl(root, envVar, fallbackPath) {
  if (!root) return '';
  try {
    const raw = String(process.env[envVar] || fallbackPath).trim();
    if (/^https?:\/\//i.test(raw)) return raw;   // already a full URL override
    return root + raw.replace(/^\/+/, '');
  } catch (_) {
    return '';
  }
}

function getGithubUrls() {
  const root = getGithubRoot();
  return {
    base: root,
    provider: getGithubFileUrl(root, 'GITHUB_PROVIDER_JSON', 'github/provider.json'),
    callback: getGithubFileUrl(root, 'GITHUB_CALLBACK_JSON', 'github/callback.json'),
    host: getGithubFileUrl(root, 'GITHUB_HOST_JSON', 'github/host.json'),
    config: getGithubFileUrl(root, 'GITHUB_CONFIG_JSON', 'github/config.json'),
    subs: getGithubFileUrl(root, 'GITHUB_SUBS_JSON', 'github/subs.json'),
    providersDir: getGithubFileUrl(root, 'GITHUB_PROVIDERS_DIR', 'github/providers/'),
    signatures: getGithubFileUrl(root, 'GITHUB_PROVIDER_SIGNATURES_JSON', 'github/provider-signatures.json'),
    update: getGithubFileUrl(root, 'GITHUB_UPDATE_JSON', 'github/update.json')
  };
}

// Kept for anything still calling the old name.
function getGithubUpdateJsonUrl() { return getGithubUrls().update; }

app.get('/api/config', (req, res) => {
  const authHeader = String(
    req.headers['authorization'] || ''
  );

  const parts = authHeader.split(/\s+/);

  const accessToken =
    parts.length === 2 &&
    /^Bearer$/i.test(parts[0])
      ? parts[1]
      : '';

  if (!accessToken || !req.auth) {
    return res.status(401).json({
      success: false,
      message: securityMessage()
    });
  }

  const gh = getGithubUrls();

  const payload = JSON.stringify({
    version: 1,
    api_version: '16.0',
    min_app_version_code: 5,
    stream_session_ttl_sec:
      Math.floor(STREAM_SESSION_TTL_MS / 1000),

    // On-device provider system (Constants.applyRemoteConfig() in the app): the app downloads
    // these provider scripts from GitHub and runs them locally before falling back to /api/stream.
    github_base_url: gh.base,
    provider_json_url: gh.provider,
    callback_json_url: gh.callback,
    host_json_url: gh.host,
    config_json_url: gh.config,
    subs_json_url: gh.subs,
    providers_dir_url: gh.providersDir,
    provider_signatures_json_url: gh.signatures,

    // Android HomeFragment reads this value and uses it
    // to fetch UpdateInfo / latest_version_code.
    update_json_url: gh.update,

    generated_at: Date.now()
  });

  const signature = crypto
    .createHmac('sha256', accessToken)
    .update(payload)
    .digest('base64');

  return res.json({
    success: true,
    payload_b64: Buffer.from(
      payload,
      'utf8'
    ).toString('base64'),
    signature
  });
});

// ---------------------------------------------------------------------------
// Dynamic Unity LevelPlay advertising configuration.
// ---------------------------------------------------------------------------
//
// Required environment variables when ads are enabled:
//   APP_KEY
//   INTERSTITIAL_AD_UNIT_ID
//
// Optional:
//   ADS_ENABLED=true|false
//   ADS_INTERSTITIAL_COOLDOWN=90
//
app.get('/api/ads/config', (req, res) => {
  const adsRequested =
    String(
      process.env.ADS_ENABLED || 'true'
    ).toLowerCase() === 'true';

  const appKey = String(
    process.env.APP_KEY || ''
  ).trim();

  const interstitialAdUnitId = String(
    process.env.INTERSTITIAL_AD_UNIT_ID || ''
  ).trim();

  const cooldown = Math.max(
    15,
    Math.min(
      86400,
      Number.parseInt(
        process.env.ADS_INTERSTITIAL_COOLDOWN || '90',
        10
      ) || 90
    )
  );

  const credentialsValid =
    appKey.length >= 1 &&
    appKey.length <= 256 &&
    interstitialAdUnitId.length >= 1 &&
    interstitialAdUnitId.length <= 256;

  const config = {
    version: 1,
    ads_enabled:
      adsRequested && credentialsValid,
    app_key:
      credentialsValid ? appKey : '',
    interstitial_ad_unit_id:
      credentialsValid
        ? interstitialAdUnitId
        : '',
    interstitial_cooldown_sec:
      cooldown,
    generated_at: Date.now()
  };

  const payload = JSON.stringify(config);

  const authHeader = String(
    req.headers['authorization'] || ''
  );

  const parts = authHeader.split(/\s+/);

  const accessToken =
    parts.length === 2 &&
    /^Bearer$/i.test(parts[0])
      ? parts[1]
      : '';

  if (!accessToken || !req.auth) {
    return res.status(401).json({
      success: false,
      message: securityMessage()
    });
  }

  const signature = crypto
    .createHmac('sha256', accessToken)
    .update(payload)
    .digest('base64');

  res.set('Cache-Control', 'no-store');

  return res.json({
    success: true,
    payload_b64: Buffer.from(
      payload,
      'utf8'
    ).toString('base64'),
    signature
  });
});

// ---------------------------------------------------------------------------
// SubDL subtitle cache
// ---------------------------------------------------------------------------

const subtitleCache = new Map();
const SUBTITLE_CACHE_TTL_MS = 5 * 60 * 1000;

const LANGUAGE_ALIASES = {
  arabic: 'ar',
  ara: 'ar',
  english: 'en',
  eng: 'en',
  spanish: 'es',
  espanol: 'es',
  español: 'es',
  spa: 'es',
  french: 'fr',
  français: 'fr',
  francais: 'fr',
  fra: 'fr',
  fre: 'fr',
  german: 'de',
  deutsch: 'de',
  ger: 'de',
  deu: 'de',
  italian: 'it',
  italiano: 'it',
  ita: 'it',
  portuguese: 'pt',
  portugues: 'pt',
  português: 'pt',
  por: 'pt',
  russian: 'ru',
  rus: 'ru',
  turkish: 'tr',
  tur: 'tr',
  persian: 'fa',
  farsi: 'fa',
  per: 'fa',
  fas: 'fa',
  dutch: 'nl',
  nld: 'nl',
  japanese: 'ja',
  jpn: 'ja',
  korean: 'ko',
  kor: 'ko',
  chinese: 'zh',
  zho: 'zh',
  chi: 'zh',
  polish: 'pl',
  pol: 'pl',
  ukrainian: 'uk',
  ukr: 'uk',
  greek: 'el',
  ell: 'el',
  hebrew: 'he',
  heb: 'he',
  hindi: 'hi',
  hin: 'hi',
  indonesian: 'id',
  ind: 'id',
  vietnamese: 'vi',
  vie: 'vi',
  thai: 'th',
  tha: 'th',
  swedish: 'sv',
  swe: 'sv',
  norwegian: 'no',
  nor: 'no',
  danish: 'da',
  dan: 'da',
  finnish: 'fi',
  fin: 'fi',
  czech: 'cs',
  ces: 'cs',
  dutch: 'nl',
  romanian: 'ro',
  ron: 'ro',
  hungarian: 'hu',
  hun: 'hu'
};

const LANGUAGE_LABELS = {
  ar: 'العربية',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  ru: 'Русский',
  tr: 'Türkçe',
  fa: 'فارسی',
  nl: 'Nederlands',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
  pl: 'Polski',
  uk: 'Українська',
  el: 'Ελληνικά',
  he: 'עברית',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  sv: 'Svenska',
  no: 'Norsk',
  da: 'Dansk',
  fi: 'Suomi',
  cs: 'Čeština',
  ro: 'Română',
  hu: 'Magyar'
};

function normalizeLanguage(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return 'und';
  }

  const raw = String(value)
    .trim()
    .toLowerCase();

  if (!raw) return 'und';

  if (LANGUAGE_ALIASES[raw]) {
    return LANGUAGE_ALIASES[raw];
  }

  const base = raw.split(/[-_]/)[0];

  if (LANGUAGE_ALIASES[base]) {
    return LANGUAGE_ALIASES[base];
  }

  if (/^[a-z]{2,3}$/.test(base)) {
    return base;
  }

  return base.slice(0, 8) || 'und';
}

function languageLabel(code, raw) {
  const normalized = normalizeLanguage(
    code || raw
  );

  if (LANGUAGE_LABELS[normalized]) {
    return LANGUAGE_LABELS[normalized];
  }

  if (raw && String(raw).trim()) {
    return String(raw).trim();
  }

  return normalized.toUpperCase();
}

function absoluteSubtitleUrl(rawUrl) {
  if (!rawUrl) return '';

  const raw = String(rawUrl).trim();

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (raw.startsWith('/subtitle/')) {
    return `https://dl.subdl.com${raw}`;
  }

  if (raw.startsWith('/')) {
    return `${SUBDL_API_BASE}${raw}`;
  }

  return raw;
}

function makeSubtitleItem(raw, inherited = {}) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const languageRaw =
    raw.language ||
    raw.lang ||
    inherited.language ||
    inherited.lang ||
    '';

  const language =
    normalizeLanguage(languageRaw);

  const url = absoluteSubtitleUrl(
    raw.url ||
      raw.download_url ||
      raw.downloadUrl ||
      inherited.url
  );

  if (!url) return null;

  const formatRaw =
    raw.format ||
    inherited.format ||
    '';

  const format =
    String(formatRaw)
      .toLowerCase()
      .replace(/^\./, '') ||
    (
      url.toLowerCase().includes('.vtt')
        ? 'vtt'
        : url.toLowerCase().includes('.ass')
          ? 'ass'
          : 'srt'
    );

  const releaseName =
    raw.release_name ||
    raw.releaseName ||
    inherited.release_name ||
    inherited.releaseName ||
    '';

  const label =
    raw.label ||
    languageLabel(language, languageRaw);

  return {
    language,
    label,
    release_name: releaseName,
    format,
    url,
    download_url: url,
    hi: Boolean(
      raw.hi ??
      inherited.hi ??
      false
    ),
    season:
      Number(
        raw.season ??
        inherited.season ??
        0
      ) || 0,
    episode:
      Number(
        raw.episode ??
        inherited.episode ??
        0
      ) || 0
  };
}

function normalizeSubDLResponse(payload) {
  const result = [];
  const seen = new Set();

  const add = item => {
    const sub = makeSubtitleItem(item);

    if (!sub) return;

    const key =
      `${sub.url}|${sub.language}|${sub.release_name}`
        .toLowerCase();

    if (seen.has(key)) return;

    seen.add(key);
    result.push(sub);
  };

  const subtitles =
    Array.isArray(payload?.subtitles)
      ? payload.subtitles
      : [];

  for (const subtitle of subtitles) {
    const unpackFiles =
      Array.isArray(subtitle?.unpack_files)
        ? subtitle.unpack_files
        : [];

    if (unpackFiles.length) {
      for (const file of unpackFiles) {
        add({
          ...file,
          url:
            file.url ||
            file.download_url,
          language:
            file.language ||
            subtitle.language ||
            subtitle.lang,
          release_name:
            file.release_name ||
            subtitle.release_name,
          format:
            file.format ||
            subtitle.format,
          season:
            file.season ??
            subtitle.season,
          episode:
            file.episode ??
            subtitle.episode
        });
      }
    } else {
      add(subtitle);
    }
  }

  if (Array.isArray(payload?.files)) {
    for (const file of payload.files) {
      add(file);
    }
  }

  result.sort((a, b) => {
    const order = [
      'ar',
      'en',
      'es',
      'fr'
    ];

    const ai = order.indexOf(a.language);
    const bi = order.indexOf(b.language);

    if (ai !== -1 || bi !== -1) {
      return (
        (ai === -1 ? 99 : ai) -
        (bi === -1 ? 99 : bi)
      );
    }

    return a.label.localeCompare(b.label);
  });

  return result;
}

function cacheGet(key) {
  const entry = subtitleCache.get(key);

  if (!entry) return null;

  if (entry.expires <= Date.now()) {
    subtitleCache.delete(key);
    return null;
  }

  return entry.value;
}

function cacheSet(key, value) {
  subtitleCache.set(key, {
    value,
    expires:
      Date.now() +
      SUBTITLE_CACHE_TTL_MS
  });

  if (subtitleCache.size > 500) {
    const firstKey =
      subtitleCache.keys().next().value;

    if (firstKey) {
      subtitleCache.delete(firstKey);
    }
  }
}

async function fetchSubDLSubtitles({
  tmdbId,
  type,
  season,
  episode
}) {
  const params = new URLSearchParams({
    tmdb_id: String(tmdbId),
    type,
    unpack: '1',
    subs_per_page: '30'
  });

  if (type === 'tv') {
    if (
      Number.isInteger(season) &&
      season > 0
    ) {
      params.set(
        'season',
        String(season)
      );
    }

    if (
      Number.isInteger(episode) &&
      episode > 0
    ) {
      params.set(
        'episode',
        String(episode)
      );
    }
  }

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(
      `${SUBDL_API_BASE}/api/v2/subtitles/search?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization:
            `Bearer ${SUBDL_API_KEY}`,
          'User-Agent':
            'StreamMaster/15 SubDL integration'
        },
        signal: controller.signal
      }
    );

    const text =
      await response.text();

    let payload = null;

    try {
      payload =
        text
          ? JSON.parse(text)
          : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errorMessage =
        payload?.error?.message ||
        payload?.error ||
        `SubDL HTTP ${response.status}`;

      const error = new Error(
        String(errorMessage)
      );

      error.status =
        response.status;

      throw error;
    }

    if (payload?.status === false) {
      throw new Error(
        String(
          payload.error ||
          'SubDL returned an error'
        )
      );
    }

    return normalizeSubDLResponse(
      payload || {}
    );
  } finally {
    clearTimeout(timeout);
  }
}

app.get(
  '/api/subtitles',
  subtitleLimiter,
  async (req, res) => {
    const tmdbId = String(
      req.query.tmdb_id ||
      req.query.tmdbId ||
      ''
    ).trim();

    const requestedType =
      String(
        req.query.type ||
        'movie'
      )
        .trim()
        .toLowerCase();

    const type =
      requestedType === 'tv' ||
      requestedType === 'series'
        ? 'tv'
        : 'movie';

    const seasonValue =
      Number.parseInt(
        req.query.season,
        10
      );

    const episodeValue =
      Number.parseInt(
        req.query.episode,
        10
      );

    const season =
      Number.isFinite(seasonValue) &&
      seasonValue > 0
        ? seasonValue
        : null;

    const episode =
      Number.isFinite(episodeValue) &&
      episodeValue > 0
        ? episodeValue
        : null;

    if (!/^\d{1,12}$/.test(tmdbId)) {
      return res.status(400).json({
        status: 'error',
        message:
          'Valid tmdb_id is required'
      });
    }

    const cacheKey =
      `${tmdbId}:${type}:${season || 0}:${episode || 0}`;

    const cached =
      cacheGet(cacheKey);

    if (cached) {
      return res.json({
        status: 'success',
        provider: 'subdl',
        cached: true,
        count: cached.length,
        subtitles: cached,
        data: cached
      });
    }

    try {
      const subtitles =
        await fetchSubDLSubtitles({
          tmdbId,
          type,
          season,
          episode
        });

      cacheSet(
        cacheKey,
        subtitles
      );

      return res.json({
        status: 'success',
        provider: 'subdl',
        cached: false,
        count: subtitles.length,
        subtitles,
        data: subtitles
      });
    } catch (error) {
      const upstreamStatus =
        Number.isInteger(error.status)
          ? error.status
          : 502;

      console.error(
        'SubDL subtitle search failed:',
        error.message
      );

      return res
        .status(
          upstreamStatus >= 400 &&
          upstreamStatus < 600
            ? upstreamStatus
            : 502
        )
        .json({
          status: 'error',
          provider: 'subdl',
          message:
            'Subtitle provider request failed',
          error: error.message
        });
    }
  }
);

// ---------------------------------------------------------------------------
// Trailers (YouTube Data API v3)
// ---------------------------------------------------------------------------
//
// GET /api/trailer?vid=<tmdb_id>[&type=movie|tv]
//   -> { status, key, url, data: { key, url, title, channel } }
//
// Environment variable: YOUTUBE_API_KEY  (optional - without it: 503)
//
// A YouTube search costs 100 quota units and the default daily quota is 10,000,
// so results are cached for a week (misses for 6 hours), identical concurrent
// lookups share one request, and a quota error pauses lookups for 30 minutes.
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const TRAILER_HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRAILER_MISS_TTL_MS = 6 * 60 * 60 * 1000;
const TRAILER_QUOTA_BACKOFF_MS = 30 * 60 * 1000;
const TRAILER_CACHE_MAX = 2000;

const trailerCache = new Map();     // "movie:123" -> { value: {key,title,channel} | null, expires }
const trailerInFlight = new Map();  // "movie:123" -> Promise
let trailerBackoffUntil = 0;

const trailerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.auth?.sub || req.ip),
  handler: abuseAwareHandler
});

const TRAILER_TITLE_RE = /trailer|teaser|tr[aá]iler|تريلر|إعلان|اعلان|برومو/i;

function trailerCacheGet(key) {
  const entry = trailerCache.get(key);

  if (!entry) return undefined;

  if (entry.expires <= Date.now()) {
    trailerCache.delete(key);
    return undefined;
  }

  return entry.value;
}

function trailerCacheSet(key, value) {
  trailerCache.set(key, {
    value,
    expires: Date.now() + (value ? TRAILER_HIT_TTL_MS : TRAILER_MISS_TTL_MS)
  });

  if (trailerCache.size > TRAILER_CACHE_MAX) {
    const oldest = trailerCache.keys().next().value;

    if (oldest) trailerCache.delete(oldest);
  }
}

// First non-live result whose title says it is a trailer / teaser. Never guess.
function pickTrailer(items) {
  for (const item of Array.isArray(items) ? items : []) {
    const key = item?.id?.videoId;
    const snippet = item?.snippet || {};

    if (
      typeof key !== 'string' ||
      !/^[A-Za-z0-9_-]{6,32}$/.test(key)
    ) {
      continue;
    }

    if (
      snippet.liveBroadcastContent &&
      snippet.liveBroadcastContent !== 'none'
    ) {
      continue;
    }

    if (!TRAILER_TITLE_RE.test(String(snippet.title || ''))) continue;

    return {
      key,
      title: String(snippet.title || ''),
      channel: String(snippet.channelTitle || '')
    };
  }

  return null;
}

async function searchYoutubeTrailer(query, apiKey) {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '5',
    videoEmbeddable: 'true',
    safeSearch: 'none',
    q: query,
    key: apiKey
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${YOUTUBE_SEARCH_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    const text = await response.text();

    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const reason = payload?.error?.errors?.[0]?.reason || '';
      const error = new Error(String(payload?.error?.message || `YouTube HTTP ${response.status}`));

      error.status = response.status;
      error.quota = reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded';

      throw error;
    }

    return pickTrailer(payload?.items);
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/trailer', trailerLimiter, async (req, res) => {
  try {
    const id = String(req.query.vid || req.query.id || req.query.tmdb_id || '').trim();

    const rawType = String(req.query.type || 'movie').trim().toLowerCase();
    const type = (rawType === 'tv' || rawType === 'series') ? 'tv' : 'movie';

    if (!/^\d{1,12}$/.test(id)) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid vid is required'
      });
    }

    const apiKey = getYoutubeApiKey();

    if (!apiKey) {
      return res.status(503).json({
        status: 'error',
        message: 'Trailer service is not configured'
      });
    }

    res.set('Cache-Control', 'private, max-age=3600');

    const cacheKey = `${type}:${id}`;
    const respond = (trailer) => {
      if (!trailer) {
        return res.status(404).json({
          status: 'error',
          message: 'Trailer not available'
        });
      }

      const url = `https://www.youtube.com/watch?v=${trailer.key}`;

      return res.json({
        status: 'success',
        key: trailer.key,
        url,
        data: {
          key: trailer.key,
          url,
          title: trailer.title,
          channel: trailer.channel
        }
      });
    };

    const cached = trailerCacheGet(cacheKey);

    if (cached !== undefined) return respond(cached);

    if (Date.now() < trailerBackoffUntil) {
      return res.status(503).json({
        status: 'error',
        message: 'Trailer service is temporarily unavailable'
      });
    }

    let search = trailerInFlight.get(cacheKey);

    if (!search) {
      // What are we searching for?  (English / original titles find trailers best.)
      const row =
        type === 'tv'
          ? findShow(id)
          : (
              queryGet('SELECT * FROM movies WHERE tmdb_id = ? LIMIT 1', [id]) ||
              queryGet('SELECT * FROM movies WHERE id = ? LIMIT 1', [id])
            );

      if (!row) {
        return res.status(404).json({
          status: 'error',
          message: type === 'tv' ? 'المسلسل غير موجود' : 'الفيلم غير موجود'
        });
      }

      const name =
        type === 'tv'
          ? (row.original_name || row.name_en || row.name_ar || '')
          : (row.original_title || row.title_en || row.title_ar || '');

      const year =
        row.year
          ? String(row.year)
          : String(row.first_air_date || row.release_date || '').slice(0, 4);

      const query = [
        String(name).trim(),
        year,
        type === 'tv' ? 'TV series' : '',
        'official trailer'
      ].filter(Boolean).join(' ');

      search = searchYoutubeTrailer(query, apiKey)
        .then((trailer) => {
          trailerCacheSet(cacheKey, trailer);
          return trailer;
        })
        .finally(() => trailerInFlight.delete(cacheKey));

      trailerInFlight.set(cacheKey, search);
    }

    return respond(await search);
  } catch (error) {
    if (error && error.quota) {
      trailerBackoffUntil = Date.now() + TRAILER_QUOTA_BACKOFF_MS;
    }

    // Never log the request URL: it contains the API key.
    console.error(
      '[TRAILER] lookup failed:',
      error && error.status ? `HTTP ${error.status}` : '',
      error && error.message ? error.message : error
    );

    return res.status(error && error.quota ? 503 : 502).json({
      status: 'error',
      message: 'Trailer lookup failed'
    });
  }
});

// ---------------------------------------------------------------------------
// Data endpoints
// ---------------------------------------------------------------------------

app.get(
  ['/api/banner', '/api/slider'],
  (req, res) => {
    const page = Math.max(
      1,
      parseInt(req.query.page) || 1
    );

    const limit = Math.max(
      1,
      Math.min(
        50,
        parseInt(req.query.limit) || 10
      )
    );

    const lang =
      (req.query.lang || "ar")
        .toLowerCase();

    const offset =
      (page - 1) * limit;

    const rows = queryAll(
      "SELECT * FROM movies GROUP BY COALESCE(NULLIF(tmdb_id, ''), id) ORDER BY rating DESC, id DESC LIMIT ? OFFSET ?",
      [limit, offset]
    );

    const results =
      rows.map(r =>
        formatMovie(r, lang)
      );

    const countRow =
      queryGet(
        "SELECT COUNT(DISTINCT COALESCE(NULLIF(tmdb_id, ''), id)) as total FROM movies"
      );

    res.json({
      status: "success",
      page,
      limit,
      total:
        countRow
          ? countRow.total
          : 0,
      results,
      data: results
    });
  }
);

app.get('/api/home', (req, res) => {
  const lang =
    (req.query.lang || "ar")
      .toLowerCase();

  const limitPerSection =
    Math.max(
      1,
      Math.min(
        50,
        parseInt(req.query.limit) || 15
      )
    );

  const categories = [
    'trending',
    'latest',
    'action',
    'drama',
    'crime',
    'animation',
    'comedy',
    'horror',
    'scifi'
  ];

  const homeData = {};
  const globalSeenTmdbIds =
    new Set();

  for (const cat of categories) {
    const excludeArray =
      Array.from(
        globalSeenTmdbIds
      );

    const placeholders =
      excludeArray.length
        ? excludeArray
            .map(() => '?')
            .join(',')
        : "'0'";

    let sql;
    let params;

    if (cat === 'trending') {
      sql = `
        SELECT * FROM movies
        WHERE COALESCE(NULLIF(tmdb_id, ''), id)
        NOT IN (${placeholders})
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY vote_count DESC, rating DESC
        LIMIT ?
      `;

      params =
        excludeArray.length
          ? [
              ...excludeArray,
              limitPerSection
            ]
          : [
              limitPerSection
            ];
    } else if (cat === 'latest') {
      sql = `
        SELECT * FROM movies
        WHERE COALESCE(NULLIF(tmdb_id, ''), id)
        NOT IN (${placeholders})
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY id DESC
        LIMIT ?
      `;

      params =
        excludeArray.length
          ? [
              ...excludeArray,
              limitPerSection
            ]
          : [
              limitPerSection
            ];
    } else {
      const likePattern =
        `%${cat}%`;

      sql = `
        SELECT * FROM movies
        WHERE (
          LOWER(genre_ar) LIKE ?
          OR LOWER(genre_en) LIKE ?
          OR LOWER(genre_es) LIKE ?
        )
        AND COALESCE(NULLIF(tmdb_id, ''), id)
        NOT IN (${placeholders})
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY id DESC
        LIMIT ?
      `;

      params =
        excludeArray.length
          ? [
              likePattern,
              likePattern,
              likePattern,
              ...excludeArray,
              limitPerSection
            ]
          : [
              likePattern,
              likePattern,
              likePattern,
              limitPerSection
            ];
    }

    const rows =
      queryAll(sql, params);

    rows.forEach(r => {
      globalSeenTmdbIds.add(
        r.tmdb_id &&
        r.tmdb_id !== ''
          ? r.tmdb_id
          : String(r.id)
      );
    });

    homeData[cat] =
      rows.map(r =>
        formatMovie(r, lang)
      );
  }

  res.json({
    status: "success",
    data: homeData,
    sections: homeData
  });
});

app.get('/api/category', (req, res) => {
  const page = Math.max(
    1,
    parseInt(req.query.page) || 1
  );

  const limit = Math.max(
    1,
    Math.min(
      100,
      parseInt(req.query.limit) || 20
    )
  );

  const offset =
    (page - 1) * limit;

  const lang =
    (req.query.lang || "ar")
      .toLowerCase();

  const cat =
    (
      req.query.cat ||
      req.query.category ||
      ""
    )
      .trim()
      .toLowerCase();

  const excludeIds =
    (
      req.query.exclude || ""
    )
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);

  const hasExcludes =
    excludeIds.length > 0;

  const placeholders =
    hasExcludes
      ? excludeIds
          .map(() => '?')
          .join(',')
      : "'0'";

  let sql;
  let params;

  if (cat === 'trending') {
    sql = hasExcludes
      ? `
        SELECT * FROM movies
        WHERE id NOT IN (${placeholders})
        AND COALESCE(NULLIF(tmdb_id, ''), id)
        NOT IN (${placeholders})
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY vote_count DESC, rating DESC
        LIMIT ? OFFSET ?
      `
      : `
        SELECT * FROM movies
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY vote_count DESC, rating DESC
        LIMIT ? OFFSET ?
      `;

    params =
      hasExcludes
        ? [
            ...excludeIds,
            ...excludeIds,
            limit,
            offset
          ]
        : [
            limit,
            offset
          ];
  } else if (
    cat &&
    cat !== 'latest' &&
    cat !== 'all'
  ) {
    const likePattern =
      `%${cat}%`;

    sql = hasExcludes
      ? `
        SELECT * FROM movies
        WHERE (
          LOWER(genre_ar) LIKE ?
          OR LOWER(genre_en) LIKE ?
          OR LOWER(genre_es) LIKE ?
        )
        AND id NOT IN (${placeholders})
        AND COALESCE(NULLIF(tmdb_id, ''), id)
        NOT IN (${placeholders})
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `
      : `
        SELECT * FROM movies
        WHERE LOWER(genre_ar) LIKE ?
        OR LOWER(genre_en) LIKE ?
        OR LOWER(genre_es) LIKE ?
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `;

    params =
      hasExcludes
        ? [
            likePattern,
            likePattern,
            likePattern,
            ...excludeIds,
            ...excludeIds,
            limit,
            offset
          ]
        : [
            likePattern,
            likePattern,
            likePattern,
            limit,
            offset
          ];
  } else {
    sql = hasExcludes
      ? `
        SELECT * FROM movies
        WHERE id NOT IN (${placeholders})
        AND COALESCE(NULLIF(tmdb_id, ''), id)
        NOT IN (${placeholders})
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `
      : `
        SELECT * FROM movies
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `;

    params =
      hasExcludes
        ? [
            ...excludeIds,
            ...excludeIds,
            limit,
            offset
          ]
        : [
            limit,
            offset
          ];
  }

  const rows =
    queryAll(sql, params);

  const results =
    rows.map(r =>
      formatMovie(r, lang)
    );

  const countRow =
    queryGet(
      "SELECT COUNT(DISTINCT COALESCE(NULLIF(tmdb_id, ''), id)) as total FROM movies"
    );

  res.json({
    status: "success",
    page,
    results,
    data: results,
    total:
      countRow
        ? countRow.total
        : 0
  });
});

app.get(['/api/movie/:id', '/api/details/:id', '/api/detail'], (req, res) => {
  try {
    const id =
      req.params.id ||
      req.query.id ||
      req.query.vid ||
      req.query.tmdb_id;

    const lang =
      String(req.query.lang || "ar").toLowerCase();

    console.log('[DETAIL] request:', JSON.stringify({
      id: id || null,
      lang,
      path: req.path
    }));

    if (!id) {
      return res.status(400).json({
        status: "error",
        message: "معرّف الفيلم مطلوب"
      });
    }

    // The Android app sends TMDB id as `vid`. Keep the old database
    // structure and resolve the movie directly from the `movies` table.
    const movie = queryGet(
      `SELECT * FROM movies
       WHERE id = ? OR tmdb_id = ? OR slug = ?
       LIMIT 1`,
      [id, id, id]
    );

    if (!movie) {
      console.warn('[DETAIL] movie not found:', JSON.stringify({ id, lang }));
      return res.status(404).json({
        status: "error",
        message: "الفيلم غير موجود"
      });
    }

    console.log('[DETAIL] movie resolved:', JSON.stringify({
      id: movie.id ?? null,
      tmdb_id: movie.tmdb_id ?? null,
      has_cast_json: !!movie.cast_json,
      has_reviews_json: !!movie.reviews_json
    }));

    const formatted = formatMovie(movie, lang, true);
    const cast = getMovieCast(movie);
    const reviews = getMovieReviews(movie);

    console.log('[DETAIL] response data:', JSON.stringify({
      movie_id: movie.id ?? null,
      cast_count: cast.length,
      reviews_count: reviews.length,
      has_production_companies: !!movie.production_companies,
      has_production_countries: !!movie.production_countries
    }));

    return res.json({
      status: "success",
      data: {
        ...formatted,
        cast,
        reviews
      }
    });
  } catch (error) {
    console.error('[DETAIL ERROR] message:', error && error.message ? error.message : error);
    console.error('[DETAIL ERROR] stack:', error && error.stack ? error.stack : '(no stack)');

    return res.status(500).json({
      status: "error",
      message: "Internal server error"
    });
  }
});

app.get(['/api/movie/:id/cast', '/api/cast/:id', '/api/cast'], (req, res) => {
  try {
    const id =
      req.params.id ||
      req.query.vid ||
      req.query.id ||
      req.query.tmdb_id;

    if (!id) {
      return res.status(400).json({
        status: 'error',
        message: 'معرّف الفيلم مطلوب'
      });
    }

    const movie = queryGet(
      `SELECT * FROM movies
       WHERE id = ? OR tmdb_id = ? OR slug = ?
       LIMIT 1`,
      [id, id, id]
    );

    if (!movie) {
      return res.status(404).json({
        status: 'error',
        message: 'الفيلم غير موجود'
      });
    }

    const cast = getMovieCast(movie);

    return res.json({
      status: 'success',
      data: cast,
      cast
    });
  } catch (error) {
    console.error('Cast request failed:', error.message);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});

app.get(['/api/movie/:id/reviews', '/api/reviews/:id', '/api/reviews'], (req, res) => {
  try {
    const id =
      req.params.id ||
      req.query.vid ||
      req.query.id ||
      req.query.tmdb_id;

    if (!id) {
      return res.status(400).json({
        status: 'error',
        message: 'معرّف الفيلم مطلوب'
      });
    }

    const movie = queryGet(
      `SELECT * FROM movies
       WHERE id = ? OR tmdb_id = ? OR slug = ?
       LIMIT 1`,
      [id, id, id]
    );

    if (!movie) {
      return res.status(404).json({
        status: 'error',
        message: 'الفيلم غير موجود'
      });
    }

    const reviews = getMovieReviews(movie);

    return res.json({
      status: 'success',
      data: reviews,
      reviews
    });
  } catch (error) {
    console.error('Reviews request failed:', error.message);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});

app.get(
  [
    '/api/related',
    '/api/similar',
    '/api/recommendations',
    '/get_related'
  ],
  (req, res) => {
    const movieId =
      req.query.id ||
      req.query.vid ||
      req.query.movie_id;

    const limit = Math.max(
      1,
      Math.min(
        30,
        parseInt(req.query.limit) || 10
      )
    );

    const lang =
      (req.query.lang || "ar")
        .toLowerCase();

    let rows = [];

    if (movieId) {
      const targetMovie =
        queryGet(
          "SELECT * FROM movies WHERE id=? OR tmdb_id=? LIMIT 1",
          [movieId, movieId]
        );

      if (targetMovie) {
        const genre =
          targetMovie.genre_en ||
          targetMovie.genre_ar ||
          targetMovie.genre_es ||
          '';

        const firstGenre =
          genre
            ? genre
                .split(',')[0]
                .trim()
                .toLowerCase()
            : '';

        const targetTmdb =
          targetMovie.tmdb_id ||
          targetMovie.id;

        rows = firstGenre
          ? queryAll(
              `
              SELECT * FROM movies
              WHERE tmdb_id != ?
              AND id != ?
              AND (
                LOWER(genre_ar) LIKE ?
                OR LOWER(genre_en) LIKE ?
                OR LOWER(genre_es) LIKE ?
              )
              GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
              ORDER BY RANDOM()
              LIMIT ?
              `,
              [
                targetTmdb,
                targetMovie.id,
                `%${firstGenre}%`,
                `%${firstGenre}%`,
                `%${firstGenre}%`,
                limit
              ]
            )
          : queryAll(
              `
              SELECT * FROM movies
              WHERE tmdb_id != ?
              AND id != ?
              GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
              ORDER BY RANDOM()
              LIMIT ?
              `,
              [
                targetTmdb,
                targetMovie.id,
                limit
              ]
            );
      } else {
        rows =
          queryAll(
            `
            SELECT * FROM movies
            GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
            ORDER BY RANDOM()
            LIMIT ?
            `,
            [limit]
          );
      }
    } else {
      rows =
        queryAll(
          `
          SELECT * FROM movies
          GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
          ORDER BY RANDOM()
          LIMIT ?
          `,
          [limit]
        );
    }

    const results =
      rows.map(r =>
        formatMovie(r, lang)
      );

    res.json({
      status: "success",
      results,
      data: results
    });
  }
);

app.get('/api/search', (req, res) => {
  const query =
    (req.query.query || '')
      .trim();

  const page = Math.max(
    1,
    parseInt(req.query.page) || 1
  );

  const limit = Math.max(
    1,
    Math.min(
      100,
      parseInt(req.query.limit) || 20
    )
  );

  const offset =
    (page - 1) * limit;

  const lang =
    (req.query.lang || "ar")
      .toLowerCase();

  const likePattern =
    `%${query}%`;

  const rows = query
    ? queryAll(
        `
        SELECT * FROM movies
        WHERE title_ar LIKE ?
        OR title_en LIKE ?
        OR title_es LIKE ?
        OR original_title LIKE ?
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY id DESC
        LIMIT ? OFFSET ?
        `,
        [
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          limit,
          offset
        ]
      )
    : queryAll(
        `
        SELECT * FROM movies
        GROUP BY COALESCE(NULLIF(tmdb_id, ''), id)
        ORDER BY id DESC
        LIMIT ? OFFSET ?
        `,
        [
          limit,
          offset
        ]
      );

  const results =
    rows.map(r =>
      formatMovie(r, lang)
    );

  res.json({
    status: "success",
    page,
    results,
    data: results
  });
});

// ---------------------------------------------------------------------------
// TV series
// ---------------------------------------------------------------------------
//
// Tables: tv_shows (one row per series, keyed by tmdb_id) and episodes
// (show_tmdb_id + season_number + episode_number).
//
//   GET /api/series?lang=&page=&limit=[&cat=][&query=]   paged list
//   GET /api/series?vid=<tmdb_id>&lang=                  one series + seasons + episodes
//   GET /api/series/:id                                  same as above
//
// Playback of an episode goes through the existing endpoints:
//   GET /api/stream?vid=<series tmdb_id>&type=tv&s=<season>&e=<episode>
//   GET /api/subtitles?tmdb_id=<series tmdb_id>&type=tv&season=&episode=
//
// SERIES_REQUIRE_EPISODES=false lists series even when they have no episode rows yet.
const SERIES_REQUIRE_EPISODES =
  String(
    process.env.SERIES_REQUIRE_EPISODES || 'true'
  ).toLowerCase() !== 'false';

const SERIES_LIVE_SQL =
  "COALESCE(is_working, 1) = 1";

const SERIES_HAS_EPISODES_SQL =
  "EXISTS (SELECT 1 FROM episodes ep WHERE ep.show_tmdb_id = tv_shows.tmdb_id)";

function normalizeAppLang(value) {
  const lang =
    String(value || 'ar')
      .trim()
      .toLowerCase();

  return (
    lang === 'en' ||
    lang === 'es'
  )
    ? lang
    : 'ar';
}

// Like getLangField() but returns '' instead of "Untitled" when nothing is usable.
function pickLang(row, prefix, lang) {
  const order =
    lang === 'es'
      ? ['es', 'en', 'ar']
      : lang === 'en'
        ? ['en', 'ar', 'es']
        : ['ar', 'en', 'es'];

  for (const l of order) {
    const value = row[`${prefix}_${l}`];

    if (value === null || value === undefined) continue;

    const text = String(value).trim();

    if (
      text &&
      !['none', 'null', 'false'].includes(text.toLowerCase())
    ) {
      return text;
    }
  }

  return '';
}

function formatOneDecimal(value) {
  const n = Number(value);

  return Number.isFinite(n) && n > 0
    ? n.toFixed(1)
    : '';
}

function formatShow(s, lang = 'ar', includeDetails = false) {
  lang = normalizeAppLang(lang);

  const title =
    pickLang(s, 'name', lang) ||
    String(s.original_name || '').trim() ||
    'Untitled';

  const description = pickLang(s, 'overview', lang);
  const genre = pickLang(s, 'genre', lang);

  let posterVal =
    lang === 'en'
      ? (s.poster_en || s.poster)
      : lang === 'es'
        ? (s.poster_es || s.poster)
        : (s.poster_ar || s.poster);

  if (
    !posterVal ||
    ['none', 'null', '', 'false'].includes(
      String(posterVal).trim().toLowerCase()
    )
  ) {
    posterVal = s.backdrop || s.poster;
  }

  const image = fixImageUrl(posterVal, s.backdrop);

  const year =
    s.year
      ? String(s.year)
      : String(s.first_air_date || '').slice(0, 4);

  const formatted = {
    id: s.id,
    tmdb_id: s.tmdb_id,
    vid: String(s.tmdb_id),
    title,
    name: title,
    image,
    poster: image,
    cover: image,
    description,
    overview: description,
    // Empty (not a made-up default) when the show has no rating: the app hides the badge.
    rating: formatOneDecimal(s.rating),
    vote: Number(s.vote_count || 0),
    year,
    genre,
    season_count: Number(s.number_of_seasons || 0),
    episode_count: Number(s.number_of_episodes || 0),
    media_type: 'tv'
  };

  if (includeDetails) {
    formatted.genres =
      genre
        ? genre.split(',').map(v => v.trim()).filter(Boolean)
        : [];

    formatted.status = s.status || '';
    formatted.first_air_date = s.first_air_date || '';
    formatted.backdrop = s.backdrop || '';
    formatted.networks = parseJsonOrListField(s.networks);
    formatted.production_companies = parseJsonOrListField(s.production_companies);
    formatted.production_countries = parseJsonOrListField(s.production_countries);
    formatted.spoken_languages = parseJsonOrListField(s.spoken_languages);
  }

  return formatted;
}

function stillImageUrl(value) {
  if (value === null || value === undefined) return '';

  const raw = String(value).trim();

  if (
    !raw ||
    ['none', 'null', 'false'].includes(raw.toLowerCase())
  ) {
    return '';
  }

  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;

  return `https://image.tmdb.org/t/p/w500${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function formatEpisode(e, showTmdbId, lang) {
  const season = Number(e.season_number);
  const episode = Number(e.episode_number);
  const runtime = Number(e.runtime) > 0 ? Number(e.runtime) : 0;

  return {
    id: e.id,
    // Stable, unique key for this episode (the app uses it for resume-position storage).
    vid: `${showTmdbId}_s${season}e${episode}`,
    season,
    episode,
    title: pickLang(e, 'name', lang),
    description: pickLang(e, 'overview', lang),
    image: stillImageUrl(e.still_path),
    duration: runtime ? String(runtime) : '',
    runtime,
    air_date: e.air_date ? String(e.air_date) : '',
    rating: formatOneDecimal(e.rating),
    quality: e.quality ? String(e.quality) : ''
  };
}

// Rows must already be ordered by season_number, episode_number.
// Season 0 (TMDB "specials") and rows without valid numbers are left out.
function buildSeasons(rows, showTmdbId, lang) {
  const bySeason = new Map();

  for (const row of rows) {
    const season = Number(row.season_number);
    const episode = Number(row.episode_number);

    if (
      !Number.isInteger(season) || season < 1 ||
      !Number.isInteger(episode) || episode < 1
    ) {
      continue;
    }

    if (!bySeason.has(season)) {
      bySeason.set(season, {
        season,
        // The app writes "Season N" in the user's language.
        title: '',
        episode_count: 0,
        episodes: []
      });
    }

    const group = bySeason.get(season);

    group.episodes.push(formatEpisode(row, showTmdbId, lang));
    group.episode_count = group.episodes.length;
  }

  return Array.from(bySeason.values())
    .sort((a, b) => a.season - b.season);
}

function findShow(id) {
  // TMDB id first; the internal row id only as a fallback (they can collide).
  return (
    queryGet(
      `SELECT * FROM tv_shows WHERE tmdb_id = ? AND ${SERIES_LIVE_SQL} LIMIT 1`,
      [id]
    ) ||
    queryGet(
      `SELECT * FROM tv_shows WHERE id = ? AND ${SERIES_LIVE_SQL} LIMIT 1`,
      [id]
    )
  );
}

app.get(['/api/series', '/api/series/:id'], (req, res) => {
  try {
    const lang = normalizeAppLang(req.query.lang);

    const id =
      req.params.id ||
      req.query.vid ||
      req.query.id ||
      req.query.tmdb_id;

    // ---- one series with its seasons and episodes
    if (id) {
      if (!/^\d{1,12}$/.test(String(id).trim())) {
        return res.status(400).json({
          status: 'error',
          message: 'معرّف المسلسل غير صالح'
        });
      }

      const show = findShow(String(id).trim());

      if (!show) {
        return res.status(404).json({
          status: 'error',
          message: 'المسلسل غير موجود'
        });
      }

      const episodeRows = queryAll(
        `SELECT * FROM episodes
         WHERE show_tmdb_id = ?
         ORDER BY season_number ASC, episode_number ASC`,
        [show.tmdb_id]
      );

      const seasons = buildSeasons(episodeRows, show.tmdb_id, lang);

      return res.json({
        status: 'success',
        data: {
          ...formatShow(show, lang, true),
          cast: getMovieCast(show),
          seasons
        }
      });
    }

    // ---- paged list
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const cat =
      String(req.query.cat || req.query.category || '')
        .trim()
        .toLowerCase();

    const query = String(req.query.query || req.query.q || '').trim();

    const where = [SERIES_LIVE_SQL];
    const params = [];

    if (SERIES_REQUIRE_EPISODES) where.push(SERIES_HAS_EPISODES_SQL);

    if (query) {
      const like = `%${query}%`;

      where.push(
        '(name_ar LIKE ? OR name_en LIKE ? OR name_es LIKE ? OR original_name LIKE ?)'
      );

      params.push(like, like, like, like);
    }

    // `order` only ever takes one of these fixed strings (never user input).
    let order = 'id DESC';

    if (cat === 'trending') {
      order = 'vote_count DESC, rating DESC, id DESC';
    } else if (cat && cat !== 'latest' && cat !== 'all') {
      const like = `%${cat}%`;

      where.push(
        '(LOWER(genre_ar) LIKE ? OR LOWER(genre_en) LIKE ? OR LOWER(genre_es) LIKE ?)'
      );

      params.push(like, like, like);
    }

    const whereSql = where.join(' AND ');

    const rows = queryAll(
      `SELECT * FROM tv_shows WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const countRow = queryGet(
      `SELECT COUNT(*) AS total FROM tv_shows WHERE ${whereSql}`,
      params
    );

    const results = rows.map(r => formatShow(r, lang));

    return res.json({
      status: 'success',
      page,
      limit,
      total: countRow ? countRow.total : 0,
      results,
      data: results
    });
  } catch (error) {
    console.error('[SERIES ERROR] message:', error && error.message ? error.message : error);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});

app.get(
  '/api/stream/resolve',
  streamLimiter,
  (req, res) => {
    const ticket =
      String(
        req.query.ticket || ''
      ).trim();

    if (
      !ticket ||
      ticket.length < 32
    ) {
      return res.status(400).json({
        status: 'error',
        message:
          'جلسة البث غير صالحة'
      });
    }

    const session =
      streamSessions.get(ticket);

    if (
      !session ||
      session.expiresAt <= Date.now() ||
      session.deviceId !==
        String(req.auth.sub)
    ) {
      if (
        session &&
        session.expiresAt <= Date.now()
      ) {
        streamSessions.delete(
          ticket
        );
      }

      return res.status(401).json({
        status: 'error',
        message:
          'انتهت جلسة البث'
      });
    }

    // One-time resolution prevents a captured ticket from being reused.
    streamSessions.delete(ticket);

    const data =
      session.streamData;

    return res.json({
      status: 'success',
      stream_url:
        data.stream_url,
      streaming_url:
        data.stream_url,
      subtitle_url:
        data.subtitle_url,
      subtitles:
        data.subtitles,
      headers:
        data.headers,
      data: {
        stream_url:
          data.stream_url,
        subtitle_url:
          data.subtitle_url,
        subtitles:
          data.subtitles,
        headers:
          data.headers,
        duration:
          data.duration
      },
      message:
        'تم التحقق من جلسة البث'
    });
  }
);

app.get(
  [
    '/api/stream',
    '/api/stream/:movie_id'
  ],
  streamLimiter,
  async (req, res) => {
    try {
      const vid =
        req.params.movie_id ||
        req.query.vid ||
        req.query.query ||
        req.query.id;

      if (!vid) {
        return res.status(400).json({
          status: "error",
          message:
            "معرّف الفيلم مطلوب"
        });
      }

      const rawType =
        String(
          req.query.type ||
          'movie'
        )
          .trim()
          .toLowerCase();

      const type =
        rawType === 'tv' ||
        rawType === 'series'
          ? 'tv'
          : 'movie';

      let tmdbId;
      let season = null;
      let episode = null;

      if (type === 'tv') {
        // Series episode: vid = the series TMDB id, plus season + episode.
        // (`s` / `e` are the canonical names; `season` / `episode` are accepted too.)
        if (!/^\d{1,12}$/.test(String(vid))) {
          return res.status(400).json({
            status: "error",
            message:
              "معرّف المسلسل غير صالح"
          });
        }

        season =
          Number.parseInt(
            req.query.s ??
            req.query.season,
            10
          );

        episode =
          Number.parseInt(
            req.query.e ??
            req.query.episode,
            10
          );

        if (
          !Number.isInteger(season) ||
          season < 1 ||
          !Number.isInteger(episode) ||
          episode < 1
        ) {
          return res.status(400).json({
            status: "error",
            message:
              "رقم الموسم والحلقة مطلوبان"
          });
        }

        // Never look a series id up in `movies`: movie row ids and TMDB tv ids can collide.
        const show =
          queryGet(
            "SELECT tmdb_id FROM tv_shows WHERE tmdb_id = ? LIMIT 1",
            [vid]
          );

        tmdbId =
          show
            ? show.tmdb_id
            : vid;
      } else {
        const row =
          queryGet(
            `
            SELECT tmdb_id
            FROM movies
            WHERE id=?
            OR tmdb_id=?
            OR slug=?
            LIMIT 1
            `,
            [vid, vid, vid]
          );

        tmdbId =
          row
            ? row.tmdb_id
            : vid;

        season =
          req.query.s
            ? parseInt(req.query.s)
            : null;

        episode =
          req.query.e
            ? parseInt(req.query.e)
            : null;
      }

      let finalStreamData =
        null;

      const userCookie =
        getFebboxCookie();

      const movieInfo = {
        tmdb_id: tmdbId,
        type,
        season,
        episode
      };

      await wrapper.getResource(
        movieInfo,
        {},
        userCookie,
        (streamResult) => {
          finalStreamData =
            streamResult;
        }
      );

      if (
        !finalStreamData ||
        !finalStreamData.url
      ) {
        return res.status(404).json({
          status: "error",
          message:
            "فشل استخراج رابط البث من جميع المزودين"
        });
      }

      const streamUrl =
        finalStreamData.url;

      const headers =
        finalStreamData.headers || {
          "Referer":
            "https://vixsrc.to/",
          "User-Agent":
            DEFAULT_USER_AGENT
        };

      const subtitles =
        finalStreamData.subtitles ||
        [];

      const firstSubtitleUrl =
        subtitles.length
          ? (
              subtitles[0].url ||
              subtitles[0].file
            )
          : null;

      const sessionData = {
        stream_url:
          streamUrl,
        subtitle_url:
          firstSubtitleUrl,
        subtitles,
        headers,
        duration:
          Number(
            finalStreamData.duration ||
            0
          )
      };

      const ticket =
        createStreamSession(
          req.auth.sub,
          sessionData
        );

      // The initial endpoint never returns the provider URL.
      // It returns only a short-lived, device-bound session ticket.
      // Media traffic still goes directly from the client to the provider.
      res.json({
        status: "success",
        stream_session:
          ticket,
        session_expires_in:
          Math.floor(
            STREAM_SESSION_TTL_MS /
              1000
          ),
        data: {},
        message:
          "تم إنشاء جلسة بث مؤقتة"
      });
    } catch (error) {
      console.error(
        'Stream request failed.'
      );

      res.status(500).json({
        status: "error",
        message:
          "Internal server error"
      });
    }
  }
);

// ---- Hooks used by start.js (local/VPS runner: realtime watch-party rooms) ---------------
// Vercel's serverless functions don't support long-lived WebSocket connections, so the rooms
// feature only runs when this app is served by start.js (Termux/VPS), never on Vercel itself.
// Same checks as authenticateToken, but for a WebSocket upgrade request (no Express res/next).
// Returns the authenticated device id, or null.
function authenticateUpgrade(req) {
  const parts = String(req.headers['authorization'] || '').split(/\s+/);
  const token = parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : null;
  const payload = verifyJwt(token);
  const deviceId = String(req.headers['x-device-id'] || '').trim();
  if (
    !payload ||
    payload.typ !== 'access' ||
    !deviceId ||
    payload.sub !== deviceId ||
    !deviceKeys.has(deviceId)
  ) {
    return null;
  }
  const bannedUntil = abuseBans.get(`d:${deviceId.slice(0, 128)}`);
  if (bannedUntil !== undefined && bannedUntil > Date.now()) return null;
  return deviceId;
}

app.authenticateToken = authenticateToken;
app.authenticateUpgrade = authenticateUpgrade;

module.exports = app;



