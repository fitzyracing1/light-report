#!/usr/bin/env node
// light-report — report CI lights from any source. lit = 0, dark = 1 (active-low).
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { NAME_RE, toLight, toBit, newToken, hashToken, tokenMatches, view, badgeSvg } from './lib/lights.mjs';
import { openStore } from './lib/store.mjs';
import { readGitHubLight } from './lib/github.mjs';
import { createRunner } from './lib/runner.mjs';
import { siteHtml } from './lib/site.mjs';

export function createApp({
  dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH,
  ttlSeconds = Number(process.env.LIGHT_TTL_SECONDS ?? 86400),
  github = readGitHubLight,
  runnerOptions = {},
  runsPerHour = Number(process.env.RUNS_PER_IP_PER_HOUR ?? 6),
} = {}) {
  const store = openStore(dataDir);
  const ttlMs = ttlSeconds * 1000;

  // Runner results become lights named owner--repo, source 'light-report-runner'.
  // An existing light keeps its write token hash; a runner-created light has none (only the runner writes it).
  const runner = createRunner({
    ...runnerOptions,
    onResult(run) {
      const name = run.lightName;
      const existing = store.get(name);
      store.set(name, {
        tokenHash: existing?.tokenHash ?? null,
        light: run.light,
        source: run.upload ? 'light-report-runner (upload)' : 'light-report-runner',
        detail: `run ${run.id}: ${run.command || run.error || ''} → exit ${run.exitCode}${run.timedOut ? ' (timeout)' : ''}`.slice(0, 500),
        reportedAt: run.finishedAt,
      });
    },
  });

  // per-IP rate limit for POST /runs (sliding hour)
  const hits = new Map();
  function allowRun(req) {
    if (!runsPerHour) return true;
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
    if (list.length >= runsPerHour) { hits.set(ip, list); return false; }
    list.push(now); hits.set(ip, list);
    return true;
  }

  function streamLog(req, res, run) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    for (const c of run.log) res.write(c);
    if (run.status === 'done') return res.end();
    const onData = (c) => res.write(c);
    const onDone = () => { cleanup(); res.end(); };
    const cleanup = () => { run.events.off('data', onData); run.events.off('done', onDone); };
    run.events.on('data', onData);
    run.events.on('done', onDone);
    req.on('close', cleanup);
  }

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
<p><a href="/">Guide</a> · recent runs: <a href="/runs">/runs</a> · <a href="https://github.com/fitzyracing1/light-report">github.com/fitzyracing1/light-report</a></p></body></html>`;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET' && parts.length === 0) {
        const base = process.env.PUBLIC_URL || 'https://light-report-production.up.railway.app';
        const lights = Object.keys(store.all()).sort().map((n) => view(n, store.get(n), ttlMs));
        return send(res, 200, siteHtml({ base, ttlSeconds, lights }), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/board') return send(res, 200, board(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, persistent: store.persistent(), ttlSeconds });
      if (req.method === 'GET' && url.pathname === '/lights') {
        return send(res, 200, Object.keys(store.all()).sort().map((n) => view(n, store.get(n), ttlMs)));
      }
      if (parts[0] === 'runs') {
        if (req.method === 'POST' && parts.length === 1) {
          const body = await readBody(req);
          if (!allowRun(req)) return send(res, 429, { error: `rate limit: ${runsPerHour} runs per hour per IP` });
          const run = runner.submit(body);
          return send(res, 202, { ...runner.view(run), url: `/runs/${run.id}`, log: `/runs/${run.id}/log` });
        }
        if (req.method === 'POST' && parts.length === 2 && parts[1] === 'upload') {
          // body: gzip(JSON {name, command?, files:[{path, mode, data(base64)}]}), max 25 MB on the wire
          const chunks = []; let size = 0;
          for await (const c of req) { size += c.length; if (size > 25 * 1024 * 1024) return send(res, 413, { error: 'upload over 25 MB' }); chunks.push(c); }
          let body;
          try {
            const raw = Buffer.concat(chunks);
            const json = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: 40 * 1024 * 1024 }) : raw;
            body = JSON.parse(json.toString('utf8'));
          } catch (e) { return send(res, 400, { error: `upload must be gzip'd JSON: ${e.message}` }); }
          const bytes = (body.files || []).reduce((n, f) => n + Math.floor(String(f.data || '').length * 3 / 4), 0);
          if (bytes > 20 * 1024 * 1024) return send(res, 413, { error: 'upload over 20 MB of files' });
          if (!allowRun(req)) return send(res, 429, { error: `rate limit: ${runsPerHour} runs per hour per IP` });
          const run = runner.submit({ files: body.files, name: body.name, command: body.command || undefined });
          return send(res, 202, { ...runner.view(run), url: `/runs/${run.id}`, log: `/runs/${run.id}/log` });
        }
        if (req.method === 'GET' && parts.length === 1) return send(res, 200, runner.list());
        const run = parts[1] && runner.get(parts[1]);
        if (!run) return send(res, 404, { error: 'no such run' });
        if (req.method === 'GET' && parts.length === 2) return send(res, 200, runner.view(run));
        if (req.method === 'GET' && parts.length === 3 && parts[2] === 'log') return streamLog(req, res, run);
        return send(res, 404, { error: 'not found' });
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
  server.runner = runner;
  server.on('close', () => runner.stop());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  createApp().listen(port, process.env.HOST || '0.0.0.0', () => console.log(`light-report on :${port}`));
}
