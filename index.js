import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import exifr from 'exifr';
import sharp from 'sharp';

// Load a local .env if present (only for dev — deployments like Coolify
// inject real env vars directly). Must run before any env vars are read.
if (fs.existsSync(path.resolve('.env'))) {
  try {
    process.loadEnvFile(path.resolve('.env'));
  } catch { /* ignore malformed .env in dev */ }
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.resolve('public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
// Temp JSON store — SQLite later (per plan)
const PHOTOS_PATH = path.join(DATA_DIR, 'photos.json');
// Tombstones of deleted photos so scrapers never re-add them
const DELETED_PATH = path.join(DATA_DIR, 'deleted.json');

// Basic auth — enabled only when BOTH AUTH_USERNAME and AUTH_PASSWORD are set.
// Set them as env vars in Coolify; leave unset for open local dev.
const AUTH_USER = process.env.AUTH_USERNAME || '';
const AUTH_PASS = process.env.AUTH_PASSWORD || '';
const AUTH_ENABLED = Boolean(AUTH_USER && AUTH_PASS);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ---------- storage (temp JSON) ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // ENOENT = not created yet (normal); anything else = corruption, surface it
    if (err.code !== 'ENOENT') console.error('Corrupt store file:', file, '-', err.message);
    return [];
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const readPhotos = () => readJson(PHOTOS_PATH);
const writePhotos = (photos) => writeJson(PHOTOS_PATH, photos);
const readDeleted = () => readJson(DELETED_PATH);
const writeDeleted = (list) => writeJson(DELETED_PATH, list);

// ---------- thumbnails ----------

const THUMB_WIDTH = 640; // wide enough for a full shelf row; ~10-20x smaller than originals

// Generate a WebP grid thumbnail from the original bytes. The original file is
// never touched — the thumb is an extra <id>_thumb.webp next to it.
async function makeThumb(buf) {
  try {
    return await sharp(buf, { failOn: 'none' })
      .rotate() // bake in EXIF orientation
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
  } catch (err) {
    console.error('thumb generation failed:', err.message);
    return null;
  }
}

// ---------- helpers ----------

function sendJSON(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------- basic auth ----------

function unauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Basic realm="Photo Shelf"',
  });
  res.end(JSON.stringify({ error: 'Authentication required' }));
}

// Compare via hashes so timingSafeEqual sees fixed-length inputs
// (and lengths of the real secrets never leak through the comparison).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Decode a path segment safely — malformed percent-encoding must not crash the
// process (an uncaught URIError inside the async request handler kills the server).
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  return safeEqual(decoded.slice(0, idx), AUTH_USER) && safeEqual(decoded.slice(idx + 1), AUTH_PASS);
}

function sendFile(res, filePath, contentType = 'application/octet-stream') {
  // File can vanish between the caller's existsSync and here — never crash on it.
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return sendJSON(res, 404, { error: 'Not found' });
  }
  const isHtml = contentType.includes('text/html');
  const headers = {
    'Content-Type': contentType,
    'Content-Length': stats.size,
    'X-Content-Type-Options': 'nosniff',
  };
  // HTML must never be cached aggressively (a bad Content-Type would be locked
  // in for a year and cause download prompts); images/assets can be immutable.
  headers['Cache-Control'] = isHtml ? 'no-cache' : 'public, max-age=31536000, immutable';
  if (isHtml) headers['Content-Disposition'] = 'inline';
  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
}

function getMimeType(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_BYTES = 20 * 1024 * 1024; // 20MB image cap
const FETCH_TIMEOUT = 15000;
const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
const PAGE_ACCEPT = 'text/html,application/xhtml+xml,*/*;q=0.8';
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg|heic|heif)(\?|#|$)/i;

/** URL whose path looks like a direct image file. */
function looksLikeImageUrl(s) {
  try {
    return IMAGE_EXT_RE.test(new URL(s).pathname);
  } catch {
    return IMAGE_EXT_RE.test(s);
  }
}

/** Fetch with UA + timeout + a specific Accept. Returns the Response. */
async function fetchWithAccept(target, accept) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(target, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function urlFor(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

/**
 * Download up to MAX_BYTES from url, following redirects, with a timeout.
 * Throws on non-2xx or when the cap is exceeded.
 */
async function downloadBuffer(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error(`Image too large (${declared} bytes)`);

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) throw new Error('Image exceeds 20MB cap');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

/** Detect image type + extension from magic bytes (more reliable than Content-Type). */
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return { ext: 'gif', mime: 'image/gif' };
  if (
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) return { ext: 'webp', mime: 'image/webp' };
  const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).toLowerCase();
  if (head.includes('<svg') || head.includes('<?xml')) return { ext: 'svg', mime: 'image/svg+xml' };
  return null;
}

/** Parse image dimensions from the file header. */
function imageSize(buf, type) {
  try {
    if (type.ext === 'png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (type.ext === 'gif' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (type.ext === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const size = buf.readUInt16BE(i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        i += 2 + size;
      }
    }
    if (type.ext === 'webp' && buf.length >= 30) {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (fmt === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fmt === 'VP8L') {
        const v = buf.readUInt32LE(21);
        return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* ignore malformed headers */
  }
  return { width: 0, height: 0 };
}

/**
 * Extract EXIF metadata from a local image file.
 * Returns a plain object with selected fields or {} when nothing found.
 */
async function extractExif(filePath) {
  try {
    const tags = await exifr.parse(filePath);
    if (!tags) return {};
    const out = {};

    if (tags.Make) out.make = String(tags.Make);
    if (tags.Model) out.model = String(tags.Model);
    out.camera = tags.CameraModel ? String(tags.CameraModel) : out.model || '';
    if (out.camera && (!out.make || !out.model)) {
      out.camera = [out.make, out.model].filter(Boolean).join(' ') || out.camera;
    }

    if (tags.DateTimeOriginal) out.dateTime = tags.DateTimeOriginal.toISOString();
    else if (tags.CreateDate) out.dateTime = tags.CreateDate.toISOString();

    if (tags.GPSLatitude && tags.GPSLongitude) {
      out.gps = {
        lat: tags.GPSLatitude?.toDecimal?.() ?? null,
        lng: tags.GPSLongitude?.toDecimal?.() ?? null,
      };
    }

    if (tags.LensModel) out.lens = String(tags.LensModel);
    if (tags.FocalLength) out.focalLength = tags.FocalLength;
    if (tags.FNumber) out.fNumber = tags.FNumber;
    if (tags.ExposureTime) out.exposureTime = String(tags.ExposureTime);
    if (tags.ISO) out.iso = tags.ISO;
    if (tags.Flash) out.flash = String(tags.Flash);

    return out;
  } catch (err) {
    console.error('EXIF parse error for', filePath, err.message);
    return {};
  }
}

/**
 * Some "shared URL" wrappers point at the real image via a query param.
 * Reddit's /media?url=<encoded image> is the common case — it serves a
 * bot-challenge HTML page (not the image, no og:image) when fetched server-side,
 * so we unwrap the encoded image URL ourselves.
 */
function unwrapRedirectUrl(input) {
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\./, '');
    if ((host === 'reddit.com' || host.endsWith('.reddit.com')) && u.pathname.startsWith('/media')) {
      const inner = u.searchParams.get('url');
      if (inner && /^https?:\/\//i.test(inner)) return inner.trim();
    }
  } catch {
    /* invalid URL — leave as-is */
  }
  return input;
}

/**
 * Given an HTML page, find the actual image URL:
 * og:image (and variants) -> twitter:image -> link[rel=image_src] -> first <img src>.
 * Resolves relative URLs against the page URL and decodes HTML entities.
 */
function findImageUrl(pageUrl, html) {
  const candidates = [];

  const metaPatterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+property=["']og:image:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image[:src]*["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image[:src]*["']/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m) candidates.push(m[1]);
  }

  const src = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i) ||
              html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/i);
  if (src) candidates.push(src[1]);

  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img) candidates.push(img[1]);

  for (const raw of candidates) {
    try {
      const cleaned = raw.replace(/&amp;/g, '&').replace(/&#38;/g, '&');
      const abs = new URL(cleaned, pageUrl).href;
      if (/^https?:$/.test(new URL(abs).protocol)) return abs;
    } catch {
      /* skip malformed */
    }
  }
  return null;
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const method = req.method;
  // HEAD behaves like GET for routing purposes (Node strips the body for HEAD
  // responses, so sharing the GET handlers is safe). The compose healthcheck
  // relies on this — wget --spider sends HEAD.
  const asGet = method === 'HEAD' ? 'GET' : method;
  const { pathname } = urlFor(req);

  // Unauthenticated liveness probe for orchestrators (Coolify/compose health
  // checks can't send credentials) — must stay before the auth gate.
  if (asGet === 'GET' && pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true });
  }

  // Basic auth gate — every route (pages, API, images) is private
  if (AUTH_ENABLED && !isAuthorized(req)) {
    return unauthorized(res);
  }

  // GET /api/photos  -> gallery JSON (optional ?camera= filter)
  if (asGet === 'GET' && pathname === '/api/photos') {
    const camera = (urlFor(req).searchParams.get('camera') || '').trim();
    let photos = readPhotos();
    if (camera) {
      photos = photos.filter((p) => p.exif && String(p.exif.camera || '') === camera);
    }
    return sendJSON(res, 200, photos);
  }

  // GET /api/deleted -> tombstoned photo URLs (for scraper dedupe)
  if (asGet === 'GET' && pathname === '/api/deleted') {
    return sendJSON(res, 200, readDeleted());
  }

  // GET /api/cameras -> distinct camera models with counts
  if (asGet === 'GET' && pathname === '/api/cameras') {
    const counts = new Map();
    for (const p of readPhotos()) {
      const cam = p.exif && p.exif.camera ? String(p.exif.camera) : '';
      if (!cam) continue;
      counts.set(cam, (counts.get(cam) || 0) + 1);
    }
    const cameras = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([camera, count]) => ({ camera, count }));
    return sendJSON(res, 200, cameras);
  }

  // POST /api/photos -> save a new photo (fetch + download + EXIF)
  if (method === 'POST' && pathname === '/api/photos') {
    const contentType = (req.headers['content-type'] || '').toLowerCase();

    if (contentType.includes('application/json')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return sendJSON(res, 400, { error: 'Invalid JSON' });
        }
        await handleSave(res, payload);
      });
      return;
    }

    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const payload = {
          url: params.get('url') || params.get('share_url') || params.get('text') || '',
          title: params.get('title') || '',
        };
        await handleSave(res, payload);
      });
      return;
    }

    return sendJSON(res, 400, { error: 'Unsupported Content-Type. Send JSON or form data with a "url" field.' });
  }

  // DELETE /api/photos/:id -> remove photo entry + its image file
  if (method === 'DELETE' && pathname.startsWith('/api/photos/')) {
    const id = safeDecode(pathname.slice('/api/photos/'.length));
    if (id === null) return sendJSON(res, 400, { error: 'Bad request' });
    const photos = readPhotos();
    const idx = photos.findIndex((p) => p.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'Photo not found' });
    const [removed] = photos.splice(idx, 1);
    writePhotos(photos);
    // Tombstone so the scraper doesn't re-add it
    const deleted = readDeleted();
    deleted.push({
      id: removed.id,
      url: removed.url,
      source: removed.source || null,
      title: removed.title || '',
      deletedAt: new Date().toISOString(),
    });
    writeDeleted(deleted);
    if (removed.file) {
      const fp = path.join(IMAGES_DIR, removed.file);
      if (fp.startsWith(IMAGES_DIR) && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      }
    }
    if (removed.thumb) {
      const fp = path.join(IMAGES_DIR, removed.thumb);
      if (fp.startsWith(IMAGES_DIR) && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      }
    }
    return sendJSON(res, 200, { ok: true, id });
  }

  // GET /images/:file -> serve image
  if (asGet === 'GET' && pathname.startsWith('/images/')) {
    const file = safeDecode(pathname.slice('/images/'.length));
    if (file === null) return sendJSON(res, 400, { error: 'Bad request' });
    const filePath = path.join(IMAGES_DIR, file);
    if (!filePath.startsWith(IMAGES_DIR)) {
      return sendJSON(res, 403, { error: 'Forbidden' });
    }
    if (!fs.existsSync(filePath)) {
      return sendJSON(res, 404, { error: 'Image not found' });
    }
    return sendFile(res, filePath, getMimeType(file));
  }

  // fallback: static files from public/
  if (asGet === 'GET') {
    let file = pathname === '/' ? 'index.html' : pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const filePath = path.join(PUBLIC_DIR, file);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendJSON(res, 403, { error: 'Forbidden' });
    }
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return sendJSON(res, 404, { error: 'Not found' });
    }
    if (stats.isDirectory()) {
      const index = path.join(filePath, 'index.html');
      if (fs.existsSync(index)) {
        return sendFile(res, index, 'text/html; charset=utf-8');
      }
      return sendJSON(res, 404, { error: 'Not found' });
    }
    const type = getMimeType(filePath);
    return sendFile(res, filePath, type);
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
});

/**
 * POST /api/photos: save a shared URL.
 * Fetches the URL; if it's a page, finds the real image inside;
 * downloads the image bytes, detects type, extracts EXIF + dimensions,
 * writes the file to <DATA_DIR>/images/, and stores the photo, URL and EXIF
 * in the temp JSON store.
 */
async function handleSave(res, payload) {
  const url = (payload && payload.url) ? payload.url.trim() : '';
  if (!url) {
    return sendJSON(res, 400, { error: 'A "url" field is required.' });
  }

  try {
    // 0. Unwrap wrapper URLs (e.g. Reddit /media?url=<encoded image>)
    const target = unwrapRedirectUrl(url);

    // Decide whether to ask for an image up front: if the URL was unwrapped
    // or looks like a direct image file, request with an image-only Accept.
    // Some hosts (Reddit) answer with a challenge HTML page when text/html
    // is advertised and with the image when it isn't.
    const wantImage = target !== url || looksLikeImageUrl(target);

    // 1. Fetch the URL (follows redirects)
    let fetched = await fetchWithAccept(target, wantImage ? IMAGE_ACCEPT : PAGE_ACCEPT);
    if (!fetched.ok) throw new Error(`Fetch failed with HTTP ${fetched.status}`);

    let ctype = (fetched.headers.get('content-type') || '').toLowerCase();
    let imageUrl = fetched.url || target;

    // 1b. Retry once with image-only Accept if we expected an image but got HTML
    if (!ctype.includes('image/') && wantImage) {
      const retry = await fetchWithAccept(target, IMAGE_ACCEPT);
      if (retry.ok) {
        const c = (retry.headers.get('content-type') || '').toLowerCase();
        if (c.includes('image/')) {
          fetched = retry;
          ctype = c;
          imageUrl = retry.url || target;
        }
      }
    }

    // 2. If it's still a page, find the real image URL
    if (!ctype.includes('image/')) {
      const html = await fetched.text();
      const found = findImageUrl(imageUrl, html);
      if (!found) throw new Error('No image found on that page');
      imageUrl = found;
    }

    // 3. Download image bytes
    const buf = await downloadBuffer(imageUrl);

    // 4. Detect type from magic bytes
    const type = detectImageType(buf);
    if (!type) throw new Error('Downloaded content is not a supported image');

    // 5. Save file
    const id = crypto.randomUUID();
    const file = `${id}.${type.ext}`;
    fs.writeFileSync(path.join(IMAGES_DIR, file), buf);

    // 5b. Generate a WebP grid thumbnail (original stays untouched)
    const thumbBuf = await makeThumb(buf);
    let thumb = null;
    if (thumbBuf) {
      thumb = `${id}_thumb.webp`;
      fs.writeFileSync(path.join(IMAGES_DIR, thumb), thumbBuf);
    }

    // 6. EXIF + dimensions
    const filePath = path.join(IMAGES_DIR, file);
    const exif = await extractExif(filePath);
    const { width, height } = imageSize(buf, type);

    // 7. Store in temp JSON DB
    const photos = readPhotos();
    const entry = {
      id,
      url: imageUrl,
      file,
      thumb,
      title: (payload && payload.title) ? payload.title.trim() : '',
      width,
      height,
      exif,
      createdAt: new Date().toISOString(),
      source: url,
    };
    photos.push(entry);
    writePhotos(photos);

    sendJSON(res, 201, entry);
  } catch (err) {
    console.error('save error:', err.message);
    sendJSON(res, 502, { error: `Could not save photo: ${err.message}` });
  }
}

server.listen(PORT, () => {
  console.log(`Photo Shelf listening on http://localhost:${PORT}`);
  console.log(`  GET  /             -> index.html`);
  console.log(`  GET  /api/photos   -> gallery JSON (temp JSON store)`);
  console.log(`  POST /api/photos   -> save a photo URL (fetch + download + EXIF)`);
  console.log(`  DELETE /api/photos/:id`);
  console.log(`  GET  /images/:file -> serve image`);
  console.log(`  Store: ${PHOTOS_PATH}`);
  console.log(`  Images: ${IMAGES_DIR}`);
  console.log(AUTH_ENABLED
    ? '  Auth: basic auth ON (AUTH_USERNAME/AUTH_PASSWORD set)'
    : '  Auth: OFF (set AUTH_USERNAME + AUTH_PASSWORD to enable)');
});