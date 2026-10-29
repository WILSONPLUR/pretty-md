import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { checkPlanDelivery, PLAN_CONTEXT, rememberRender } from './plan-delivery.mjs';

const mode = ['snapshot', 'stop', 'prompt'].includes(process.argv[2]) ? process.argv[2] : 'detect';
const MARKDOWN = /\.(?:md|markdown|mdown|mkd)$/i;
const SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache']);
const MAX_FILES = 10000;

async function input() {
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  try { return JSON.parse(source || '{}'); } catch { return {}; }
}

async function scan(root) {
  const files = {};
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) pending.push(path);
        continue;
      }
      if (!entry.isFile() || !MARKDOWN.test(entry.name)) continue;
      if (++count > MAX_FILES) return files;
      try {
        const details = await stat(path, { bigint: true });
        const name = relative(root, path).split(sep).join('/');
        files[name] = `${details.size}:${details.mtimeNs}`;
      } catch {}
    }
  }
  return files;
}

async function explicitMarkdownPaths(payload, root, known = []) {
  const values = [payload.tool_input?.path, payload.tool_input?.file_path, payload.tool_input?.output_path,
    payload.tool_input?.destination, payload.tool_input?.target, ...known];
  const files = {};
  for (const value of values) {
    if (typeof value !== 'string' || !MARKDOWN.test(value)) continue;
    const path = resolve(root, value);
    if (path === root || path.startsWith(`${root}${sep}`)) continue;
    try {
      const details = await stat(path, { bigint: true });
      if (details.isFile()) files[path] = `${details.size}:${details.mtimeNs}`;
    } catch {}
  }
  return files;
}

async function load(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

async function save(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

const payload = await input();
if (mode === 'prompt') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PLAN_CONTEXT } }));
  process.exit(0);
}
const cwd = resolve(typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());
const pluginData = process.env.PLUGIN_DATA;
if (!pluginData) process.exit(0);

await mkdir(pluginData, { recursive: true, mode: 0o700 });
const key = createHash('sha256').update(`${cwd}\0${payload.session_id || ''}`).digest('hex').slice(0, 24);
const statePath = join(pluginData, `markdown-${key}.json`);
// Parallel PostToolUse calls must not overwrite each other's render receipts.
async function withSessionLock(action) {
  const lock = `${statePath}.lock`;
  const deadline = Date.now() + 10000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 30000) await rmdir(lock); } catch {}
      if (Date.now() >= deadline) {
        process.stdout.write(JSON.stringify({ systemMessage: 'Pretty MD delivery check could not acquire its session lock. Link delivery is not verified; check the plan reader link.' }));
        return;
      }
      await delay(25);
    }
  }
  try { await action(); } finally { await rmdir(lock); }
}

await withSessionLock(async () => {
const previous = await load(statePath);
const knownExternal = Object.keys(previous?.files || {}).filter((path) => path.startsWith('/'));
const current = { ...await scan(cwd), ...await explicitMarkdownPaths(payload, cwd, knownExternal) };
if (mode === 'snapshot') {
  await save(statePath, { ...previous, files: current, pending: previous?.pending || {}, continuedTurnId: null });
  return;
}

const state = previous?.files ? previous : { files: previous || current, pending: {}, continuedTurnId: null };
state.pending ||= {};
const changed = Object.keys(current).filter((path) => state.files[path] !== current[path]).sort();
for (const path of changed) state.pending[path] = current[path];
for (const path of Object.keys(state.pending)) if (!current[path]) delete state.pending[path];
state.files = current;
rememberRender(state, payload);

const response = payload.tool_response?.result || payload.tool_response;
const arguments_ = payload.tool_input?.arguments || payload.tool_input;
if (mode === 'detect' && /pretty_md_render$/.test(payload.tool_name || '') && response && !response.isError && response.structuredContent?.viewUrl && typeof arguments_?.markdown === 'string') {
  const filename = typeof arguments_.filename === 'string' ? arguments_.filename.replace(/\\/g, '/') : '';
  let candidates = Object.keys(state.pending).filter((path) => path === filename || resolve(cwd, path) === resolve(cwd, filename));
  if (!candidates.length) {
    candidates = Object.keys(state.pending).filter((path) => basename(path) === basename(filename));
    if (candidates.length !== 1) candidates = [];
  }
  const suppliedHash = createHash('sha256').update(arguments_.markdown).digest('hex');
  for (const path of candidates) {
    try {
      const savedHash = createHash('sha256').update(await readFile(resolve(cwd, path))).digest('hex');
      if (savedHash === suppliedHash) delete state.pending[path];
    } catch {}
  }
}

let output = null;
if (mode === 'detect' && changed.length) {
  const listed = changed.map((path) => `- ${path}`).join('\n');
  output = { hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: `pretty-md required automatic follow-up: these saved Markdown files changed:\n${listed}\n\nBefore replying, read each complete current file and call pretty_md_render with its exact contents and workspace-relative filename. Do not treat a normal file link as completion and do not wait for the user to name pretty-md. In Codex, open the returned viewUrl in a browser panel with open_in_codex. Always include [Open in Pretty MD](viewUrl) and the saved-file link in final chat, even when the panel opens. Add: Reader link expires in 24 hours. A queued panel is not proof it opened on the device. Keep the file accessible without repeating the document in chat.`,
  } };
}
if (mode === 'stop' && Object.keys(state.pending).length && !payload.stop_hook_active && state.continuedTurnId !== payload.turn_id) {
  state.continuedTurnId = payload.turn_id || 'unknown';
  const listed = Object.keys(state.pending).sort().map((path) => `- ${path}`).join('\n');
  output = { decision: 'block', reason: `Before finishing, complete the required Pretty MD follow-up for these changed Markdown files:\n${listed}\nRead each current file and call pretty_md_render with exact text and its workspace-relative filename. A normal file link is not completion; do not wait for the user to name pretty-md. Then open each returned viewUrl using open_in_codex as a browser panel. Always include [Open in Pretty MD](viewUrl) plus the saved-file link for each filename in final chat, even when panels open. Add: Reader link expires in 24 hours. A queued panel is not proof it opened on the device. Do not repeat full documents in chat.` };
}
if (mode === 'stop') {
  const planOutput = checkPlanDelivery(state, payload, statePath);
  if (planOutput) {
    if (output?.decision === 'block' && planOutput.decision === 'block') output.reason += `\n\n${planOutput.reason}`;
    else output = planOutput;
  }
}
await save(statePath, state);
if (output) process.stdout.write(JSON.stringify(output));
});
