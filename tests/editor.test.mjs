import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createEditor } from '../src/editor.js';
import { MAX_BYTES } from '../src/markdown.js';

const template = await readFile(new URL('../src/reader.html', import.meta.url), 'utf8');
const flush = () => new Promise(setImmediate);
function setup(t, { markdown = '# Saved', storage, downloadError } = {}) {
  const dom = new JSDOM(template, { url: 'https://pretty-md.example/view/example' });
  const { window } = dom;
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0 });
  window.TextEncoder = TextEncoder;
  globalThis.window = window; globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement; globalThis.Node = window.Node;
  globalThis.getComputedStyle = window.getComputedStyle;
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  window.confirm = () => true;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  if (storage) Object.defineProperty(window, 'sessionStorage', { value: storage });
  const $ = (id) => window.document.getElementById(id);
  const commits = [], downloads = [], notices = [];
  let detached = false;
  const editor = createEditor({ window,
    onCommit: (doc) => commits.push(doc), onMode() {}, toast: (text) => notices.push(text),
    detach: () => { detached = true; },
    download: async (doc) => { if (downloadError) throw new Error(downloadError); downloads.push(doc); },
  });
  t.after(() => { editor.dispose(); dom.window.close(); });
  const doc = { markdown, filename: 'Notes.md' };
  const type = (value) => {
    editor.richEditor().commands.setContent(value, { contentType: 'markdown' });
  };
  return { $, window, editor, doc, type, commits, downloads, notices, detached: () => detached };
}

test('host Save asks every time and writes with the most recent etag', async (t) => {
  const s = setup(t), writes = [];
  s.editor.load(s.doc, { uri: 'host://notes', writable: true, etag: 'v1',
    write: async (value) => { writes.push(value); return { outcome: 'saved', etag: `v${writes.length + 1}` }; },
  });
  s.editor.setMode(true); s.type('# First edit');
  s.$('edit-save').click();
  assert.equal(s.$('save-dialog').open, true);
  assert.equal(writes.length, 0);
  s.$('save-original').click(); await flush();
  assert.deepEqual(writes, [{ text: '# First edit', ifMatch: 'v1' }]);
  assert.equal(s.commits.at(-1).markdown, '# First edit');
  assert.equal(s.editor.isDirty(), false);
  assert.equal(s.$('save-dialog').open, false);
  s.editor.setMode(true); s.type('# Second edit'); s.$('edit-save').click();
  assert.equal(s.$('save-dialog').open, true);
  s.$('save-original').click(); await flush();
  assert.equal(writes[1].ifMatch, 'v2');
});

test('Save as copy only downloads and keeps the original binding and draft', async (t) => {
  const s = setup(t);
  s.editor.load(s.doc, { uri: 'host://notes', writable: true, etag: 'v1' });
  s.editor.setMode(true); s.type('# Downloaded'); s.editor.setMode(false);
  assert.equal(s.$('save-toolbar').hidden, false);
  assert.equal(s.$('edit-save').textContent, 'Save changes');
  s.$('edit-save').click();
  s.$('save-copy').click(); await flush();
  assert.deepEqual(s.downloads, [{ markdown: '# Downloaded', filename: 'Notes.md' }]);
  assert.equal(s.commits.length, 0);
  assert.equal(s.editor.resourceUri(), 'host://notes');
  assert.equal(s.detached(), false);
  assert.equal(s.editor.isDirty(), true);
  assert.equal(s.$('save-dialog').open, false);
  assert.match(s.$('draft-notice').textContent, /Unsaved/);
});

test('read-only files and writable files without etags export without writing', async (t) => {
  for (const resource of [null, { uri: 'host://notes', writable: false, etag: 'v1' }, { uri: 'host://notes', writable: true }]) {
    const s = setup(t);
    s.editor.load(s.doc, resource); s.editor.setMode(true); s.type('# Copy');
    s.$('edit-save').click(); s.$('save-copy').click(); await flush();
    assert.equal(s.$('save-dialog').open, false);
    assert.equal(s.downloads[0].markdown, '# Copy');
  }
});

test('Save automatically retries against the latest version without comparison UI', async (t) => {
  const s = setup(t), writes = [];
  const changed = { uri: 'host://notes', writable: true, etag: 'v2',
    write: async (value) => { writes.push(value); return { outcome: 'saved', etag: 'v3' }; },
  };
  s.editor.load(s.doc, { ...changed, etag: 'v1',
    write: async (value) => { writes.push(value); return { outcome: 'conflict', etag: 'v2' }; },
    read: async () => ({ document: { ...s.doc, markdown: '# Changed elsewhere' }, resource: changed }),
  });
  s.editor.setMode(true); s.type('# My draft'); s.$('edit-save').click(); s.$('save-original').click(); await flush();
  assert.equal(s.$('conflict-dialog'), null);
  assert.deepEqual(writes[1], { text: '# My draft', ifMatch: 'v2' });
  assert.equal(s.commits.at(-1).markdown, '# My draft');
});

test('external updates preserve drafts and Save automatically uses the latest version', async (t) => {
  const s = setup(t), writes = [];
  const resource = { uri: 'host://notes', writable: true, etag: 'v1',
    write: async options => { writes.push(options); return { outcome: 'saved', etag: 'v4' }; },
  };
  s.editor.load(s.doc, resource); s.editor.setMode(true); s.type('# My draft');
  s.editor.externalUpdate({ ...s.doc, markdown: '# Remote v2' }, { ...resource, etag: 'v2' });
  s.editor.externalUpdate({ ...s.doc, markdown: '# Remote v3' }, { ...resource, etag: 'v3' });
  assert.equal(s.editor.richEditor().getMarkdown(), '# My draft');
  assert.equal(s.commits.length, 0);
  s.$('edit-save').click(); s.$('save-original').click(); await flush();
  assert.deepEqual(writes, [{ text: '# My draft', ifMatch: 'v3' }]);
  assert.equal(s.commits.at(-1).markdown, '# My draft');
  assert.equal(s.editor.isDirty(), false);
  s.editor.externalUpdate({ ...s.doc, markdown: '# Remote v5' }, { ...resource, etag: 'v5' });
  assert.equal(s.commits.at(-1).markdown, '# Remote v5');
});

test('write failures and host size limits preserve the draft and offer export', async (t) => {
  for (const response of [new Error('Permission revoked'), { outcome: 'too-large', maxBytes: 100 }]) {
    const s = setup(t);
    s.editor.load(s.doc, { uri: 'host://notes', writable: true, etag: 'v1', write: async () => {
      if (response instanceof Error) throw response;
      return response;
    } });
    s.editor.setMode(true); s.type('# Keep me'); s.$('edit-save').click(); s.$('save-original').click(); await flush();
    assert.equal(s.editor.isDirty(), true);
    assert.equal(s.editor.richEditor().getMarkdown(), '# Keep me');
    assert.equal(s.$('save-error').hidden, false);
    assert.equal(s.commits.length, 0);
    s.$('save-copy').click(); await flush();
    assert.equal(s.downloads[0].markdown, '# Keep me');
  }
});

test('failed exports keep the draft and show errors in the open save dialog', async (t) => {
  const s = setup(t, { downloadError: 'Download refused' });
  s.editor.load(s.doc, { uri: 'host://notes', writable: true, etag: 'v1' });
  s.editor.setMode(true); s.type('# Keep me'); s.$('edit-save').click(); s.$('save-copy').click(); await flush();
  assert.equal(s.commits.length, 0);
  assert.equal(s.editor.isDirty(), true);
  assert.match(s.$('save-error').textContent, /Download refused/);
});

test('oversized UTF-8 drafts keep the last valid preview and cannot save', async (t) => {
  const s = setup(t);
  s.editor.load(s.doc); s.editor.setMode(true);
  s.type('é'.repeat(MAX_BYTES / 2 + 1));
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(s.$('edit-save').disabled, true);
  assert.match(s.$('edit-error').textContent, /too large/);
  assert.equal(s.$('inline-editor').textContent.length, MAX_BYTES / 2 + 1);
  assert.equal(s.editor.richEditor().getMarkdown().length, MAX_BYTES / 2 + 1);
  s.type(''); s.$('edit-save').click(); s.$('save-copy').click(); await flush();
  assert.equal(s.downloads[0].markdown, '');
});

test('recovery restores the matching draft, warns when storage fails, and clears on discard', (t) => {
  const s = setup(t);
  s.editor.load(s.doc); s.editor.setMode(true); s.type('# Recover me');
  const record = s.editor.recovery();
  assert.equal(record.draft, '# Recover me');
  s.editor.load(s.doc);
  assert.equal(s.editor.richEditor().getMarkdown(), '# Recover me');
  assert.equal(s.editor.isEditing(), true);
  s.$('edit-discard').click();
  assert.equal(s.editor.recovery(), null);
  const limited = setup(t, { storage: { getItem: () => null, setItem() { throw new Error('Quota exceeded'); }, removeItem() {} } });
  limited.editor.load(limited.doc); limited.type('# No storage');
  assert.match(limited.$('recovery-error').textContent, /recovery is unavailable/);
  assert.equal(limited.editor.isDirty(), true);
});

test('recovered host drafts compare against freshly read originals without trusting stored permissions', (t) => {
  const s = setup(t);
  s.editor.load(s.doc, { uri: 'host://notes', writable: true, etag: 'v1' }); s.type('# Recover');
  s.editor.load({ ...s.doc, markdown: '# New original' }, { uri: 'host://notes', writable: false, etag: 'v2' });
  s.$('edit-save').click();
  assert.equal(s.editor.richEditor().getMarkdown(), '# Recover');
  assert.equal(s.$('save-dialog').open, true);
  assert.equal(s.$('save-original').disabled, true);
});

test('close warnings and replacement guards protect edits, including pending writes', async (t) => {
  const s = setup(t);
  let finish;
  s.editor.load(s.doc, { uri: 'host://notes', writable: true, etag: 'v1', write: () => new Promise((resolve) => { finish = resolve; }) });
  s.editor.setMode(true); s.type('# Pending');
  const event = new s.window.Event('beforeunload', { cancelable: true });
  s.window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  s.window.confirm = () => false;
  assert.equal(s.editor.confirmReplace(), false);
  s.$('edit-save').click(); s.$('save-original').click();
  assert.equal(s.editor.richEditor().isEditable, false);
  assert.equal(s.editor.confirmReplace(), false);
  finish({ outcome: 'saved', etag: 'v2' }); await flush();
  assert.equal(s.editor.isDirty(), false);
});

test('editing a CRLF document preserves its line endings in the exported source', async (t) => {
  const s = setup(t, { markdown: '# Saved\r\n\r\nBody\r\n' });
  s.editor.load(s.doc); s.editor.setMode(true);
  const e = s.editor.richEditor(); e.commands.insertContentAt({ from: 8, to: 12 }, 'Changed');
  s.$('edit-save').click(); s.$('save-copy').click(); await flush();
  assert.equal(s.downloads[0].markdown, '# Saved\r\n\r\nChanged\r\n');
});

test('no-op is byte exact; changing one root preserves other roots and mixed newlines', (t) => {
  const markdown = '# Title\r\n\r\nUntouched  **bold**\n\n<!-- private comment -->\r\n\r\nChange me\r\n\r\n[ref]: https://example.com\n';
  const s = setup(t, { markdown }); s.editor.load(s.doc);
  s.editor.setMode(true); s.editor.setMode(false);
  assert.equal(s.editor.isDirty(), false);
  const e = s.editor.richEditor();
  let position;
  e.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Change me') position = pos; });
  e.commands.insertContentAt({ from: position, to: position + 9 }, 'Changed');
  const draft = s.editor.recovery().draft;
  assert.equal(draft, markdown.replace('Change me', 'Changed'));
  e.commands.undo();
  assert.equal(s.editor.isDirty(), false);
});

test('table cell edits serialize as GFM and keep surrounding source', (t) => {
  const s = setup(t, { markdown: '# Keep  spacing\n\n| A | B |\n| --- | --- |\n| old | value |\n\n<!-- keep -->\n' });
  s.editor.load(s.doc);
  const e = s.editor.richEditor(); let position;
  e.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'old') position = pos; });
  e.commands.insertContentAt({ from: position, to: position + 3 }, 'new');
  const draft = s.editor.recovery().draft;
  assert.ok(draft.startsWith('# Keep  spacing\n\n'));
  assert.match(draft, /\| new\s*\| value/);
  assert.ok(draft.endsWith('<!-- keep -->\n'));
});

test('uploaded images export only referenced assets in a portable ZIP and block host writes', async (t) => {
  const { unzipSync, strFromU8 } = await import('fflate');
  const s = setup(t); s.editor.load(s.doc, { uri: 'host://notes', writable: true, etag: 'v1' });
  s.editor.setMode(true);
  s.window.document.querySelector('[data-command="image"]').click();
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = { type: 'image/png', size: bytes.length, arrayBuffer: async () => bytes.buffer };
  Object.defineProperty(s.$('image-upload'), 'files', { value: [file] });
  s.$('image-alt').value = 'Uploaded';
  s.$('image-form').dispatchEvent(new s.window.Event('submit', { cancelable: true })); await flush();
  assert.equal(s.$('image-dialog').open, false);
  assert.ok(s.$('inline-editor').querySelector('img[src^="data:image/png"]'));
  s.$('edit-save').click();
  assert.equal(s.$('save-original').disabled, true);
  s.$('save-copy').click(); await flush();
  assert.equal(s.downloads[0].mimeType, 'application/zip');
  const files = unzipSync(s.downloads[0].bytes);
  const paths = Object.keys(files);
  assert.equal(paths.length, 2);
  const path = paths.find(p => p.startsWith('images/'));
  assert.match(strFromU8(files['Notes.md']), new RegExp(path));
  assert.deepEqual(files[path], bytes);
});

test('repeated concurrent changes keep the draft and report a simple retry error', async (t) => {
  const s = setup(t); let count = 0;
  const resource = { uri: 'host://notes', writable: true, etag: 'v1',
    write: async () => { count++; return { outcome: 'conflict' }; },
    read: async () => ({ document: { ...s.doc, markdown: '# New version' }, resource: { ...resource, etag: `v${count + 1}` } }),
  };
  s.editor.load(s.doc, resource); s.type('# Keep this draft');
  s.$('edit-save').click(); s.$('save-original').click(); await flush();
  assert.equal(count, 3);
  assert.equal(s.editor.isDirty(), true);
  assert.equal(s.editor.richEditor().getMarkdown(), '# Keep this draft');
  assert.match(s.$('save-error').textContent, /Try Save again/);
  assert.equal(s.commits.length, 0);
});

test('automatic retry does not write after original permissions are revoked', async (t) => {
  const s = setup(t); let writes = 0;
  const resource = { uri: 'host://notes', writable: true, etag: 'v1',
    write: async () => { writes++; return { outcome: 'conflict' }; },
    read: async () => ({ document: { ...s.doc, markdown: '# New original' }, resource: { ...resource, writable: false, etag: 'v2' } }),
  };
  s.editor.load(s.doc, resource); s.type('# Draft'); s.$('edit-save').click(); s.$('save-original').click(); await flush();
  assert.equal(writes, 1); assert.equal(s.editor.isDirty(), true);
  assert.match(s.$('save-error').textContent, /no longer writable/);
});
