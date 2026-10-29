import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

// Verify the host's parsed dependency, rather than merely checking JSON syntax.
const root = resolve(process.argv[2] || '.');
const expected = JSON.parse(await readFile(resolve(root, '.app.json'), 'utf8')).apps['pretty-md'].id;
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
const pending = new Map();
const lines = createInterface({ input: child.stdout });
function fail(error) { for (const task of pending.values()) task.reject(error); pending.clear(); }
child.on('error', fail);
child.on('exit', () => fail(new Error('Codex app-server exited before verification completed.')));
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const task = pending.get(message.id);
  if (!task) return;
  pending.delete(message.id);
  if (message.error) task.reject(new Error(message.error.message));
  else task.resolve(message.result);
});
let nextId = 0;
function call(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  await call('initialize', { clientInfo: { name: 'pretty-md-verification', version: '1' }, capabilities: { experimentalApi: true } });
  const { plugin } = await call('plugin/read', { marketplacePath: resolve(root, '.agents/plugins/marketplace.json'), pluginName: 'pretty-md' });
  if (!plugin.apps.some(app => app.id === expected)) throw new Error('Codex did not resolve the Pretty MD app dependency. Do not publish this package as connected.');
  console.log(`Codex resolved Pretty MD's registered app for package ${plugin.summary.localVersion}.`);
  console.log('This verifies manifest loading; test pretty_md_render in a fresh chat to verify tool invocation.');
} finally {
  lines.close();
  child.kill();
}
