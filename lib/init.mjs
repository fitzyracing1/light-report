// init.mjs — write AI-agent integration into a repo. Idempotent: merges JSON, replaces marked blocks.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export const NPX = 'npx -y -p github:fitzyracing1/light-report';
const START = '<!-- light-check:start -->';
const END = '<!-- light-check:end -->';

const AGENT_TEXT = `## Light check (lit / dark)

Before you say a task is done, and before anything is committed or pushed, run:

\`\`\`bash
${NPX} light-check . --local
\`\`\`

- Exit code 0 means the light is **lit**: the project's tests ran clean. You may finish.
- Any other exit code means the light is **dark**. Read the log, fix the cause, and run it again. Keep going until it is lit.
- Do not skip, delete or weaken tests to make the light lit.
- \`--local\` runs the tests on this machine (nothing is uploaded). Without it, the working tree is uploaded to the light-report runner.
- What runs: \`light.yml\` / \`.light\` \`run:\` lines if present, otherwise the detected test command (npm test, pytest, cargo test, make test).`;

function read(f) { try { return readFileSync(f, 'utf8'); } catch { return null; } }
function write(root, rel, text, log, how) {
  const f = join(root, rel);
  const before = read(f);
  if (before === text) { log.push(`unchanged  ${rel}`); return; }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  log.push(`${before === null ? 'created ' : 'updated '}  ${rel}${how ? `  (${how})` : ''}`);
}

/** Insert or replace a marked block in a markdown file. */
export function upsertBlock(text, block) {
  const wrapped = `${START}\n${block.trim()}\n${END}`;
  if (text == null || text === '') return wrapped + '\n';
  const i = text.indexOf(START), j = text.indexOf(END);
  if (i >= 0 && j > i) return text.slice(0, i) + wrapped + text.slice(j + END.length);
  return text.replace(/\s*$/, '') + '\n\n' + wrapped + '\n';
}

function mergeJson(root, rel, mutate, log) {
  const f = join(root, rel);
  const before = read(f);
  let obj = {};
  if (before !== null && before.trim()) {
    try { obj = JSON.parse(before); } catch {
      log.push(`skipped    ${rel}  (not plain JSON — maybe comments; add the light-check entry by hand, see the website)`);
      return;
    }
  }
  mutate(obj);
  write(root, rel, JSON.stringify(obj, null, 2) + '\n', log, before === null ? '' : 'merged');
}

export const claudeStopHook = { type: 'command', command: `${NPX} light-check --hook claude-stop`, timeout: 900, statusMessage: 'light-check: running tests (lit / dark)…' };
export const claudeEditHook = { type: 'command', command: `${NPX} light-check --hook claude-post-edit`, timeout: 900 };

const hasLightCheck = (groups) => (groups || []).some((g) => (g.hooks || []).some((h) => String(h.command || '').includes('light-check')));

export function init(root, { postEdit = false, prePush = false, folderOpen = false } = {}) {
  const log = [];
  // Claude Code
  mergeJson(root, '.claude/settings.json', (o) => {
    o.hooks ||= {};
    o.hooks.Stop ||= [];
    if (!hasLightCheck(o.hooks.Stop)) o.hooks.Stop.push({ hooks: [claudeStopHook] });
    if (postEdit) {
      o.hooks.PostToolUse ||= [];
      if (!hasLightCheck(o.hooks.PostToolUse)) o.hooks.PostToolUse.push({ matcher: 'Edit|Write|MultiEdit', hooks: [claudeEditHook] });
    }
  }, log);
  write(root, 'CLAUDE.md', upsertBlock(read(join(root, 'CLAUDE.md')), AGENT_TEXT + `\n\nA Claude Code Stop hook in \`.claude/settings.json\` runs this for you and sends you back to work while the light is dark.`), log);
  // VS Code / Copilot
  mergeJson(root, '.vscode/tasks.json', (o) => {
    o.version ||= '2.0.0';
    o.tasks ||= [];
    const task = { label: 'light-check', type: 'shell', command: `${NPX} light-check . --local`, group: 'test', problemMatcher: [], presentation: { reveal: 'always', panel: 'dedicated' }, ...(folderOpen ? { runOptions: { runOn: 'folderOpen' } } : {}) };
    const i = o.tasks.findIndex((t) => t.label === 'light-check');
    if (i >= 0) o.tasks[i] = { ...o.tasks[i], ...task }; else o.tasks.push(task);
  }, log);
  write(root, '.github/copilot-instructions.md', upsertBlock(read(join(root, '.github/copilot-instructions.md')), AGENT_TEXT + `\n\nIn VS Code you can also run the task **light-check** (Terminal → Run Task).`), log);
  // Cursor + generic agents
  write(root, '.cursor/rules/light-check.mdc', `---\ndescription: Run light-check (lit / dark) before finishing a task or committing\nalwaysApply: true\n---\n\n${AGENT_TEXT}\n`, log);
  write(root, 'AGENTS.md', upsertBlock(read(join(root, 'AGENTS.md')), AGENT_TEXT), log);
  // git pre-push
  if (prePush) {
    let gitDir = null;
    try { gitDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
    if (!gitDir) log.push('skipped    pre-push hook  (not a git repo)');
    else {
      const rel = join(gitDir, 'pre-push');
      const f = join(root, rel);
      const block = `# light-check:start\n${NPX} light-check . --local || { echo "light-check: dark — push blocked. Fix it, or skip once with: git push --no-verify" >&2; exit 1; }\n# light-check:end\n`;
      const cur = read(f);
      let next;
      if (cur === null) next = `#!/bin/sh\n${block}`;
      else if (cur.includes('# light-check:start')) next = cur.replace(/# light-check:start[\s\S]*?# light-check:end\n?/, block);
      else { const nl = cur.startsWith('#!') ? cur.indexOf('\n') + 1 : 0; next = cur.slice(0, nl) + block + cur.slice(nl); }
      write(root, rel, next, log, cur === null ? '' : 'merged');
      chmodSync(f, 0o755);
    }
  }
  return log;
}
