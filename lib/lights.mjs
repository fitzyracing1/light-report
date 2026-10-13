// lights.mjs — the lit/dark rule (active-low), shared by server, CLI and adapters.
// lit = 0, dark = 1. Anything that is not clearly lit is dark.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Map a report body to 'lit' | 'dark'. exitCode 0 → lit; state 'lit' or GitHub 'success' → lit; else dark. */
export function toLight({ exitCode, state } = {}) {
  if (exitCode !== undefined && exitCode !== null && exitCode !== '') {
    return Number(exitCode) === 0 && String(exitCode).trim() !== '' ? 'lit' : 'dark';
  }
  if (state !== undefined && state !== null) {
    const s = String(state).trim().toLowerCase();
    if (s === 'lit' || s === 'success' || s === '0') return 'lit';
    return 'dark';
  }
  return 'dark';
}

export const toBit = (light) => (light === 'lit' ? 0 : 1);

/** Pack up to 8 lights into one active-low byte (MSB = first), as in lit-dark SPEC.md. */
export function lightsToByte(lights) {
  return lights.slice(0, 8).reduce((b, l, i) => (l === 'lit' ? b : b | (1 << (7 - i))), 0);
}

export const newToken = () => 'lr_' + randomBytes(24).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export function tokenMatches(token, hash) {
  if (!token || !hash) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Public view of a stored record. A light with no report within ttlMs is dark (stale). */
export function view(name, rec, ttlMs, now = Date.now()) {
  if (!rec || !rec.reportedAt) {
    return { name, light: 'dark', bit: 1, source: null, detail: null, reportedAt: null, stale: true };
  }
  const stale = ttlMs > 0 && now - Date.parse(rec.reportedAt) > ttlMs;
  const light = stale ? 'dark' : rec.light;
  return { name, light, bit: toBit(light), source: rec.source ?? null, detail: rec.detail ?? null, reportedAt: rec.reportedAt, stale };
}

export function badgeSvg(label, light) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const lw = Math.max(40, 7 * label.length + 12);
  const rw = 44;
  const color = light === 'lit' ? '#f2b705' : '#333';
  const lamp = light === 'lit' ? '●' : '○';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${esc(label)}: ${light}">` +
    `<title>${esc(label)}: ${light}</title>` +
    `<rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/>` +
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="6" y="14">${esc(label)}</text><text x="${lw + 5}" y="14">${lamp} ${light}</text></g></svg>`;
}
