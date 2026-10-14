#!/usr/bin/env node
// light-site — the stable-URL router. Env: LIGHT_SITE_ADMIN_TOKEN (required for writes), LIGHT_SITE_DEFAULT,
// LIGHT_SITE_SEED_LIVE (live URL for the default site on first start), LIGHT_REPORT_URL, DATA_DIR, PORT.
import { createRouter } from '../lib/router.mjs';
const def = process.env.LIGHT_SITE_DEFAULT || 'light-report';
const seed = process.env.LIGHT_SITE_SEED_LIVE ? { [def]: { live: process.env.LIGHT_SITE_SEED_LIVE } } : {};
if (!process.env.LIGHT_SITE_ADMIN_TOKEN) console.error('light-site: LIGHT_SITE_ADMIN_TOKEN not set; flips and edits are disabled');
const port = Number(process.env.PORT || 8080);
createRouter({ dataDir: process.env.DATA_DIR, adminToken: process.env.LIGHT_SITE_ADMIN_TOKEN, lightBase: process.env.LIGHT_REPORT_URL, defaultSite: def, seed })
  .listen(port, process.env.HOST || '0.0.0.0', () => console.log(`light-site on :${port} (default site ${def})`));
