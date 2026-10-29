import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import dart from 'highlight.js/lib/languages/dart';
import diff from 'highlight.js/lib/languages/diff';
import { renderMarkdown, validateMarkdown, safeFileName, MAX_BYTES } from './markdown.js';
import { createEditor } from './editor.js';

for (const [name, language] of Object.entries({ javascript, typescript, python, json, bash, yaml, css, xml, sql, dart, diff })) hljs.registerLanguage(name, language);
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const scroller = $('scroll-area');
const drawerMedia = matchMedia('(max-width:900px)');
let current = null;
let sourceMode = false;
let readPosition = 0;
let sourcePosition = 0;
let hasDocumentTitle = false;
let headings = [];
let matches = [];
let matchIndex = -1;
let toastTimeout;
let searchTimeout;
let loadVersion = 0;
let highlightGeneration = 0;
let connected = false;
let pendingHostFile;
let hostResourceUri;
let loadingHostUri;
let removeUpdateHandler;
const standaloneViewId = location.pathname.match(/^\/view\/([A-Za-z0-9_-]{32})$/)?.[1];
let app;
let extensions;
let hostTheme;
let preferences = { fontSize: 17, fontFamily: 'sans', lineHeight: '1.8', codeWrap: false, theme: 'auto' };
try {
  const saved = JSON.parse(localStorage.getItem('pretty-md:preferences') || '{}');
  preferences = {
    fontSize: Number.isFinite(saved.fontSize) ? Math.max(14, Math.min(24, saved.fontSize)) : 17,
    fontFamily: saved.fontFamily === 'serif' ? 'serif' : 'sans',
    lineHeight: ['1.55', '1.8', '2'].includes(saved.lineHeight) ? saved.lineHeight : '1.8',
    codeWrap: saved.codeWrap === true,
    theme: ['auto', 'dark', 'light'].includes(saved.theme) ? saved.theme : 'auto',
  };
} catch {}

const editor = createEditor({
  window, toast, detach: detachResource, download: downloadDocument,
  onCommit: (document) => openDocument(document, true),
  onDraft: (document) => {
    current = { ...document };
    $('source').textContent = document.markdown;
    if (!editor.isEditing()) openDocument(document, true);
  },
  onMode: (editing) => {
    if (editing) {
      if (sourceMode) sourcePosition = scroller.scrollTop;
      else readPosition = scroller.scrollTop;
    }
    scroller.hidden = false;
    $('document').hidden = editing;
    $('source').hidden = true;
    $('source-label').hidden = true;
    if (editing) {
      closeSearch(); closeToc();
      closePopover('preferences', 'type-toggle'); closePopover('more-menu', 'more-toggle');
      root.dataset.view = 'edit';
      $('toc-toggle').disabled = true;
      $('reading-progress').hidden = true;
      for (const id of ['read-tab', 'source-tab']) { $(id).classList.remove('selected'); $(id).setAttribute('aria-pressed', 'false'); }
    } else setView(sourceMode, true);
  },
});

function toast(message, duration = 4500) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, duration);
}
function applyPreferences(save = false) {
  const theme = preferences.theme === 'auto' ? hostTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preferences.theme;
  root.dataset.theme = theme;
  // A manual override must not reuse a palette supplied for the host's other theme.
  root.dataset.hostPalette = String(connected && (preferences.theme === 'auto' || theme === hostTheme));
  root.style.setProperty('--font-size', `${preferences.fontSize}px`);
  root.style.setProperty('--leading', preferences.lineHeight);
  root.style.setProperty('--prose-font', preferences.fontFamily === 'serif' ? 'Georgia, "Times New Roman", serif' : 'var(--sans)');
  root.classList.toggle('wrap-code', preferences.codeWrap);
  $('font-size').textContent = preferences.fontSize;
  $('font-family').value = preferences.fontFamily;
  $('line-height').value = preferences.lineHeight;
  $('code-wrap').checked = preferences.codeWrap;
  $('font-smaller').disabled = preferences.fontSize <= 14;
  $('font-larger').disabled = preferences.fontSize >= 24;
  $('color-theme').value = preferences.theme;
  if (save) { try { localStorage.setItem('pretty-md:preferences', JSON.stringify(preferences)); } catch {} }
  requestAnimationFrame(() => { updateTableHints(); updateProgress(); });
}
function detachResource() {
  removeUpdateHandler?.();
  removeUpdateHandler = undefined;
  if (hostResourceUri && connected) extensions.resources?.unsubscribe({ uri: hostResourceUri }).catch(() => {});
  hostResourceUri = undefined;
  loadingHostUri = undefined;
  pendingHostFile = undefined;
}
function makeButton(label, handler) {
  const button = document.createElement('button');
  button.textContent = label;
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}
async function copyText(text, message = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Copy is unavailable in this host. Use Source to select text, or download the Markdown.');
  }
}
function decorateDocument() {
  const highlights = [];
  for (const pre of $('document').querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const raw = code.textContent;
    const language = Array.from(code.classList).find((name) => name.startsWith('language-'))?.slice(9) || 'text';
    if (raw.length < 30000 && hljs.getLanguage(language)) highlights.push({ code, raw, language });
    const shell = document.createElement('div');
    shell.className = 'code-block';
    const bar = document.createElement('div');
    bar.className = 'code-toolbar';
    const label = document.createElement('span');
    label.textContent = language;
    bar.append(label, makeButton('Copy', () => copyText(raw, 'Code copied')));
    pre.before(shell);
    shell.append(bar, pre);
  }
  for (const table of $('document').querySelectorAll('table')) {
    const shell = document.createElement('div');
    shell.className = 'table-shell';
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Markdown table; scroll horizontally for more columns');
    const hint = document.createElement('div');
    hint.className = 'table-hint';
    hint.textContent = 'Swipe or scroll to see all columns →';
    table.before(shell);
    scroll.append(table);
    shell.append(scroll, hint);
  }
  return highlights;
}
function highlightLater(highlights, generation, index = 0) {
  if (generation !== highlightGeneration) return;
  const started = performance.now();
  while (index < highlights.length && performance.now() - started < 8) {
    const { code, raw, language } = highlights[index++];
    if (code.isConnected) code.innerHTML = hljs.highlight(raw, { language, ignoreIllegals: true }).value;
  }
  if (index < highlights.length) setTimeout(() => highlightLater(highlights, generation, index), 0);
}
function updateTableHints() {
  for (const shell of document.querySelectorAll('.table-shell')) {
    const scroll = shell.querySelector('.table-scroll');
    shell.classList.toggle('is-wide', scroll.scrollWidth > scroll.clientWidth + 2);
  }
}
function renderToc() {
  $('toc').replaceChildren();
  if (!headings.length) {
    const text = document.createElement('p');
    text.className = 'muted sidebar-empty';
    text.textContent = 'This document has no headings.';
    $('toc').append(text);
    return;
  }
  for (const heading of headings) {
    const link = document.createElement('a');
    link.className = 'toc-link';
    link.href = `#${heading.id}`;
    link.dataset.depth = heading.level;
    link.textContent = heading.title || 'Untitled section';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      setView(false);
      const target = document.getElementById(heading.id);
      if (drawerMedia.matches) closeToc();
      if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth' });
      }
    });
    $('toc').append(link);
  }
}
function openDocument({ markdown, filename = 'Untitled.md', exported = false, assets = {} }, preservePosition = false) {
  validateMarkdown(markdown);
  const previousMode = preservePosition && sourceMode;
  if (preservePosition) {
    if (sourceMode) sourcePosition = scroller.scrollTop;
    else readPosition = scroller.scrollTop;
  } else {
    readPosition = sourcePosition = 0;
    closeSearch();
    closeToc();
  }
  const rendered = renderMarkdown(markdown, window, assets);
  current = { markdown, filename: safeFileName(filename), exported, assets };
  $('document').replaceChildren(rendered.fragment);
  hasDocumentTitle = Boolean($('document').querySelector('h1'));
  $('document-title').textContent = current.filename;
  headings = rendered.headings;
  const words = $('document').textContent.trim().split(/\s+/).filter(Boolean).length;
  const highlights = decorateDocument();
  const generation = ++highlightGeneration;
  renderToc();
  $('reader-empty').hidden = true;
  $('doc-container').hidden = false;
  $('filename').textContent = `${current.filename}${exported ? ' · downloaded copy' : ''}`;
  $('filename').title = current.filename;
  document.title = `${current.filename} · pretty-md`;
  $('source').textContent = '';
  $('word-count').textContent = `${words.toLocaleString()} words`;
  $('reading-time').textContent = `${Math.max(1, Math.ceil(words / 220))} min read`;
  for (const id of ['read-tab', 'source-tab', 'search-toggle', 'copy-markdown', 'download']) $(id).disabled = false;
  sourceMode = previousMode;
  setView(previousMode, true);
  updateSearch(false);
  requestAnimationFrame(() => { updateTableHints(); updateProgress(); setTimeout(() => highlightLater(highlights, generation), 0); });
}
function setView(isSource, restorePosition = false) {
  if (editor.isEditing()) { editor.setMode(false); if (editor.isEditing()) return; }
  const changed = sourceMode !== isSource;
  if (changed) {
    if (sourceMode) sourcePosition = scroller.scrollTop;
    else readPosition = scroller.scrollTop;
  }
  sourceMode = isSource;
  root.dataset.view = isSource ? 'source' : 'read';
  if (isSource && current && !$('source').textContent) $('source').textContent = current.markdown;
  $('document').hidden = isSource;
  $('source').hidden = !isSource;
  $('document-meta').hidden = isSource;
  $('source-label').hidden = !isSource;
  $('document-title').hidden = isSource || hasDocumentTitle;
  $('reading-progress').hidden = isSource || !current;
  $('toc-toggle').disabled = isSource || !current;
  $('read-tab').classList.toggle('selected', !isSource);
  $('source-tab').classList.toggle('selected', isSource);
  $('read-tab').setAttribute('aria-pressed', String(!isSource));
  $('source-tab').setAttribute('aria-pressed', String(isSource));
  if (isSource) {
    closeSearch();
    closeToc();
  }
  if (changed || restorePosition) scroller.scrollTop = isSource ? sourcePosition : readPosition;
  requestAnimationFrame(updateProgress);
}
function updateProgress() {
  if (sourceMode || editor.isEditing()) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  const percent = current ? (max <= 0 ? 100 : Math.max(0, Math.min(100, Math.round(scroller.scrollTop / max * 100)))) : 0;
  $('progress-label').textContent = `${percent}% read`;
  $('progress-fill').style.width = `${percent}%`;
  $('reading-progress').setAttribute('aria-valuenow', String(percent));
  $('reading-progress').setAttribute('aria-valuetext', `${percent}% read`);
  $('reading-progress').title = `${percent}% read`;
  let active = headings[0]?.id;
  const scrollTop = scroller.getBoundingClientRect().top;
  for (const heading of headings) {
    if (document.getElementById(heading.id)?.getBoundingClientRect().top <= scrollTop + 85) active = heading.id;
  }
  for (const link of $('toc').querySelectorAll('a')) {
    const selected = link.getAttribute('href') === `#${active}`;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
function clearMatches() {
  for (const mark of $('document').querySelectorAll('mark[data-search]')) mark.replaceWith(document.createTextNode(mark.textContent));
  $('document').normalize();
  matches = [];
  matchIndex = -1;
}
function updateSearch(jump = true) {
  clearMatches();
  const query = $('find-input').value.trim();
  if (query && current) {
    const walker = document.createTreeWalker($('document'), NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement.closest('.code-toolbar,script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const text = node.textContent;
      const lower = text.toLocaleLowerCase();
      const needle = query.toLocaleLowerCase();
      let start = 0;
      let found = lower.indexOf(needle);
      if (found < 0) continue;
      const fragment = document.createDocumentFragment();
      while (found >= 0 && matches.length < 1000) {
        fragment.append(document.createTextNode(text.slice(start, found)));
        const mark = document.createElement('mark');
        mark.dataset.search = 'true';
        mark.textContent = text.slice(found, found + query.length);
        fragment.append(mark);
        matches.push(mark);
        start = found + query.length;
        found = lower.indexOf(needle, start);
      }
      fragment.append(document.createTextNode(text.slice(start)));
      node.replaceWith(fragment);
    }
  }
  matchIndex = matches.length ? 0 : -1;
  showMatch(jump);
}
function showMatch(jump = true) {
  for (let i = 0; i < matches.length; i++) matches[i].classList.toggle('current', i === matchIndex);
  $('find-count').textContent = $('find-input').value.trim() ? (matches.length ? `${matchIndex + 1} / ${matches.length}${matches.length === 1000 ? '+' : ''}` : 'No matches') : '';
  $('find-prev').disabled = $('find-next').disabled = !matches.length;
  if (jump && matchIndex >= 0) matches[matchIndex].scrollIntoView({ block: 'center' });
}
function moveMatch(direction) {
  if (!matches.length) return;
  matchIndex = (matchIndex + direction + matches.length) % matches.length;
  showMatch();
}
function openSearch() {
  if (!current) { toast('Open a document to search its contents.'); return; }
  if (drawerMedia.matches) closeToc();
  closePopover('preferences', 'type-toggle');
  closePopover('more-menu', 'more-toggle');
  setView(false);
  $('find-bar').hidden = false;
  $('search-toggle').setAttribute('aria-expanded', 'true');
  $('find-input').focus();
}
function closeSearch(restoreFocus = false) {
  const wasOpen = !$('find-bar').hidden;
  clearTimeout(searchTimeout);
  $('find-bar').hidden = true;
  $('search-toggle').setAttribute('aria-expanded', 'false');
  $('find-input').value = '';
  clearMatches();
  if (restoreFocus && wasOpen) $('search-toggle').focus();
  updateProgress();
}
function closeToc(restoreFocus = false) {
  const wasOpen = !$('sidebar').hidden;
  root.classList.remove('toc-open');
  $('sidebar').hidden = true;
  $('sidebar').inert = true;
  $('sidebar').removeAttribute('role');
  $('sidebar').removeAttribute('aria-modal');
  $('toc-backdrop').hidden = true;
  $('toc-toggle').setAttribute('aria-expanded', 'false');
  $('toc-toggle').setAttribute('aria-label', 'Show contents');
  $('main-panel').inert = false;
  $('reader-toolbar').inert = false;
  if (restoreFocus && wasOpen) $('toc-toggle').focus();
  requestAnimationFrame(() => { updateTableHints(); updateProgress(); });
}
function openToc() {
  if (!current || sourceMode) return;
  closePopover('preferences', 'type-toggle');
  closePopover('more-menu', 'more-toggle');
  root.classList.add('toc-open');
  $('sidebar').hidden = false;
  $('sidebar').inert = false;
  $('toc-backdrop').hidden = !drawerMedia.matches;
  if (drawerMedia.matches) {
    $('sidebar').setAttribute('role', 'dialog');
    $('sidebar').setAttribute('aria-modal', 'true');
    $('main-panel').inert = true;
    $('reader-toolbar').inert = true;
  }
  $('toc-toggle').setAttribute('aria-expanded', 'true');
  $('toc-toggle').setAttribute('aria-label', 'Hide contents');
  $('toc-close').focus();
  requestAnimationFrame(() => { updateTableHints(); updateProgress(); });
}
function closePopover(id, toggleId, restoreFocus = false) {
  const wasOpen = !$(id).hidden;
  $(id).hidden = true;
  $(toggleId).setAttribute('aria-expanded', 'false');
  if (restoreFocus && wasOpen) $(toggleId === 'type-toggle' ? 'more-toggle' : toggleId).focus();
}
function openPopover(id, toggleId, last = false) {
  closePopover('preferences', 'type-toggle');
  closePopover('more-menu', 'more-toggle');
  $(id).hidden = false;
  $(toggleId).setAttribute('aria-expanded', 'true');
  const controls = $(id).querySelectorAll('button:not(:disabled),select,input');
  (last ? controls[controls.length - 1] : controls[0])?.focus();
}
function openPaste() {
  closePopover('more-menu', 'more-toggle', true);
  $('paste-dialog').showModal();
  $('paste-text').focus();
}

$('open-file').addEventListener('click', () => { closePopover('more-menu', 'more-toggle', true); $('file-input').click(); });
$('empty-open').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_BYTES) throw new Error('Open a Markdown file smaller than 2 MB.');
    if (!/\.(md|markdown|mdown|mkd)$/i.test(file.name)) throw new Error('Choose a Markdown file (.md, .markdown, .mdown, or .mkd).');
    if (!editor.confirmReplace()) return;
    const version = ++loadVersion;
    const revision = editor.revision();
    const markdown = await file.text();
    validateMarkdown(markdown);
    if (version === loadVersion) {
      if (revision !== editor.revision() && !editor.confirmReplace()) return;
      detachResource();
      openDocument({ markdown, filename: file.name });
      editor.load(current);
    }
  } catch (error) { toast(error.message); }
  event.target.value = '';
});
for (const id of ['paste-open', 'empty-paste']) $(id).addEventListener('click', openPaste);
$('paste-close').addEventListener('click', () => $('paste-dialog').close());
$('paste-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    validateMarkdown($('paste-text').value);
    if (!editor.confirmReplace()) return;
    ++loadVersion;
    detachResource();
    openDocument({ markdown: $('paste-text').value, filename: $('paste-filename').value });
    editor.load(current);
    $('paste-dialog').close();
    $('paste-text').value = '';
    closeToc();
  } catch (error) { toast(error.message); }
});
$('read-tab').addEventListener('click', () => setView(false));
$('source-tab').addEventListener('click', () => setView(true));
$('copy-markdown').addEventListener('click', () => {
  closePopover('more-menu', 'more-toggle', true);
  if (current) copyText(current.markdown, 'Markdown copied');
});
async function downloadDocument(document) {
    const mimeType = document.mimeType || 'text/markdown';
    const bytes = document.bytes;
    let blob;
    if (bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); blob = btoa(binary); }
    if (connected && app.getHostCapabilities()?.downloadFile) {
      const result = await app.downloadFile({ contents: [{ type: 'resource', resource: { uri: `file:///${encodeURIComponent(document.filename)}`, mimeType, ...(bytes ? { blob } : { text: document.markdown }) } }] });
      if (result?.isError) throw new Error('The host could not download this file.');
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes || document.markdown], { type: mimeType }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = document.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('download').addEventListener('click', async () => {
  closePopover('more-menu', 'more-toggle', true);
  if (!current) { toast('Open a document to download it.'); return; }
  try { await editor.download(); }
  catch { toast('Download is unavailable in this host. Use Copy Markdown or Source.'); }
});
$('search-toggle').addEventListener('click', () => $('find-bar').hidden ? openSearch() : closeSearch(true));
$('find-close').addEventListener('click', () => closeSearch(true));
$('find-input').addEventListener('input', () => { clearTimeout(searchTimeout); searchTimeout = setTimeout(updateSearch, 160); });
$('find-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } });
$('find-prev').addEventListener('click', () => moveMatch(-1));
$('find-next').addEventListener('click', () => moveMatch(1));
$('toc-toggle').addEventListener('click', () => $('sidebar').hidden ? openToc() : closeToc(true));
$('toc-close').addEventListener('click', () => closeToc(true));
$('toc-backdrop').addEventListener('click', () => closeToc(true));
$('type-toggle').addEventListener('click', () => $('preferences').hidden ? openPopover('preferences', 'type-toggle') : closePopover('preferences', 'type-toggle', true));
$('preferences-close').addEventListener('click', () => closePopover('preferences', 'type-toggle', true));
$('more-toggle').addEventListener('click', () => $('more-menu').hidden ? openPopover('more-menu', 'more-toggle') : closePopover('more-menu', 'more-toggle', true));
$('more-toggle').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openPopover('more-menu', 'more-toggle', event.key === 'ArrowUp');
  }
});
$('more-menu').addEventListener('keydown', (event) => {
  const items = Array.from($('more-menu').querySelectorAll('button:not(:disabled)'));
  const index = items.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    closePopover('more-menu', 'more-toggle');
    (event.shiftKey && !$('edit-toggle').disabled ? $('edit-toggle') : $('more-toggle')).focus();
  }
});
$('preferences').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const controls = Array.from($('preferences').querySelectorAll('button:not(:disabled),select,input'));
  if ((!event.shiftKey && document.activeElement === controls[controls.length - 1]) || (event.shiftKey && document.activeElement === controls[0])) {
    event.preventDefault();
    closePopover('preferences', 'type-toggle');
    $('more-toggle').focus();
  }
});
$('font-smaller').addEventListener('click', () => { preferences.fontSize = Math.max(14, preferences.fontSize - 1); applyPreferences(true); });
$('font-larger').addEventListener('click', () => { preferences.fontSize = Math.min(24, preferences.fontSize + 1); applyPreferences(true); });
$('font-family').addEventListener('change', (event) => { preferences.fontFamily = event.target.value; applyPreferences(true); });
$('line-height').addEventListener('change', (event) => { preferences.lineHeight = event.target.value; applyPreferences(true); });
$('code-wrap').addEventListener('change', (event) => { preferences.codeWrap = event.target.checked; applyPreferences(true); });
$('color-theme').addEventListener('change', (event) => { preferences.theme = event.target.value; applyPreferences(true); });
document.addEventListener('click', (event) => {
  if (!event.target.closest('#preferences,#type-toggle')) closePopover('preferences', 'type-toggle');
  if (!event.target.closest('#more-menu,#more-toggle')) closePopover('more-menu', 'more-toggle');
  const anchor = event.target.closest('#document a[href],#edit-preview a[href]');
  if (!anchor) return;
  if (anchor.getAttribute('href').startsWith('#')) {
    event.preventDefault();
    let id;
    try { id = decodeURIComponent(anchor.getAttribute('href').slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (target && ($('document').contains(target) || $('edit-preview').contains(target))) target.scrollIntoView({ block: 'start' });
  } else if (connected && app.getHostCapabilities()?.openLinks) {
    event.preventDefault();
    app.openLink({ url: anchor.href }).catch(() => toast('This host could not open the link.'));
  }
});
document.addEventListener('keydown', (event) => {
  const dialogOpen = Boolean(document.querySelector('dialog[open]'));
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && current && !dialogOpen && !editor.isEditing()) { event.preventDefault(); openSearch(); }
  if (event.key === 'Escape' && !dialogOpen) {
    if (!$('preferences').hidden) closePopover('preferences', 'type-toggle', true);
    else if (!$('more-menu').hidden) closePopover('more-menu', 'more-toggle', true);
    else if (!$('sidebar').hidden) closeToc(true);
    else closeSearch(true);
  }
  if (event.key === 'Tab' && drawerMedia.matches && !$('sidebar').hidden) {
    const controls = Array.from($('sidebar').querySelectorAll('button,a[href]'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
document.addEventListener('focusin', (event) => {
  if (!event.target.closest('#preferences,#type-toggle')) closePopover('preferences', 'type-toggle');
  if (!event.target.closest('#more-menu,#more-toggle')) closePopover('more-menu', 'more-toggle');
});
scroller.addEventListener('scroll', updateProgress, { passive: true });
drawerMedia.addEventListener('change', () => { closeToc(true); });
window.addEventListener('resize', () => { updateTableHints(); updateProgress(); });
matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => applyPreferences());

async function readHostDocument(file) {
    const result = await extensions.resources.read({ uri: file.resourceUri, representation: 'text' });
    const content = result.contents[0];
    if (!content) throw new Error('The host returned no file content.');
    let markdown;
    if ('text' in content) markdown = content.text;
    else if ('blob' in content) {
      if (content.blob.length > MAX_BYTES * 1.4) throw new Error('Open a Markdown file smaller than 2 MB.');
      markdown = new TextDecoder().decode(Uint8Array.from(atob(content.blob), (char) => char.charCodeAt(0)));
    } else throw new Error('The host returned unsupported file content.');
    validateMarkdown(markdown);
    return {
      document: { markdown, filename: safeFileName(file.name) },
      resource: {
        uri: file.resourceUri, ...content.openaiMetadata,
        read: () => readHostDocument(file),
        write: (options) => extensions.resources.write(file.resourceUri, options),
      },
    };
}
async function loadHostFile(file, preserve = false) {
  if (!connected) { pendingHostFile = file; return; }
  if (!extensions.resources) { toast('This host cannot read files directly. Use Open file or paste the Markdown.'); return; }
  if (!preserve && !editor.confirmReplace()) return;
  const version = ++loadVersion;
  const revision = editor.revision();
  loadingHostUri = file.resourceUri;
  try {
    const { document, resource } = await readHostDocument(file);
    if (version !== loadVersion || (preserve && hostResourceUri !== file.resourceUri)) return;
    if (!preserve && revision !== editor.revision() && !editor.confirmReplace()) return;
    if (preserve && editor.resourceUri() === file.resourceUri) editor.externalUpdate(document, resource);
    else {
      openDocument(document, preserve);
      editor.load(current, resource);
    }
    if (hostResourceUri !== file.resourceUri) {
      detachResource();
      hostResourceUri = file.resourceUri;
      removeUpdateHandler = extensions.resources.addUpdateHandler(async ({ params }) => {
        if (params.uri === hostResourceUri) await loadHostFile(file, true);
      });
      extensions.resources.subscribe({ uri: file.resourceUri }).catch(() => {});
    }
  } catch (error) { if (version === loadVersion) toast(`Unable to open this file: ${error.message}`); }
  finally { if (loadingHostUri === file.resourceUri) loadingHostUri = undefined; }
}
function receiveDocument(data) {
  if (!data || typeof data !== 'object') return;
  const markdown = typeof data.sourceMarkdown === 'string' ? data.sourceMarkdown : data.markdown;
  if (typeof markdown === 'string') {
    try {
      validateMarkdown(markdown);
      if (!editor.confirmReplace()) return;
      ++loadVersion;
      detachResource();
      openDocument({ markdown, filename: data.filename });
      editor.load(current);
    } catch (error) { toast(error.message); }
  } else if (data.file?.resourceUri && data.file?.name) {
    // File entrypoints send the same launch arguments and result; read only once.
    if (hostResourceUri !== data.file.resourceUri && loadingHostUri !== data.file.resourceUri && pendingHostFile?.resourceUri !== data.file.resourceUri) loadHostFile(data.file);
  }
}
applyPreferences();
closeToc();
async function readStandaloneDocument() {
  const uri = `/api/view/${standaloneViewId}`;
  const response = await fetch(uri, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 404 ? 'This document is unavailable or expired.' : 'Unable to load this document.');
  const document = await response.json();
  return { document, resource: {
    uri, writable: true, etag: response.headers.get('x-document-version') || response.headers.get('etag'), read: readStandaloneDocument,
    async write({ text, ifMatch }) {
      const result = await fetch(uri, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'text/markdown;charset=utf-8', 'if-match': ifMatch, 'x-document-version': ifMatch }, body: text });
      const data = await result.json();
      if (!result.ok && !['conflict', 'too-large'].includes(data.outcome)) throw new Error(data.error || 'Unable to save this document.');
      return data;
    },
  } };
}
async function loadStandaloneView() {
  try {
    const { document, resource } = await readStandaloneDocument();
    openDocument(document);
    editor.load(current, resource);
  } catch (error) {
    toast(error.message);
    $('reader-empty').querySelector('p').textContent = error.message;
  }
}
if (__EMBEDDED__) {
  Promise.all([import('@modelcontextprotocol/ext-apps'), import('@openai/mcp-extensions/app')]).then(async ([host, openai]) => {
    app = new host.App({ name: 'pretty-md', version: '0.4.10' }, { availableDisplayModes: ['fullscreen'] });
    extensions = new openai.OpenAIExtensions(app);
    app.ontoolresult = (result) => receiveDocument(result.structuredContent);
    app.ontoolinput = ({ arguments: args }) => {
      if (args?.file?.resourceUri && args.file?.name) receiveDocument({ file: args.file });
    };
    app.onhostcontextchanged = (context) => {
      if (context.theme) hostTheme = context.theme;
      if (context.styles?.variables) host.applyHostStyleVariables(context.styles.variables);
      applyPreferences();
    };
    app.onteardown = async () => { detachResource(); editor.dispose(); clearTimeout(toastTimeout); clearTimeout(searchTimeout); return {}; };
    await app.connect();
    connected = true;
    const context = app.getHostContext();
    hostTheme = context?.theme;
    if (context?.styles?.variables) host.applyHostStyleVariables(context.styles.variables);
    applyPreferences();
    if (pendingHostFile) { const file = pendingHostFile; pendingHostFile = undefined; await loadHostFile(file); }
    if (context?.displayMode !== 'fullscreen' && context?.availableDisplayModes?.includes('fullscreen')) {
      await app.requestDisplayMode({ mode: 'fullscreen' }).catch(() => {});
    }
  }).catch(() => toast('Unable to connect to the reader host. Reopen pretty-md in your chat.'));
} else if (standaloneViewId) {
  $('reader-empty').querySelector('p').textContent = 'Loading your document…';
  loadStandaloneView();
}
// Host-backed recovery waits for a fresh resource read to establish write access.
if (!standaloneViewId) {
  const record = editor.recovery();
  if (record && !record.uri) { openDocument(record.saved); editor.load(current); }
}
