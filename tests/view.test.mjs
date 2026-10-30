import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

class MemoryBucket {
  objects = new Map();
  async put(key, body, options = {}) {
    if (options.onlyIf && this.objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
    const etag = crypto.randomUUID();
    this.objects.set(key, { body: String(body), customMetadata: options.customMetadata || {}, etag });
    return { etag };
  }
  async get(key) {
    const item = this.objects.get(key);
    return item ? { etag: item.etag, customMetadata: item.customMetadata, text: async () => item.body } : null;
  }
  async delete(key) { this.objects.delete(key); }
  async list() {
    return { objects: [...this.objects].map(([key, item]) => ({ key, customMetadata: item.customMetadata })), truncated: false };
  }
}

function call(bucket, user, name, args) {
  return worker.fetch(new Request('https://pretty-md.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'oai-authenticated-user-id': user } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), { BUCKET: bucket });
}
function visit(bucket, user, path) {
  return worker.fetch(new Request(`https://pretty-md.example${path}`, {
    headers: user ? { 'oai-authenticated-user-id': user } : {},
  }), { BUCKET: bucket });
}

test('render returns an expiring link-access browser reader without echoing the full document in chat', async () => {
  const bucket = new MemoryBucket();
  const markdown = '# Private plan\n\nA secret paragraph that belongs in the reader.\n';
  const response = await call(bucket, 'user-a', 'pretty_md_render', { markdown, filename: 'PLAN.md' });
  const result = (await response.json()).result;
  assert.equal(result.isError, undefined);
  const viewUrl = result.structuredContent.viewUrl;
  assert.equal(result.content[0].text.split('\n')[0], `[Open in Pretty MD](${viewUrl})`);
  assert.match(result.content[0].text, /expires in 24 hours/);
  assert.match(result.content[0].text, /even when a desktop panel opens/);
  assert.equal(result.structuredContent.deliveryMarkdown, `[Open in Pretty MD](${viewUrl})`);
  assert.ok(Date.parse(result.structuredContent.expiresAt) > Date.now());
  assert.match(viewUrl, /^https:\/\/pretty-md\.example\/view\/[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(viewUrl, /Private|secret|PLAN/);
  assert.doesNotMatch(result.content[0].text, /secret paragraph/);
  assert.equal(result.structuredContent.sourceMarkdown, markdown);

  const page = await visit(bucket, 'user-a', new URL(viewUrl).pathname);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self' data:/);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Download original/);
  assert.match(pageHtml, /src="\/assets\/logo-v1\.svg"/);
  assert.doesNotMatch(pageHtml, /data:image\/svg\+xml;base64/);
  const apiPath = new URL(viewUrl).pathname.replace('/view/', '/api/view/');
  const data = await visit(bucket, 'user-a', apiPath);
  assert.equal(data.status, 200);
  assert.deepEqual(await data.json(), { filename: 'PLAN.md', markdown, canWrite: true, signInUrl: null });
  for (const user of [null, 'user-b']) {
    const response = await visit(bucket, user, apiPath);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
    assert.deepEqual(await response.json(), { filename: 'PLAN.md', markdown, canWrite: false,
      signInUrl: user ? null : `/signin-with-chatgpt?return_to=${encodeURIComponent(new URL(viewUrl).pathname)}` });
    const page = await visit(bucket, user, new URL(viewUrl).pathname);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('location'), null);
    assert.match(page.headers.get('x-robots-tag'), /noindex/);
  }
});

test('reader links last 24 hours from creation without extending on reads', async (t) => {
  const created = Date.now();
  let now = created;
  t.mock.method(Date, 'now', () => now);
  const bucket = new MemoryBucket();
  const result = (await (await call(bucket, 'user-a', 'pretty_md_render', { markdown: '# Day-long access', filename: 'PLAN.md' })).json()).result;
  const [key, stored] = [...bucket.objects][0];
  assert.equal(Number(stored.customMetadata.expiresAt), created + 24 * 60 * 60 * 1000);
  const path = new URL(result.structuredContent.viewUrl).pathname.replace('/view/', '/api/view/');
  now = created + 24 * 60 * 60 * 1000 - 1;
  assert.equal((await visit(bucket, 'user-a', path)).status, 200);
  assert.equal(Number(stored.customMetadata.expiresAt), created + 24 * 60 * 60 * 1000);
  now += 1;
  assert.equal((await visit(bucket, 'user-a', path)).status, 404);
  assert.equal(bucket.objects.has(key), false);
});

test('expired documents stop opening and are removed from storage', async () => {
  const bucket = new MemoryBucket();
  const response = await call(bucket, 'user-a', 'pretty_md_render', { markdown: '# Short lived', filename: 'NOTES.md' });
  const viewUrl = (await response.json()).result.structuredContent.viewUrl;
  const [key, stored] = [...bucket.objects][0];
  stored.customMetadata.expiresAt = String(Date.now() - 1);
  const apiPath = new URL(viewUrl).pathname.replace('/view/', '/api/view/');
  assert.equal((await visit(bucket, 'user-a', apiPath)).status, 404);
  assert.equal(bucket.objects.has(key), false);
  const markdown = '# Current source\n\nUpdated after expiry.';
  const fresh = (await (await call(bucket, 'user-a', 'pretty_md_render', { markdown, filename: 'NOTES.md' })).json()).result;
  assert.notEqual(fresh.structuredContent.viewUrl, viewUrl);
  const freshPath = new URL(fresh.structuredContent.viewUrl).pathname.replace('/view/', '/api/view/');
  assert.deepEqual(await (await visit(bucket, 'user-a', freshPath)).json(), { filename: 'NOTES.md', markdown, canWrite: true, signInUrl: null });
});

function save(bucket, user, path, markdown, etag, extra = {}) {
  return worker.fetch(new Request(`https://pretty-md.example${path}`, {
    method: 'PUT', headers: { 'content-type': 'text/markdown', origin: 'https://pretty-md.example',
      ...(user ? { 'oai-authenticated-user-id': user } : {}), ...(etag ? { 'if-match': etag } : {}), ...extra }, body: markdown,
  }), { BUCKET: bucket });
}

test('Save updates the original view, preserves expiry, and guards ownership and versions', async () => {
  const bucket = new MemoryBucket();
  const result = (await (await call(bucket, 'user-a', 'pretty_md_render', { markdown: '# Original', filename: 'Notes.md' })).json()).result;
  const path = new URL(result.structuredContent.viewUrl).pathname.replace('/view/', '/api/view/');
  const original = await visit(bucket, 'user-a', path); const etag = original.headers.get('etag');
  const expiresAt = [...bucket.objects.values()][0].customMetadata.expiresAt;
  assert.equal((await save(bucket, null, path, '# Edit', etag)).status, 401);
  assert.equal((await save(bucket, 'user-b', path, '# Edit', etag)).status, 404);
  assert.equal((await save(bucket, 'user-a', path, '# Edit', etag, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await save(bucket, 'user-a', path, '# Edit')).status, 428);
  const saved = await save(bucket, 'user-a', path, '# Edited', etag);
  assert.equal(saved.status, 200);
  const outcome = await saved.json(); assert.equal(outcome.outcome, 'saved');
  const reloaded = await visit(bucket, 'user-a', path);
  assert.equal(reloaded.headers.get('etag'), outcome.etag);
  assert.deepEqual(await reloaded.json(), { markdown: '# Edited', filename: 'Notes.md', canWrite: true, signInUrl: null });
  assert.equal([...bucket.objects.values()][0].customMetadata.expiresAt, expiresAt);
  assert.equal((await save(bucket, 'user-a', path, '# Stale', etag)).status, 409);
  assert.equal((await save(bucket, 'user-a', path, 'é'.repeat(1024 * 1024 + 1), outcome.etag)).status, 413);
  assert.equal((await save(bucket, 'user-a', path, '', outcome.etag)).status, 200);
});

test('concurrent writes use storage preconditions and expired originals cannot be saved', async () => {
  const bucket = new MemoryBucket();
  const result = (await (await call(bucket, 'user-a', 'pretty_md_render', { markdown: '# Original' })).json()).result;
  const path = new URL(result.structuredContent.viewUrl).pathname.replace('/view/', '/api/view/');
  const etag = (await visit(bucket, 'user-a', path)).headers.get('etag');
  const results = await Promise.all([save(bucket, 'user-a', path, '# A', etag), save(bucket, 'user-a', path, '# B', etag)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  [...bucket.objects.values()][0].customMetadata.expiresAt = String(Date.now() - 1);
  assert.equal((await save(bucket, 'user-a', path, '# Expired', etag)).status, 404);
});

test('host compression weak ETags do not cause false save conflicts', async () => {
  const bucket = new MemoryBucket();
  const result = (await (await call(bucket, 'user-a', 'pretty_md_render', { markdown: '# Original' })).json()).result;
  const path = new URL(result.structuredContent.viewUrl).pathname.replace('/view/', '/api/view/');
  const original = await visit(bucket, 'user-a', path);
  const version = original.headers.get('x-document-version');
  assert.equal(version, original.headers.get('etag'));
  // Production adds W/ to the standard response ETag; older open tabs echo it.
  const first = await save(bucket, 'user-a', path, '# First save', `W/${version}`);
  assert.equal(first.status, 200);
  const next = (await first.json()).etag;
  assert.equal((await save(bucket, 'user-a', path, '# Stale save', `W/${version}`)).status, 409);
  // New clients use the dedicated header, unaffected by response compression.
  const second = await save(bucket, 'user-a', path, '# Second save', 'W/"transformed-etag"', { 'x-document-version': next });
  assert.equal(second.status, 200);
  assert.equal((await (await visit(bucket, 'user-a', path)).json()).markdown, '# Second save');
});


test('legacy links retain owner-only access and local sign-in return paths', async () => {
  const bucket = new MemoryBucket();
  const id = '0123456789abcdef0123456789abcdef';
  await bucket.put(`views/${id}`, '# Legacy', { customMetadata: {
    owner: 'user-a', filename: 'Legacy.md', expiresAt: String(Date.now() + 60_000),
  } });
  const page = await visit(bucket, null, `/view/${id}`);
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), `/signin-with-chatgpt?return_to=%2Fview%2F${id}`);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const api = await visit(bucket, null, `/api/view/${id}`);
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('location'), null);
  for (const path of [`/view/${id}`, `/api/view/${id}`]) {
    assert.equal((await visit(bucket, 'user-b', path)).status, 404);
    assert.equal((await visit(bucket, 'user-a', path)).status, 200);
  }
  const data = await visit(bucket, 'user-a', `/api/view/${id}`);
  assert.equal((await data.json()).canWrite, true);
  assert.equal((await save(bucket, 'user-a', `/api/view/${id}`, '# Legacy edited', data.headers.get('etag'))).status, 200);
  assert.equal((await visit(bucket, null, `/api/view/${id}`)).status, 401, 'saving must not widen legacy access');
});

test('anonymous access respects expiry, invalid IDs and absent storage', async (t) => {
  const created = Date.now();
  let now = created;
  t.mock.method(Date, 'now', () => now);
  const bucket = new MemoryBucket();
  const result = (await (await call(bucket, 'user-a', 'pretty_md_render', { markdown: '# Public link' })).json()).result;
  const path = new URL(result.structuredContent.viewUrl).pathname;
  now = created + 24 * 60 * 60 * 1000 - 1;
  assert.equal((await visit(bucket, null, path)).status, 200);
  now++;
  assert.equal((await visit(bucket, null, path)).status, 404);
  for (const id of ['invalid', 'f'.repeat(32), 'x'.repeat(33)]) {
    for (const prefix of ['/view/', '/api/view/']) {
      const response = await visit(bucket, null, prefix + id);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('location'), null);
    }
  }
  assert.equal((await worker.fetch(new Request('https://pretty-md.example/view/' + 'f'.repeat(32)))).status, 404);
});
