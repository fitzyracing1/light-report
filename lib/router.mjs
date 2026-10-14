// router.mjs — "light-site": one stable URL that reverse-proxies to the current copy of a site.
// Each site has a live copy and up to MAX_TRIALS trial copies. POST /sites/:name/flip {to} moves the
// stable URL between them; a trial whose light is dark is refused unless {force:true}. Flipping back is instant.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';

export const SITE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const TRIAL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_TRIALS = 2;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

function okUrl(u) {
  try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') && !x.username && !x.password ? x.origin : null; } catch { return null; }
}
const sameSecret = (given, want) => {
  if (!want || !given) return false;
  const a = createHash('sha256').update(String(given)).digest(), b = createHash('sha256').update(String(want)).digest();
  return timingSafeEqual(a, b);
};

export function openSites(dir) {
  let file = null, data = { sites: {} };
  if (dir) {
    try { mkdirSync(dir, { recursive: true }); file = join(dir, 'sites.json'); try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } data.sites ||= {}; }
    catch (e) { console.error(`sites: cannot use ${dir} (${e.message}); in memory`); file = null; }
  }
  const save = () => { if (file) { writeFileSync(file + '.tmp', JSON.stringify(data, null, 2)); renameSync(file + '.tmp', file); } };
  return { persistent: () => !!file, get: (n) => data.sites[n], all: () => data.sites, set(n, v) { data.sites[n] = v; save(); }, del(n) { delete data.sites[n]; save(); } };
}

/** Public view of a site (no secrets are stored, but keep it tidy). */
export function siteView(name, s) {
  return { name, target: s.target, targetUrl: s.target === 'live' ? s.live : s.trials[s.target]?.url, live: s.live,
    trials: Object.entries(s.trials).map(([id, t]) => ({ id, url: t.url, light: t.light, branch: t.branch, createdAt: t.createdAt })),
    history: s.history.slice(-10) };
}

/**
 * opts: { dataDir, adminToken, lightBase, defaultSite, fetchLight(name) → 'lit'|'dark', seed: {site:{live}} }
 */
export function createRouter(opts = {}) {
  const sites = openSites(opts.dataDir);
  const lightBase = (opts.lightBase || 'https://light-report-production.up.railway.app').replace(/\/+$/, '');
  const fetchLight = opts.fetchLight || (async (name) => {
    const r = await fetch(`${lightBase}/lights/${encodeURIComponent(name)}`);
    if (!r.ok) return 'dark';
    return (await r.json()).light === 'lit' ? 'lit' : 'dark';
  });
  for (const [n, v] of Object.entries(opts.seed || {})) if (!sites.get(n) && okUrl(v.live)) sites.set(n, { live: okUrl(v.live), target: 'live', trials: {}, history: [] });

  const send = (res, code, body) => { const s = JSON.stringify(body, null, 2) + '\n'; res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(s); };
  const readBody = async (req) => { let s = ''; for await (const c of req) { s += c; if (s.length > 65536) throw Object.assign(new Error('body too large'), { code: 413 }); } try { return s ? JSON.parse(s) : {}; } catch { throw Object.assign(new Error('body must be JSON'), { code: 400 }); } };
  const isAdmin = (req) => { const a = req.headers.authorization || ''; return sameSecret(a.startsWith('Bearer ') ? a.slice(7).trim() : '', opts.adminToken); };

  async function api(req, res, parts) {
    const name = parts[1];
    if (!name) return req.method === 'GET' ? send(res, 200, Object.entries(sites.all()).map(([n, s]) => siteView(n, s))) : send(res, 404, { error: 'not found' });
    if (!SITE_RE.test(name)) return send(res, 400, { error: 'site name: a-z 0-9 - (max 63)' });
    const s = sites.get(name);
    if (req.method === 'GET' && parts.length === 2) return s ? send(res, 200, siteView(name, s)) : send(res, 404, { error: 'no such site' });
    if (!isAdmin(req)) return send(res, 401, { error: 'admin token missing or wrong' });
    const body = req.method === 'DELETE' ? {} : await readBody(req);
    if (req.method === 'PUT' && parts.length === 2) {
      const live = okUrl(body.live);
      if (!live) return send(res, 400, { error: 'live must be an http(s) URL' });
      const next = s ? { ...s, live } : { live, target: 'live', trials: {}, history: [] };
      sites.set(name, next); return send(res, s ? 200 : 201, siteView(name, next));
    }
    if (!s) return send(res, 404, { error: 'no such site' });
    if (req.method === 'POST' && parts[2] === 'trials' && parts.length === 3) {
      const id = String(body.id || ''), url = okUrl(body.url);
      if (!TRIAL_RE.test(id) || id === 'live') return send(res, 400, { error: 'trial id: a-z 0-9 - (max 40), not "live"' });
      if (!url) return send(res, 400, { error: 'url must be an http(s) URL' });
      if (!s.trials[id] && Object.keys(s.trials).length >= MAX_TRIALS) return send(res, 409, { error: `at most ${MAX_TRIALS} trials per site; remove one first` });
      s.trials[id] = { url, light: String(body.light || ''), branch: String(body.branch || ''), service: String(body.service || ''), createdAt: new Date().toISOString() };
      sites.set(name, s); return send(res, 201, siteView(name, s));
    }
    if (req.method === 'DELETE' && parts[2] === 'trials' && parts.length === 4) {
      const id = parts[3];
      if (!s.trials[id]) return send(res, 404, { error: 'no such trial' });
      if (s.target === id) { s.target = 'live'; s.history.push({ at: new Date().toISOString(), to: 'live', why: `trial ${id} removed` }); }
      delete s.trials[id]; sites.set(name, s); return send(res, 200, siteView(name, s));
    }
    if (req.method === 'POST' && parts[2] === 'flip' && parts.length === 3) {
      const to = String(body.to || '');
      if (to !== 'live' && !s.trials[to]) return send(res, 404, { error: `no trial "${to}" (use "live" or one of: ${Object.keys(s.trials).join(', ') || 'none'})` });
      let light = null;
      if (to !== 'live') {
        const t = s.trials[to];
        light = t.light ? await fetchLight(t.light).catch(() => 'dark') : 'dark';
        if (light !== 'lit' && body.force !== true) return send(res, 409, { error: `trial ${to} is dark; flip refused (send force:true to override)`, light });
      }
      const from = s.target;
      s.target = to; s.history.push({ at: new Date().toISOString(), from, to, light, forced: to !== 'live' && light !== 'lit' });
      sites.set(name, s); return send(res, 200, siteView(name, s));
    }
    return send(res, 404, { error: 'not found' });
  }

  function proxy(req, res, origin, siteName) {
    const u = new URL(req.url, origin);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-proto'] ||= 'https';
    const up = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: req.method, headers, timeout: 30000 }, (r) => {
      const h = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v;
      h['x-light-site'] = `${siteName}:${sites.get(siteName)?.target}`;
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', (e) => { if (!res.headersSent) send(res, 502, { error: `upstream: ${e.message}` }); else res.destroy(); });
    req.pipe(up);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] === 'sites') return await api(req, res, parts);
      if (url.pathname === '/_light-site/health') return send(res, 200, { ok: true, persistent: sites.persistent() });
      const name = opts.defaultSite || Object.keys(sites.all())[0];
      const s = name && sites.get(name);
      if (!s) return send(res, 404, { error: 'no site configured' });
      const origin = s.target === 'live' ? s.live : s.trials[s.target]?.url || s.live;
      return proxy(req, res, origin, name);
    } catch (e) { send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
  });
  server.sites = sites;
  return server;
}
