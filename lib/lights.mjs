// lights.mjs — the lit/dark rule (active-low), shared by server, CLI and adapters.
// lit = 0, dark = 1. The rule itself comes from @fitzyracing1/light-core: exit 0 / success is lit, every
// other exit code or conclusion is dark, and missing or unreadable data is an error (never dark).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lightOf, lightOfExit, asLight, toBit, pack, isStale, LightError, CONCLUSIONS, fromBit } from '@fitzyracing1/light-core';

export { toBit, LightError };

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Map a report body to 'lit' | 'dark'. exitCode: 0 → lit, any other integer → dark. state: 'lit' | 'dark',
 * a bit ('0' | '1') or a GitHub conclusion (only 'success' is lit). Anything else throws LightError (HTTP 400).
 */
export function toLight({ exitCode, state } = {}) {
  if (exitCode !== undefined && exitCode !== null) return lightOfExit(exitCode);
  if (state !== undefined && state !== null) {
    const s = String(state).trim().toLowerCase();
    if (s === 'lit' || s === 'dark') return asLight(s);
    if (s === '0' || s === '1') return fromBit(Number(s));
    if (CONCLUSIONS.includes(s)) return lightOf(s);
    throw new LightError('bad-value', `state must be lit, dark, 0, 1 or a GitHub conclusion, got ${JSON.stringify(state)}`);
  }
  throw new LightError('bad-value', 'report needs exitCode or state; no data is not a light');
}

/** Pack up to 8 lights into one active-low byte (MSB = first). Throws on more than 8 or a non-light. */
export const lightsToByte = (lights) => pack(lights);

export const newToken = () => 'lr_' + randomBytes(24).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export function tokenMatches(token, hash) {
  if (!token || !hash) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Public view of a stored record. A light with no report within ttlMs is dark (stale): light-report policy.
 * A name that was never reported has no light (light: null), not dark.
 */
export function view(name, rec, ttlMs, now = Date.now()) {
  if (!rec || !rec.reportedAt) {
    return { name, light: null, bit: null, source: null, detail: null, reportedAt: null, stale: false };
  }
  const stale = ttlMs > 0 && isStale(rec.reportedAt, ttlMs, now);
  const light = stale ? 'dark' : rec.light;
  return { name, light, bit: toBit(light), source: rec.source ?? null, detail: rec.detail ?? null, reportedAt: rec.reportedAt, stale };
}

export function badgeSvg(label, light) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const lw = Math.max(40, 7 * label.length + 12);
  const none = light !== 'lit' && light !== 'dark';
  const color = light === 'lit' ? '#f2b705' : none ? '#9f9f9f' : '#333';
  const lamp = light === 'lit' ? '●' : none ? '' : '○';
  const word = none ? 'no light' : light;
  const rw = none ? 56 : 44;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${esc(label)}: ${word}">` +
    `<title>${esc(label)}: ${word}</title>` +
    `<rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/>` +
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="6" y="14">${esc(label)}</text><text x="${lw + 5}" y="14">${lamp ? lamp + ' ' : ''}${word}</text></g></svg>`;
}
