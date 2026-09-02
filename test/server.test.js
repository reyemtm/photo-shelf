import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function startShelf({ auth, dataDir } = {}) {
  const port = await freePort();
  const ownsDir = !dataDir;
  const dir = dataDir || mkdtempSync(path.join(tmpdir(), 'ps-test-'));
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dir,
  };
  if (auth) {
    env.AUTH_USERNAME = auth.user;
    env.AUTH_PASSWORD = auth.pass;
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], { env, cwd: ROOT });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  const base = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + stderr)), 8000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${stderr}`));
    });
  });
  return {
    base,
    dir,
    stderr: () => stderr,
    stop: () =>
      new Promise((resolve) => {
        const cleanup = () => {
          if (ownsDir) rmSync(dir, { recursive: true, force: true });
          resolve();
        };
        if (child.exitCode !== null) return cleanup();
        child.once('exit', cleanup);
        child.kill('SIGTERM');
      }),
  };
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ---- shared fixture: a real JPEG with EXIF camera data, served over http ----

let fixtureServer = null;
let fixtureUrl = '';

async function startFixture() {
  const jpeg = await sharp({
    create: { width: 320, height: 240, channels: 3, background: '#4488cc' },
  })
    .withMetadata({ exif: { IFD0: { Make: 'Nikon', Model: 'Z8' } } })
    .jpeg()
    .toBuffer();
  const port = await freePort();
  fixtureServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
    res.end(jpeg);
  });
  await new Promise((r) => fixtureServer.listen(port, '127.0.0.1', r));
  fixtureUrl = `http://127.0.0.1:${port}/photo.jpg`;
}

// ================= findings tests =================

test('GET /images/<malformed> returns 400 and does NOT crash the server', async () => {
  const s = await startShelf();
  try {
    const r = await fetch(s.base + '/images/%');
    assert.equal(r.status, 400);
    // server must still be alive afterwards
    const r2 = await fetch(s.base + '/api/photos');
    assert.equal(r2.status, 200);
  } finally {
    await s.stop();
  }
});

test('DELETE /api/photos/<malformed> returns 400 and does NOT crash the server', async () => {
  const s = await startShelf();
  try {
    const r = await fetch(s.base + '/api/photos/%', { method: 'DELETE' });
    assert.equal(r.status, 400);
    const r2 = await fetch(s.base + '/api/photos');
    assert.equal(r2.status, 200);
  } finally {
    await s.stop();
  }
});

test('crash vector is also closed for authenticated users (auth on)', async () => {
  const s = await startShelf({ auth: { user: 'u', pass: 'p' } });
  try {
    const r = await fetch(s.base + '/images/%', { headers: { Authorization: basicAuth('u', 'p') } });
    assert.equal(r.status, 400);
    const r2 = await fetch(s.base + '/api/photos', { headers: { Authorization: basicAuth('u', 'p') } });
    assert.equal(r2.status, 200);
  } finally {
    await s.stop();
  }
});

test('HEAD /api/photos returns 200 (compose healthcheck uses HEAD via wget --spider)', async () => {
  const s = await startShelf();
  try {
    const r = await fetch(s.base + '/api/photos', { method: 'HEAD' });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.equal(body, '');
  } finally {
    await s.stop();
  }
});

test('HEAD / returns 200 and no body', async () => {
  const s = await startShelf();
  try {
    const r = await fetch(s.base + '/', { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '');
  } finally {
    await s.stop();
  }
});

test('path traversal /images/../public/... is blocked with 403', async () => {
  const s = await startShelf();
  try {
    const r = await fetch(s.base + '/images/..%2Fpublic%2Findex.html');
    assert.equal(r.status, 403);
  } finally {
    await s.stop();
  }
});

test('corrupted photos.json -> 200 [] (no crash) AND an error is logged to stderr', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-test-'));
  writeFileSync(path.join(dir, 'photos.json'), '{invalid json', 'utf8');
  const s = await startShelf({ dataDir: dir });
  try {
    const r = await fetch(s.base + '/api/photos');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), []);
    assert.match(s.stderr(), /photos\.json/);
  } finally {
    await s.stop();
  }
});

test('basic auth: no creds 401 / wrong 401 / right 200 (regression)', async () => {
  const s = await startShelf({ auth: { user: 'u', pass: 'p' } });
  try {
    assert.equal((await fetch(s.base + '/api/photos')).status, 401);
    assert.equal((await fetch(s.base + '/api/photos', { headers: { Authorization: basicAuth('u', 'wrong') } })).status, 401);
    assert.equal((await fetch(s.base + '/api/photos', { headers: { Authorization: basicAuth('u', 'p') } })).status, 200);
  } finally {
    await s.stop();
  }
});

test('auth is OFF when env vars are unset (regression)', async () => {
  const s = await startShelf();
  try {
    assert.equal((await fetch(s.base + '/api/photos')).status, 200);
  } finally {
    await s.stop();
  }
});

test('end-to-end ingest: local JPEG URL -> download, EXIF camera, dims, original + thumb files', async () => {
  await startFixture();
  const s = await startShelf();
  try {
    const res = await fetch(s.base + '/api/photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: fixtureUrl, title: 'fixture' }),
    });
    assert.equal(res.status, 201);
    const entry = await res.json();
    assert.equal(entry.width, 320);
    assert.equal(entry.height, 240);
    // exifr resolves CameraModel from the Model tag ('Z8'); Make may not
    // round-trip through sharp's exif writer — assert on what it did resolve.
    assert.match(String(entry.exif.camera || ''), /z8|nikon/i);
    assert.ok(entry.file && entry.file.endsWith('.jpg'));
    assert.ok(entry.thumb && entry.thumb.endsWith('_thumb.webp'));
  } finally {
    await s.stop();
    fixtureServer?.close();
  }
});

test('served index.html no longer contains leftover placeholder cards', async () => {
  const s = await startShelf();
  try {
    const html = await (await fetch(s.base + '/')).text();
    assert.ok(!html.includes('placeholder A'), 'placeholder scaffold should be gone');
  } finally {
    await s.stop();
  }
});