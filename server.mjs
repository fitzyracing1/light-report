#!/usr/bin/env node
// light-report — report CI lights from any source. lit = 0, dark = 1 (active-low).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { NAME_RE, toLight, toBit, newToken, hashToken, tokenMatches, view, badgeSvg } from './lib/lights.mjs';
import { openStore } from './lib/store.mjs';
import { readGitHubLight } from './lib/github.mjs';

export function createApp({
  dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH,
  ttlSeconds = Number(process.env.LIGHT_TTL_SECONDS ?? 86400),
  github = readGitHubLight,
} = {}) {
  const store = openStore(dataDir);
  const ttlMs = ttlSeconds * 1000;

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache, max-age=0', ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
  };

  async function readBody(req) {
    let s = '';
    for await (const c of req) { s += c; if (s.length > 16384) throw Object.assign(new Error('body too large'), { code: 413 }); }
    if (!s.trim()) return {};
    if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(s));
    try { return JSON.parse(s); } catch { throw Object.assign(new Error('body must be JSON'), { code: 400 }); }
  }

  function record(name, req, report) {
    const existing = store.get(name);
    const auth = req.headers.authorization || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.headers['x-light-token'];
    let token;
    if (existing) {
      if (!tokenMatches(given, existing.tokenHash)) return { code: 401, body: { error: 'write token missing or wrong for this light' } };
    } else {
      token = newToken();
    }
    const light = toLight(report);
    const rec = {
      tokenHash: existing ? existing.tokenHash : hashToken(token),
      light,
      source: String(report.source || 'unknown').slice(0, 100),
      detail: report.detail == null ? null : String(report.detail).slice(0, 500),
      reportedAt: new Date().toISOString(),
    };
    store.set(name, rec);
    const body = view(name, rec, ttlMs);
    if (token) body.token = token; // returned once, stored only as a hash
    return { code: token ? 201 : 200, body };
  }

  function board() {
    const rows = Object.keys(store.all()).sort().map((n) => view(n, store.get(n), ttlMs));
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const tr = rows.map((v) => `<tr class="${v.light}"><td class="lamp">${v.light === 'lit' ? '●' : '○'}</td><td><a href="/lights/${esc(v.name)}">${esc(v.name)}</a></td><td>${v.light}</td><td>${v.bit}</td><td>${esc(v.source)}</td><td>${esc(v.reportedAt)}${v.stale ? ' (stale)' : ''}</td></tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>light-report</title>
<style>body{font:15px system-ui,sans-serif;max-width:900px;margin:2em auto;padding:0 1em}table{border-collapse:collapse;width:100%}td,th{padding:.4em;border-bottom:1px solid #ddd;text-align:left}.lamp{font-size:1.4em}.lit .lamp{color:#f2b705}.dark .lamp{color:#333}</style></head>
<body><h1>light-report</h1><p>Each light is one bit: <b>lit</b> = 0, <b>dark</b> = 1. No report within ${ttlSeconds}s means dark.</p>
<table><tr><th></th><th>name</th><th>light</th><th>bit</th><th>source</th><th>reported</th></tr>${tr || '<tr><td colspan="6">No lights reported yet.</td></tr>'}</table>
<p><a href="https://github.com/fitzyracing1/light-report">github.com/fitzyracing1/light-report</a></p></body></html>`;
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET' && parts.length === 0) return send(res, 200, board(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, persistent: store.persistent(), ttlSeconds });
      if (req.method === 'GET' && url.pathname === '/lights') {
        return send(res, 200, Object.keys(store.all()).sort().map((n) => view(n, store.get(n), ttlMs)));
      }
      if (parts[0] !== 'lights' || parts.length < 2 || parts.length > 3) return send(res, 404, { error: 'not found' });
      const name = parts[1];
      if (!NAME_RE.test(name)) return send(res, 400, { error: 'light name: letters, digits, . _ - (max 100)' });
      const sub = parts[2];

      if (req.method === 'POST' && !sub) {
        const body = await readBody(req);
        if (body.exitCode === undefined && body.state === undefined) return send(res, 400, { error: 'send exitCode or state' });
        const r = record(name, req, body);
        return send(res, r.code, r.body);
      }
      if (req.method === 'POST' && sub === 'github') {
        const body = await readBody(req);
        let report;
        try { report = await github(String(body.repo || '')); } catch (e) { return send(res, 502, { error: `github: ${e.message}` }); }
        const r = record(name, req, report);
        return send(res, r.code, r.body);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const v = view(name, store.get(name), ttlMs);
        if (!sub) return send(res, 200, v);
        if (sub === 'LIGHT') return send(res, 200, v.light + '\n', 'text/plain; charset=utf-8');
        if (sub === 'badge.svg') return send(res, 200, badgeSvg(name, v.light), 'image/svg+xml');
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  createApp().listen(port, process.env.HOST || '0.0.0.0', () => console.log(`light-report on :${port}`));
}
