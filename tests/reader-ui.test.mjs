import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const [{ outputFiles }, template] = await Promise.all([
  build({ entryPoints: ['src/app.js'], bundle: true, write: false, format: 'iife', define: { __EMBEDDED__: 'false' } }),
  readFile(new URL('../src/reader.html', import.meta.url), 'utf8'),
]);
const html = template.replace('/* APP_SCRIPT */', () => outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));

function reader(t, { drawer = false, dark = false, standalone } = {}) {
  const media = new Map();
  const downloads = [], requests = [];
  const browser = new JSDOM(html, {
    url: 'https://pretty-md.example/' + (standalone ? 'view/' + 'a'.repeat(32) : ''),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      if (standalone) {
        window.fetch = async (uri, options) => {
          requests.push({ uri, options });
          return new Response(JSON.stringify({ filename: 'Shared.md', markdown: '# Shared', ...standalone }), {
            headers: { 'x-document-version': '"v1"' },
          });
        };
        window.Blob = Blob;
        window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:download'; };
        window.URL.revokeObjectURL = () => {};
        window.HTMLAnchorElement.prototype.click = function () {};
      }
      window.matchMedia = (query) => {
        query = query.replace(/\s/g, '');
        if (!media.has(query)) {
          const listeners = new Set();
          media.set(query, {
            matches: query.includes('max-width') ? drawer : query.includes('color-scheme') ? dark : false,
            addEventListener: (_, handler) => listeners.add(handler),
            set(matches) { this.matches = matches; for (const handler of listeners) handler(this); },
          });
        }
        return media.get(query);
      };
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    },
  });
  t.after(() => browser.window.close());
  const { window } = browser;
  const $ = (id) => window.document.getElementById(id);
  const key = (element, value, extra = {}) => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));
  const open = (markdown, filename = 'Notes.md') => {
    $('empty-paste').click();
    $('paste-filename').value = filename;
    $('paste-text').value = markdown;
    $('paste-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  };
  return { $, window, key, media, open, downloads, requests };
}

test('standalone link readers edit and download copies using server-provided save permissions', async (t) => {
  for (const signedIn of [false, true]) {
    const signInUrl = signedIn ? null : '/signin-with-chatgpt?return_to=%2Fview%2F' + 'a'.repeat(32);
    const { $, window, downloads, requests } = reader(t, { standalone: { canWrite: false, signInUrl } });
    await new Promise(resolve => window.setTimeout(resolve, 30));
    assert.equal($('edit-toggle').disabled, false);
    $('edit-toggle').click();
    $('inline-editor').querySelector('h1').firstChild.textContent = 'Edited copy';
    await new Promise(resolve => window.setTimeout(resolve, 30));
    $('edit-save').click();
    assert.equal($('save-dialog').open, true);
    assert.equal($('save-original').disabled, true);
    assert.equal($('save-signin').hidden, signedIn);
    if (!signedIn) {
      assert.equal($('save-signin-link').getAttribute('href'), signInUrl);
      assert.equal($('save-signin-link').target, '_top');
    }
    $('save-original').click();
    $('save-copy').click();
    await new Promise(resolve => window.setTimeout(resolve, 10));
    assert.equal(downloads.length, 1);
    assert.match(await downloads[0].text(), /# Edited copy/);
    assert.equal(requests.length, 1, 'local editing and downloading must not write to the API');
    assert.equal(requests[0].options.credentials, 'same-origin');
  }
});

test('standalone owners can save originals and see no sign-in prompt', async (t) => {
  const { $, window } = reader(t, { standalone: { canWrite: true, signInUrl: null } });
  await new Promise(resolve => window.setTimeout(resolve, 30));
  assert.equal($('edit-toggle').disabled, false);
  assert.equal($('save-original').disabled, false);
  assert.equal($('save-signin').hidden, true);
});

test('document actions enable on load and filename titles do not duplicate Markdown H1s', (t) => {
  const { $, open } = reader(t);
  for (const id of ['toc-toggle', 'read-tab', 'source-tab', 'search-toggle', 'copy-markdown', 'download']) assert.equal($(id).disabled, true);
  assert.equal($('sidebar').hidden, true);
  open('A document without a heading.', 'Plain.md');
  assert.equal($('document-title').hidden, false);
  assert.equal($('document-title').textContent, 'Plain.md');
  assert.equal($('reading-time').textContent, '1 min read');
  assert.equal($('word-count').textContent, '5 words');
  assert.equal($('copy-markdown').disabled, false);
  open('# A title\n\nBody.', 'Titled.md');
  assert.equal($('document-title').hidden, true);
  assert.equal($('document').querySelectorAll('h1').length, 1);
});

test('Read and Source preserve separate scroll positions and search keeps the current reading position', (t) => {
  const { $, open } = reader(t);
  const markdown = '# Title\n\n## Section\n\nSome text.';
  open(markdown);
  $('scroll-area').scrollTop = 320;
  $('search-toggle').click();
  assert.equal($('scroll-area').scrollTop, 320);
  $('source-tab').click();
  assert.equal($('source').textContent, markdown);
  assert.equal($('find-bar').hidden, true);
  assert.equal($('toc-toggle').disabled, true);
  assert.equal($('reading-progress').hidden, true);
  assert.equal($('scroll-area').scrollTop, 0);
  $('scroll-area').scrollTop = 80;
  $('read-tab').click();
  assert.equal($('scroll-area').scrollTop, 320);
  assert.equal($('reading-progress').hidden, false);
  $('source-tab').click();
  assert.equal($('scroll-area').scrollTop, 80);
  open('# Replacement');
  assert.equal($('source').hidden, true);
  assert.equal($('scroll-area').scrollTop, 0);
});

test('contents drawer manages modal focus and restores the trigger on dismissal', (t) => {
  const { $, window, key, open } = reader(t, { drawer: true });
  open('# Title\n\n## Second');
  $('toc-toggle').click();
  assert.equal($('sidebar').hidden, false);
  assert.equal($('sidebar').getAttribute('aria-modal'), 'true');
  assert.equal($('main-panel').inert, true);
  assert.equal(window.document.activeElement, $('toc-close'));
  key($('toc-close'), 'Tab', { shiftKey: true });
  assert.equal(window.document.activeElement, $('toc').lastElementChild);
  key(window.document.activeElement, 'Escape');
  assert.equal($('sidebar').hidden, true);
  assert.equal($('main-panel').inert, false);
  assert.equal(window.document.activeElement, $('toc-toggle'));
  $('toc-toggle').click();
  $('toc').lastElementChild.click();
  assert.equal($('sidebar').hidden, true);
  assert.equal(window.document.activeElement.id, 'pretty-md-heading-second');
  $('toc-toggle').click();
  key($('toc-close'), 'f', { ctrlKey: true });
  assert.equal($('sidebar').hidden, true);
  assert.equal($('main-panel').inert, false);
  assert.equal(window.document.activeElement, $('find-input'));
  $('find-close').click();
  $('empty-paste').click();
  key($('paste-text'), 'f', { ctrlKey: true });
  assert.equal($('find-bar').hidden, true, 'document search must not steal focus from the paste dialog');
});

test('menus support keyboard navigation and theme overrides survive system changes', (t) => {
  const { $, window, key, media } = reader(t);
  $('more-toggle').focus();
  key($('more-toggle'), 'ArrowDown');
  assert.equal(window.document.activeElement, $('type-toggle'));
  key($('type-toggle'), 'ArrowDown');
  assert.equal(window.document.activeElement, $('open-file'));
  key($('open-file'), 'ArrowDown');
  assert.equal(window.document.activeElement, $('paste-open'));
  key($('paste-open'), 'Escape');
  assert.equal($('more-menu').hidden, true);
  assert.equal(window.document.activeElement, $('more-toggle'));
  $('type-toggle').click();
  assert.equal($('preferences').hidden, false);
  $('color-theme').value = 'dark';
  $('color-theme').dispatchEvent(new window.Event('change', { bubbles: true }));
  media.get('(prefers-color-scheme:dark)').set(false);
  assert.equal(window.document.documentElement.dataset.theme, 'dark');
  assert.equal(JSON.parse(window.localStorage.getItem('pretty-md:preferences')).theme, 'dark');
  $('color-theme').value = 'auto';
  $('color-theme').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.document.documentElement.dataset.theme, 'light');
  media.get('(prefers-color-scheme:dark)').set(true);
  assert.equal(window.document.documentElement.dataset.theme, 'dark');
  $('color-theme').focus();
  key($('color-theme'), 'Tab');
  assert.equal($('preferences').hidden, true);
  assert.equal(window.document.activeElement, $('more-toggle'));
  $('more-toggle').click();
  key($('open-file'), 'Tab');
  assert.equal(window.document.activeElement, $('more-toggle'));
  $('type-toggle').click();
  key($('preferences-close'), 'Tab', { shiftKey: true });
  assert.equal(window.document.activeElement, $('more-toggle'));
});

test('toolbar has Search, Edit, More and edits stay visible in Read and Source', async (t) => {
  const { $, window, open } = reader(t);
  assert.deepEqual(Array.from(window.document.querySelector('.toolbar-actions').children, el => el.id), ['search-toggle', 'edit-toggle', 'more-toggle']);
  assert.equal($('type-toggle').parentElement, $('more-menu'));
  open('# Saved\n\nOriginal body.\n\n- [ ] Task\n\n| A | B |\n| --- | --- |\n| x | y |');
  $('edit-toggle').click();
  assert.equal($('scroll-area').hidden, false);
  assert.equal($('inline-editor').hidden, false);
  const heading = $('inline-editor').querySelector('h1');
  assert.ok(heading);
  // Exercise the real contenteditable input path.
  heading.firstChild.textContent = 'Draft';
  await new Promise(resolve => window.setTimeout(resolve, 30));
  $('read-tab').click();
  assert.equal($('editor').hidden, true);
  assert.equal($('save-toolbar').hidden, false);
  assert.equal($('edit-save').textContent, 'Save changes');
  assert.equal($('edit-save').disabled, false);
  assert.match($('document').textContent, /Draft/);
  assert.ok($('document').querySelector('input[type=checkbox]'));
  assert.ok($('document').querySelector('table'));
  assert.match($('draft-notice').textContent, /Unsaved/);
  $('source-tab').click();
  assert.match($('source').textContent, /# Draft/);
  assert.equal($('save-toolbar').hidden, false);
  assert.equal($('edit-save').closest('[hidden]'), null);
});
