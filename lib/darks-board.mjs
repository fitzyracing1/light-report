// darks-board.mjs — public 'Darks' board. Reads darks.json from the fitzyracing1/darks repo (cached).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const et = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : '—');

export function createDarksSource({ url = process.env.DARKS_JSON_URL || 'https://raw.githubusercontent.com/fitzyracing1/darks/main/darks.json', ttlMs = 5 * 60_000, fetchImpl = fetch } = {}) {
  let cache = null, at = 0, pending = null;
  async function load() {
    if (cache && Date.now() - at < ttlMs) return cache;
    if (pending) return pending;
    pending = (async () => {
      try {
        const res = await fetchImpl(url + (url.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / 60000), { headers: { 'User-Agent': 'light-report' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        cache = await res.json(); at = Date.now();
      } catch (e) { if (!cache) cache = { darks: {}, error: `darks.json not readable yet (${e.message})` }; }
      finally { pending = null; }
      return cache;
    })();
    return pending;
  }
  return { load };
}

const ORDER = { new: 0, 'fix-trying': 1, 'fix-lit': 2, 'PR-queued': 3, relit: 4 };
export function darksJson(state) {
  const list = Object.values(state.darks || {}).map((e) => ({
    repo: e.repo, stars: e.stars, workflow: e.workflow, path: e.path, light: e.light, bit: e.light === 'lit' ? 0 : 1,
    darkSince: e.darkSince, darkSinceET: et(e.darkSince), cause: e.cause, class: e.class, run: e.run, status: e.status,
    relitAt: e.relitAt ?? null, issue: e.issue ? `https://github.com/fitzyracing1/darks/issues/${e.issue}` : null,
  })).sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (b.stars || 0) - (a.stars || 0));
  return { updatedAt: state.updatedAt ?? null, lastCrawl: state.lastCrawl ?? null, counts: { dark: list.filter((x) => x.light === 'dark').length, relit: list.filter((x) => x.status === 'relit').length }, darks: list, queued: state.queued || [], error: state.error };
}

export function darksHtml(state) {
  const j = darksJson(state);
  const rows = j.darks.map((d) => `<tr class="${d.light}"><td class="lamp">${d.light === 'dark' ? '○' : '●'}</td>
<td><a href="https://github.com/${esc(d.repo)}">${esc(d.repo)}</a><div class="m">${(d.stars ?? 0).toLocaleString('en-US')} ★</div></td>
<td>${esc(d.workflow)}<div class="m">${esc(d.path)}</div></td><td>${esc(d.darkSinceET)}</td><td class="cause">${esc(d.cause)}</td>
<td><span class="tag c-${esc(String(d.class).replace(/\s/g, '-'))}">${esc(d.class)}</span></td>
<td><span class="tag s-${esc(d.status)}">${esc(d.status)}</span>${d.relitAt ? `<div class="m">relit ${esc(et(d.relitAt))}</div>` : ''}</td>
<td><a href="${esc(d.run)}">run</a>${d.issue ? ` · <a href="${esc(d.issue)}">issue</a>` : ''}</td></tr>`).join('');
  const q = j.queued.map((x) => `<li><code>${esc(x.key)}</code> — ${esc(x.action || '')} ${esc(x.note || '')}</li>`).join('');
  const lc = j.lastCrawl;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Darks — dark CI lights in popular repos</title>
<style>body{margin:0;background:#0f1115;color:#e7e9ee;font:15px/1.5 system-ui,sans-serif}main{max-width:1200px;margin:0 auto;padding:24px 16px 60px}a{color:#8ab4ff}
h1{margin:8px 0}p{color:#9aa3b2}.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:8px;border-bottom:1px solid #2a2f3a;text-align:left;vertical-align:top}th{color:#9aa3b2}
.lamp{font-size:20px}.dark .lamp{color:#5b6270}.lit .lamp{color:#f2b705}.m{color:#9aa3b2;font-size:12px}.cause{max-width:380px;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.tag{display:inline-block;border:1px solid #2a2f3a;border-radius:10px;padding:0 8px;font-size:12px;white-space:nowrap}.s-relit{color:#f2b705;border-color:#f2b705}.s-new{color:#e7e9ee}
nav a{margin-right:14px;color:#9aa3b2}.stats{display:flex;gap:24px;flex-wrap:wrap;margin:12px 0}.stats b{font-size:22px;display:block;color:#e7e9ee}</style></head><body><main>
<nav><a href="/">● light-report</a><a href="/darks.json">darks.json</a><a href="https://github.com/fitzyracing1/darks">fitzyracing1/darks</a><a href="https://github.com/fitzyracing1/darks/issues">issues</a></nav>
<h1>Darks</h1><p>Dark CI lights in popular GitHub repos, found by the <a href="https://github.com/fitzyracing1/darks">dark crawler</a>. Strict rule, per workflow that still exists on the default branch: the latest completed push or schedule run on the default branch in the last 30 days. <b>success = lit, anything else = dark</b>; a newer lit run wins. pages-build-deployment, Dependabot and dynamic CodeQL are ignored. When a repo goes lit again, its entry turns <b>relit</b> and its issue in fitzyracing1/darks closes.</p>
<div class="stats"><div><b>${j.counts.dark}</b>dark</div><div><b>${j.counts.relit}</b>relit</div><div><b>${lc ? lc.scanned : '—'}</b>repos in last crawl</div><div><b>${lc ? esc(et(lc.at)) : '—'}</b>last crawl</div></div>
${j.error ? `<p>${esc(j.error)}</p>` : ''}
<div class="wrap"><table><tr><th></th><th>repo</th><th>workflow</th><th>dark since</th><th>cause</th><th>class</th><th>status</th><th></th></tr>${rows || '<tr><td colspan="8">No darks yet.</td></tr>'}</table></div>
<h2>Queued for Joshua's approval</h2><p>Nothing is ever posted to other people's repos by the crawler. Proposed upstream actions wait here (and in <a href="https://github.com/fitzyracing1/darks/blob/main/QUEUE.md">QUEUE.md</a>) until Joshua sends them himself.</p><ul>${q || '<li>Nothing queued.</li>'}</ul>
<p class="m">Statuses: new · fix-trying · fix-lit (a fix is lit in a fork) · PR-queued (waiting for approval) · relit (upstream is lit again).</p>
</main></body></html>`;
}
