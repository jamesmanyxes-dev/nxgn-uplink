// NXGN UPLINK — pairing hub server (zero dependencies, plain Node)
// Env:
//   SEYORI_PANEL_URL        panel base URL
//   SEYORI_PANEL_KEY        server-1 client API key
//   SEYORI_PANEL_SERVER     server-1 uuid
//   SEYORI_PANEL2_KEY / SEYORI_PANEL2_SERVER   (optional)
//   SEYORI_PANEL3_KEY / SEYORI_PANEL3_SERVER   (optional)
//   PORT                    listen port (Railway sets this)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const PANEL_URL = process.env.SEYORI_PANEL_URL || '';

const PANELS = [
  { id: 's1', label: 'SERVER 01', key: process.env.SEYORI_PANEL_KEY, serverId: process.env.SEYORI_PANEL_SERVER, max: 15 },
  { id: 's2', label: 'SERVER 02', key: process.env.SEYORI_PANEL2_KEY, serverId: process.env.SEYORI_PANEL2_SERVER, max: 15 },
  { id: 's3', label: 'SERVER 03', key: process.env.SEYORI_PANEL3_KEY, serverId: process.env.SEYORI_PANEL3_SERVER, max: 15 },
  { id: 's4', label: 'SERVER 04', key: process.env.SEYORI_PANEL4_KEY, serverId: process.env.SEYORI_PANEL4_SERVER, max: 15 },
  { id: 's5', label: 'SERVER 05', key: process.env.SEYORI_PANEL5_KEY, serverId: process.env.SEYORI_PANEL5_SERVER, max: 15 },
].filter((p) => p.key && p.serverId);

const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---- rate limit: 6 pair requests / 10 min / ip ----
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < 600000);
  if (h.length >= 6) return false;
  h.push(now); hits.set(ip, h);
  return true;
}

// ---- panel helpers ----
function panelJson(p, apiPath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = https_req(PANEL_URL + apiPath, { method: 'GET', headers: { Authorization: 'Bearer ' + p.key, Accept: 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { done(JSON.parse(b)); } catch { done(null); } });
    });
    req.on('error', () => done(null));
    setTimeout(() => { done(null); try { req.destroy(); } catch {} }, 9000);
    req.end();
  });
}
// the panel host flaps: single calls are ~1s but spikes to 8s+ are common, so
// one retry on a failed/null GET absorbs most jank (2026-10-23)
async function panelJsonRetry(p, apiPath) {
  const a = await panelJson(p, apiPath);
  if (a) return a;
  return panelJson(p, apiPath);
}
function https_req(url, opts, cb) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? require('http') : require('https');
  return lib.request(u, opts, cb);
}
function panelDownload(p, file) {
  return panelJson(p, '/api/client/servers/' + p.serverId + '/files/download?file=' + encodeURIComponent(file)).then((j) => {
    const url = j && j.attributes && j.attributes.url;
    if (!url) return null;
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const req = https_req(url, {}, (res) => {
        let b = ''; res.on('data', (c) => (b += c));
        res.on('end', () => done(res.statusCode === 200 ? b : null));
      });
      req.on('error', () => done(null));
      setTimeout(() => { done(null); try { req.destroy(); } catch {} }, 9000);
      req.end();
    });
  });
}
// ---- panel file write ----
// The node daemon currently returns HTTP 200 with an EMPTY (or error) body for
// uploads into subdirectories like /database and silently drops the file, so a
// status-code check is a false positive. Working path (verified 2026-10-23):
// upload to the server root, then PUT /files/rename the temp file into place,
// then read back and byte-compare before claiming success.
function rawUpload(url, name, content) {
  return new Promise((resolve) => {
    const boundary = '----nxgn' + Date.now();
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([pre, Buffer.from(content), post]);
    const req = https_req(url, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300)); });
    req.on('error', () => resolve(false));
    setTimeout(() => { resolve(false); try { req.destroy(); } catch {} }, 15000);
    req.write(body); req.end();
  });
}
async function panelRead(p, file) {
  const j = await panelJson(p, '/api/client/servers/' + p.serverId + '/files/download?file=' + encodeURIComponent(file));
  const url = j && j.attributes && j.attributes.url;
  if (!url) return null;
  return panelDownloadUrl(url);
}
function panelDownloadUrl(url) {
  return new Promise((resolve) => {
    const req = https_req(url, {}, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => resolve(res.statusCode === 200 ? b : null));
    });
    req.on('error', () => resolve(null));
    setTimeout(() => { resolve(null); try { req.destroy(); } catch {} }, 9000);
    req.end(); // never omit: without this the request is never sent and the fetch hangs to timeout
  });
}
async function panelRename(p, from, to) {
  const j = await panelJson2(p, '/api/client/servers/' + p.serverId + '/files/rename', 'PUT', { root: '/', files: [{ from, to }] });
  return !!j;
}
async function panelDelete(p, file) {
  await panelJson2(p, '/api/client/servers/' + p.serverId + '/files/delete', 'POST', { root: '/', files: [file] });
}
// small JSON writer for non-GET panel calls (rename/delete)
function panelJson2(p, apiPath, method, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const data = JSON.stringify(body || {});
    const req = https_req(PANEL_URL + apiPath, {
      method,
      headers: { Authorization: 'Bearer ' + p.key, Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => {
        // error bodies parse as JSON too — only 2xx counts as success
        if (res.statusCode < 200 || res.statusCode > 299) return done(null);
        try { done(JSON.parse(b)); } catch { done({}); }
      });
    });
    req.on('error', () => done(null));
    setTimeout(() => { done(null); try { req.destroy(); } catch {} }, 9000);
    req.write(data); req.end();
  });
}
async function panelWriteVerified(p, dir, name, content) {
  const tmp = '__uplink_tmp_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  // 1) upload to server root (the only directory where uploads currently land)
  const upUrl = await panelJson(p, '/api/client/servers/' + p.serverId + '/files/upload?directory=%2F').then((j) => j && j.attributes && j.attributes.url);
  if (!upUrl || !(await rawUpload(upUrl, tmp, content))) return { ok: false, why: 'upload-failed' };
  // 2) verify the temp copy actually exists with our bytes
  const back1 = await panelRead(p, '/' + tmp);
  if (back1 !== content) {
    panelDelete(p, tmp).catch(() => {});
    return { ok: false, why: 'upload-verify-failed' };
  }
  // 3) rename into the target directory (overwrites existing target)
  const target = (dir === '/' ? '' : dir) + '/' + name;
  if (!(await panelRename(p, tmp, target))) {
    // target may refuse overwrite: remove it and retry once
    await panelDelete(p, target.replace(/^\//, '')).catch(() => {});
    if (!(await panelRename(p, tmp, target))) {
      panelDelete(p, tmp).catch(() => {});
      return { ok: false, why: 'rename-failed' };
    }
  }
  // 4) verify the final file content
  const back2 = await panelRead(p, target);
  if (back2 !== content) return { ok: false, why: 'final-verify-failed' };
  return { ok: true };
}
async function panelState(p) {
  const [res, log, pend] = await Promise.all([
    panelJsonRetry(p, '/api/client/servers/' + p.serverId + '/resources'),
    panelDownloadCached(p, '/bootlog.txt', 3000),
    panelDownloadCached(p, '/database/dashpair.json', 3000),
  ]);
  const state = res && res.attributes && res.attributes.current_state;
  const memMb = Math.round(((res && res.attributes && res.attributes.resources && res.attributes.resources.memory_bytes) || 0) / 1048576);
  // this panel fork lingers in "starting" long after the process is live
  const online = state === 'running' || (state === 'starting' && memMb >= 30);
  // live session count from the boot log's last [MEM] line
  let sessions = -1;
  if (log) {
    const lines = log.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/\[MEM\].*?sessions=(\d+)/);
      if (m) { sessions = parseInt(m[1], 10); break; }
    }
  }
  if (sessions < 0) {
    const raw = await panelDownloadCached(p, '/sessions-state.json', 5000);
    if (raw) {
      try {
        const st = JSON.parse(raw);
        sessions = Object.keys(st.sessions || {}).length;
      } catch {}
    }
  }
  // pending web pair reserves a slot
  let pendingNum = '';
  try {
    const j = JSON.parse(pend || '{}');
    if (j.number && !j.code && Date.now() - (j.at || 0) < 300000) pendingNum = String(j.number);
  } catch {}
  return { online, sessions: Math.max(0, sessions), pendingNum };
}

// short-lived panel state cache: /api/pair and /api/servers reuse fresh state
// instead of re-probing every panel (saves ~3-8s on each pair request)
const stateCache = new Map(); // id -> { t, s }
async function panelStateCached(p) {
  const c = stateCache.get(p.id);
  if (c && Date.now() - c.t < 10000) return c.s;
  const s = await panelState(p);
  stateCache.set(p.id, { t: Date.now(), s });
  return s;
}
// download cache: stops the 700ms status poll from hammering the panel on every hit
const dlCache = new Map(); // key -> { t, v }
async function panelDownloadCached(p, file, ttl) {
  const key = p.id + '|' + file;
  const c = dlCache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  const v = await panelDownload(p, file);
  dlCache.set(key, { t: Date.now(), v });
  return v;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'application/json' });
  res.end(body);
}
function serveFile(res, f) {
  const ext = path.extname(f).toLowerCase();
  fs.readFile(f, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const immutable = ext === '.webm' || ext === '.woff2';
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=604800, immutable' : ext === '.mp4' ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (p === '/health') return send(res, 200, 'ok', 'text/plain');
    if (p === '/bg') return serveFile(res, path.join(PUB, 'bg.mp4'));
    if (p === '/api/servers' && req.method === 'GET') {
      const out = await Promise.all(PANELS.map(async (pn) => {
        const s = await panelStateCached(pn);
        return { id: pn.id, label: pn.label, online: s.online, sessions: s.sessions, max: pn.max, free: Math.max(0, pn.max - s.sessions - (s.pendingNum ? 1 : 0)) };
      }));
      return send(res, 200, JSON.stringify({ servers: out }));
    }
    if (p === '/api/pair' && req.method === 'POST') {
      const ip = ((req.headers['x-forwarded-for'] || '') + ',' + (req.socket.remoteAddress || '')).split(',')[0].trim();
      if (!allowed(ip)) return send(res, 429, JSON.stringify({ ok: false, error: 'Too many attempts. Wait a few minutes.' }));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        let num = '', want = 'auto';
        try { const b = JSON.parse(body); num = String(b.number || '').replace(/\D/g, ''); want = String(b.server || 'auto'); } catch {}
        if (num.length < 8 || num.length > 15 || num.startsWith('0')) return send(res, 400, JSON.stringify({ ok: false, error: 'Invalid number.' }));
        const states = new Map();
        await Promise.all(PANELS.map(async (pn) => states.set(pn.id, await panelStateCached(pn))));
        const ordered = [...PANELS].sort((a, b) => {
          const wa = a.id === want ? -1e9 : 0, wb = b.id === want ? -1e9 : 0;
          const sa = states.get(a.id), sb = states.get(b.id);
          const fa = sa.online ? a.max - sa.sessions - (sa.pendingNum && sa.pendingNum !== num ? 1 : 0) : -1e6;
          const fb = sb.online ? b.max - sb.sessions - (sb.pendingNum && sb.pendingNum !== num ? 1 : 0) : -1e6;
          return (wa + fa) - (wb + fb);
        });
        const failures = [];
        for (const pn of ordered) {
          const s = states.get(pn.id);
          const used = s.sessions + (s.pendingNum && s.pendingNum !== num ? 1 : 0);
          if (!s.online || used >= pn.max) continue;
          // host flaps mid-write too: one retry absorbs the common single-failure
          let w = await panelWriteVerified(pn, '/database', 'dashpair.json', JSON.stringify({ number: num, code: '', at: Date.now(), via: 'webpair' }));
          if (!w.ok) w = await panelWriteVerified(pn, '/database', 'dashpair.json', JSON.stringify({ number: num, code: '', at: Date.now(), via: 'webpair' }));
          if (w.ok) {
            const wanted = PANELS.find((x) => x.id === want);
            return send(res, 200, JSON.stringify({ ok: true, used: pn.label, usedId: pn.id, fallback: want !== 'auto' && want !== pn.id, requested: wanted ? wanted.label : undefined }));
          }
          failures.push(pn.id + ':' + w.why);
        }
        send(res, 503, JSON.stringify({ ok: false, error: 'All nodes are busy, offline, or rejected the pair write. Try again soon.', detail: failures }));
      });
      return;
    }
    if (p === '/api/pair/status' && req.method === 'GET') {
      const num = (u.searchParams.get('number') || '').replace(/\D/g, '');
      const sid = u.searchParams.get('server') || 's1';
      const pn = PANELS.find((x) => x.id === sid) || PANELS[0];
      let out = { status: 'pending' };
      if (num && pn) {
        const raw = await panelDownloadCached(pn, '/database/dashpair.json', 2000);
        if (raw) {
          try {
            const rec = JSON.parse(raw);
            if (String(rec.number || '').replace(/\D/g, '') === num) {
              if (rec.error) out = { status: 'error', error: String(rec.error) };
              else if (rec.code) out = { status: 'code', code: String(rec.code) };
            }
          } catch {}
        }
      }
      return send(res, 200, JSON.stringify(out));
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(PUB, 'index.html'));
    // static assets from public/
    if (req.method === 'GET' && !p.includes('..')) {
      const f = path.join(PUB, p.slice(1));
      if (f.startsWith(PUB) && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(res, f);
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    console.error('[nxgn] request failed', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal error');
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('[nxgn] uplink listening on :' + PORT));
