// store.mjs — tiny JSON-file store. Atomic writes (tmp + rename). Point DATA_DIR at a Railway volume.
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export function openStore(dir) {
  let file = null;
  let data = { lights: {} };
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      try { chmodSync(dir, 0o700); } catch {} // runner jobs (unprivileged) cannot read it
      file = join(dir, 'lights.json');
      try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      data.lights ||= {};
      save();
    } catch (e) {
      console.error(`store: cannot use ${dir} (${e.message}); keeping lights in memory`);
      file = null;
    }
  }
  function save() {
    if (!file) return;
    writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
    renameSync(file + '.tmp', file);
  }
  return {
    persistent: () => !!file,
    get: (name) => data.lights[name],
    all: () => data.lights,
    set(name, rec) { data.lights[name] = rec; save(); },
  };
}
