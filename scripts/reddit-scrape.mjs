#!/usr/bin/env node
/**
 * Reddit image-post scraper (Node 22+, zero deps).
 *
 * Why not the Reddit API directly? reddit.com / api.reddit.com / old.reddit.com
 * all serve a 403 bot-challenge wall to anonymous non-browser clients (verified
 * Sep 2026). The public pullpush.io mirror of submission metadata works, and the
 * i.redd.it / preview.redd.it image CDN serves images to normal fetches — so we
 * use those. If you have a Reddit app, the OAuth API (api.reddit.com with a
 * bearer token) is a drop-in replacement for fetchTop() and never sees 403s.
 *
 * Usage:
 *   node scripts/reddit-scrape.mjs --subreddit geospatial --limit 10
 *   node scripts/reddit-scrape.mjs --subreddit "geospatial,remotesensing" --limit 20 --min-score 10
 *   node scripts/reddit-scrape.mjs --subreddit geospatial --download out/reddit
 * Flags:
 *   --subreddit  comma-separated list (default: geospatial)
 *   --rss        use Reddit's RSS feeds instead of pullpush (works when the
 *               mirror rate-limits; feed order = top-of-all-time ranking, but
 *               no numeric scores). Primary source is pullpush.
 *   --limit      max posts to report (default: 25)
 *   --min-score  only posts with score >= N
 *   --download   dir to save the images into (named <score>_<postid>.<ext>)
 *   --post-to   Photo Shelf URL (e.g. http://localhost:5101/api/photos) to
 *               ingest each post via POST {url, title}
 *   --skip-existing <shelf origin>
 *               e.g. --skip-existing http://localhost:5101 — skip posts whose
 *               image URL already exists on the shelf (prevents duplicates)
 *
 * Config can also come from env vars (no secrets or identities in this file):
 *   PHOTO_SHELF_URL   shelf BASE URL — POSTs go to <base>/api/photos,
 *                     dedupe reads <base>/api/photos + <base>/api/deleted
 *   PHOTO_SHELF_AUTH  "user:pass" basic-auth creds for the shelf (--auth)
 *   SCRAPE_SUBREDDITS comma-separated default subreddits
 * This scraper uses no reddit account — it reads anonymous feeds. If OAuth is
 * added later, its username/credentials must also come from env, never code.
 *   --auth      basic-auth "user:pass" for the shelf endpoints above (only
 *               needed when the Photo Shelf server has AUTH_* enabled)
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Load a local .env if present (optional; env vars can be set directly)
if (existsSync('.env')) {
  try {
    process.loadEnvFile('.env');
  } catch { /* ignore */ }
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const IMAGE_HOST_RE = /(?:i\.redd\.it|preview\.redd\.it|i\.imgur\.com|i\.reddit\.it)/;
const NOT_IMAGE_RE = /\.gifv?$/i;

function flag(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(name);

const subreddits = flag('--subreddit', process.env.SCRAPE_SUBREDDITS || 'geospatial')
  .split(',').map((s) => s.trim()).filter(Boolean);
const limit = Number(flag('--limit', '25'));
if (!Number.isFinite(limit) || limit < 0) {
  console.error('--limit must be a non-negative number');
  process.exit(1);
}
const minScore = Number(flag('--min-score', '0')) || 0;
const downloadDir = flag('--download', '') || '';
// Shelf config can come from env: PHOTO_SHELF_URL is the base URL
// (the script appends /api/photos for POSTs and /api/photos + /api/deleted
// for dedupe). Explicit --post-to / --skip-existing flags win over env.
const shelfEnv = (process.env.PHOTO_SHELF_URL || '').replace(/\/+$/, '');
const postTo = flag('--post-to', shelfEnv ? shelfEnv + '/api/photos' : '') || '';
const skipOrigin = flag('--skip-existing', shelfEnv) || '';
const rssMode = has('--rss');
const authCreds = flag('--auth', process.env.PHOTO_SHELF_AUTH || '') || '';
const authHeaders = authCreds
  ? { Authorization: 'Basic ' + Buffer.from(authCreds, 'utf8').toString('base64') }
  : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch top posts via Reddit's anonymous Atom feed (no numeric scores). */
async function fetchTopRss(sub) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top/.rss?t=all&limit=25`;
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/atom+xml' },
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) break;
    if (res.status === 429) {
      process.stderr.write(`  reddit rate-limited (429), waiting 12s…\n`);
      await sleep(12000);
      continue;
    }
    throw new Error(`RSS HTTP ${res.status} for r/${sub}`);
  }
  // Exhausted retries with no success — fail loudly instead of parsing an error page
  if (!res?.ok) throw new Error(`RSS kept failing for r/${sub} (last HTTP ${res?.status})`);
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  const out = [];
  entries.forEach((m, i) => {
    const body = m[1];
    const title = (body.match(/<title>([\s\S]*?)<\/title>/) || [null, ''])[1]
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').trim();
    const mid = (body.match(/<id>([^<]+)<\/id>/) || [null, ''])[1];
    const id = (mid.match(/comments\/([a-z0-9]+)/i) || [null, String(i)])[1];
    const media = (body.match(/media:thumbnail url="([^"]+)"/) || [])[1];
    if (!media) return;
    const img = media.replace(/&amp;/g, '&');
    if (!/(preview\.redd\.it|i\.redd\.it)/.test(img)) return;
    out.push({ id, title, url: img, score: 100000 - i }); // feed order preserved
  });
  return out;
}

/** Fetch one page of top posts for a subreddit, retrying once on 429. */
async function fetchTopPosts(sub) {
  const url =
    'https://api.pullpush.io/reddit/search/submission/' +
    `?subreddit=${encodeURIComponent(sub)}&size=100&sort_type=score&sort=desc`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(45000),
    });
    if (res.ok) return (await res.json()).data || [];
    if (res.status === 429) {
      process.stderr.write(`  rate-limited (429) on r/${sub}, waiting 8s…\n`);
      await sleep(8000);
      continue;
    }
    throw new Error(`pullpush HTTP ${res.status} for r/${sub}`);
  }
  throw new Error(`pullpush kept rate-limiting r/${sub}`);
}

function isImagePost(p) {
  if (!p || !p.url || p.is_self) return false;
  if (NOT_IMAGE_RE.test(p.url)) return false;
  // hosted image (i.redd.it / preview.redd.it / i.imgur.com) or a post that
  // Reddit flagged as an image/gallery link
  if (IMAGE_HOST_RE.test(p.url)) return true;
  return /image|gallery/.test(p.post_hint || '');
}

async function main() {
  const posts = [];
  for (const sub of subreddits) {
    process.stderr.write(`Fetching r/${sub} top posts (${rssMode ? 'rss' : 'pullpush'})…\n`);
    const data = rssMode ? await fetchTopRss(sub) : await fetchTopPosts(sub);
    const hit = rssMode ? data : data.filter(isImagePost);
    process.stderr.write(`  ${hit.length} image posts\n`);
    posts.push(...hit);
    if (subreddits.length > 1) await sleep(rssMode ? 10000 : 3000);
  }

  /** Keys that identify an image URL for dedupe: exact, path, reddit-media basename. */
  function urlKeys(u) {
    const keys = new Set([u]);
    try {
      const x = new URL(u);
      const bare = x.pathname.replace(/^\//, '');
      keys.add(x.origin + x.pathname);
      keys.add(bare);
      // same media file across i.redd.it / preview.redd.it / external-preview.redd.it
      if (/\.redd\.it$/.test(x.hostname)) {
        const base = x.pathname.split('/').pop();
        if (base) keys.add('reddit:' + base);
      }
      if (x.hostname === 'i.imgur.com') {
        keys.add('imgur:' + bare.replace(/\?.*$/, ''));
      }
    } catch { /* ignore */ }
    return keys;
  }

  // Load URLs already on the shelf AND deleted tombstones for dedupe
  const existing = new Set();
  if (skipOrigin) {
    try {
      for (const ep of ['/api/photos', '/api/deleted']) {
        const res = await fetch(skipOrigin + ep, { headers: authHeaders, signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const list = await res.json();
        for (const p of list) {
          if (!p.url) continue;
          for (const k of urlKeys(p.url)) existing.add(k);
        }
      }
      process.stderr.write(`Dedupe set ready (photos + deleted tombstones)\n`);
    } catch (e) {
      process.stderr.write(`Could not fetch existing photos (${e.message}); proceeding without dedupe\n`);
    }
  }

  // Rank by score (dedupe by post id AND against shelf/deleted) before slicing
  const seen = new Set();
  const ranked = posts
    .filter((p) => p.score >= minScore)
    .filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      if (!existing.size) return true;
      for (const k of urlKeys(p.url)) {
        if (existing.has(k)) return false;
      }
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const fresh = ranked;
  if (!fresh.length) {
    console.log('Nothing new to add — ranked posts already exist on the shelf.');
    return;
  }

  console.log(`\nTop ${fresh.length} image posts by score:`);
  for (const p of fresh) {
    console.log(`  ${String(p.score).padStart(5)}  ${p.title || '(untitled)'}`);
    console.log(`          ${p.url}`);
  }

  if (postTo) {
    for (const p of fresh) {
      try {
        const res = await fetch(postTo, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ url: p.url, title: p.title || '' }),
          signal: AbortSignal.timeout(60000),
        });
        const body = await res.json().catch(() => ({}));
        process.stderr.write(`  ${res.ok ? 'POSTED' : 'FAILED'} ${p.score} ${p.url}${body.error ? ' — ' + body.error : ''}\n`);
      } catch (e) {
        process.stderr.write(`  FAILED ${p.url}: ${e.message}\n`);
      }
      await sleep(500);
    }
  }

  if (downloadDir) {
    mkdirSync(downloadDir, { recursive: true });
    let ok = 0;
    for (const p of fresh) {
      const ext = path.extname(new URL(p.url).pathname) || '.jpg';
      const file = path.join(downloadDir, `${p.score}_${p.id}${ext}`);
      if (existsSync(file)) { ok++; continue; }
      try {
        const res = await fetch(p.url, {
          headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(file, buf);
        process.stderr.write(`  saved ${file} (${buf.length} bytes)\n`);
        ok++;
      } catch (e) {
        process.stderr.write(`  FAILED ${p.url}: ${e.message}\n`);
      }
      await sleep(400);
    }
    console.log(`Downloaded ${ok}/${fresh.length} images to ${downloadDir}`);
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
