import { validateMarkdown } from './markdown.js';
import { createRichDocument } from './rich-document.js';
import { zipSync, strToU8 } from 'fflate';

// Saved baseline and the visible draft are tracked separately.
export function createEditor({ window, onCommit, onDraft, onMode, download, detach, toast }) {
  const $ = (id) => window.document.getElementById(id);
  const storageKey = `pretty-md:draft:${window.location.pathname}`;
  let saved;
  let draft = '';
  let resource;
  let latest;
  let editing = false;
  let busy = false;
  let skipRecovery = false;
  let rich;
  let assets = {};
  let savedAssets = {};
  const hasAssets = () => Object.keys(assets).some(path => draft.includes(path));
  let valid = true;
  let revision = 0;
  const dirty = () => Boolean(saved && draft !== saved.markdown);
  const writable = () => { const target = latest?.resource || resource; return Boolean(target?.writable && target?.etag); };
  const message = (id, value = '') => { $(id).textContent = value; $(id).hidden = !value; };
  const clearRecovery = () => { try { window.sessionStorage.removeItem(storageKey); } catch {} };

  function persist() {
    if (!dirty()) { clearRecovery(); message('recovery-error'); return; }
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify({ saved, draft, assets, savedAssets, uri: resource?.uri }));
      message('recovery-error');
    } catch {
      // Never leave an older recovery record masquerading as the current draft.
      clearRecovery();
      message('recovery-error', 'Draft recovery is unavailable. Keep this tab open until you save or download your changes.');
    }
  }
  function recovery() {
    try {
      const record = JSON.parse(window.sessionStorage.getItem(storageKey));
      if (!record || typeof record.saved?.markdown !== 'string' || typeof record.saved?.filename !== 'string' || typeof record.draft !== 'string') return null;
      validateMarkdown(record.saved.markdown);
      return record;
    } catch { return null; }
  }
  function update() {
    $('edit-toggle').disabled = !saved;
    $('edit-toggle').setAttribute('aria-pressed', String(editing));
    $('edit-toggle').title = dirty() ? 'Edit Markdown · unsaved draft' : 'Edit Markdown';
    $('edit-save').disabled = busy || (!dirty() && !latest) || !valid;
    $('save-toolbar').hidden = !saved || !(editing || dirty() || latest || busy);
    $('edit-save').textContent = busy ? 'Saving…' : 'Save changes';
    $('edit-save').title = writable() ? 'Save changes to the original or download a copy' : hasAssets() ? 'Save a ZIP containing Markdown and uploaded images' : 'Save changes by downloading a Markdown copy';
    $('save-copy').textContent = hasAssets() ? 'Save as copy (ZIP)' : 'Save as copy';
    $('edit-discard').disabled = busy || (!dirty() && !latest);
    rich?.editor.setEditable(!busy, false);
    $('save-original').disabled = busy || hasAssets() || !writable();
    const signInUrl = (latest?.resource || resource)?.signInUrl;
    $('save-signin').hidden = writable() || !signInUrl;
    if (signInUrl) $('save-signin-link').setAttribute('href', signInUrl);
    else $('save-signin-link').removeAttribute('href');
    $('edit-status').textContent = busy ? 'Saving…' : dirty() ? 'Unsaved changes' : 'Markdown editor';
    message('draft-notice', !editing && dirty() ? 'Unsaved changes · save your changes or choose Edit to continue.' : '');
    for (const id of ['save-copy', 'save-close']) $(id).disabled = busy;
  }
  function preview() {
    try { validateMarkdown(draft); valid = true; message('edit-error'); }
    catch (error) { valid = false; message('edit-error', `${error.message} Your draft is kept; shorten it before saving.`); }
    update();
  }
  function mount() {
    rich?.destroy();
    rich = createRichDocument({ element: $('inline-editor'), markdown: draft, assets,
      onChange(value) { ++revision; draft = value; persist(); preview(); onDraft?.({ ...saved, markdown: draft, assets }); },
      onSelection(editor) { $('table-tools').hidden = !editor.isActive('table'); },
    });
  }
  function setMode(value) {
    if (!value && editing && !valid) { toast('Shorten the draft before leaving Edit mode. Your changes are kept.'); return; }
    editing = Boolean(value && saved);
    $('editor').hidden = !editing;
    onMode(editing);
    $('inline-editor').hidden = !editing;
    if (editing) { preview(); rich?.editor.commands.focus(undefined, { scrollIntoView: false }); }
    if (saved) onDraft?.({ ...saved, markdown: draft, assets });
    update();
  }
  function load(document, hostResource = null) {
    ++revision;
    const record = skipRecovery ? null : recovery();
    skipRecovery = false;
    saved = { ...document };
    resource = hostResource;
    latest = null;
    draft = saved.markdown; assets = {}; savedAssets = {};
    const sameSource = record && (resource ? record.uri === resource.uri : !record.uri && record.saved.filename === saved.filename && record.saved.markdown === saved.markdown);
    if (sameSource) {
      draft = record.draft; assets = record.assets || {}; savedAssets = record.savedAssets || {};
      if (resource && record.saved.markdown !== saved.markdown) latest = { document: saved, resource };
    }
    mount();
    persist();
    preview();
    setMode(Boolean(sameSource && dirty()));
  }
  function confirmReplace() {
    if (busy) { toast('Wait for the save to finish before opening another document.'); return false; }
    if (!dirty()) return true;
    if (!window.confirm('Discard your unsaved draft and open another document? Choose Cancel to keep editing and save it first.')) return false;
    skipRecovery = true;
    return true;
  }
  function externalUpdate(document, hostResource) {
    if (!saved || hostResource.uri !== resource?.uri) return;
    // Save notifications may arrive before the write response. Process them later.
    if (busy || dirty()) {
      latest = document.markdown !== saved.markdown ? { document, resource: hostResource } : null;
      if (!latest) resource = hostResource;
      update();
      return;
    }
    const wasEditing = editing;
    saved = { ...document }; resource = hostResource; draft = saved.markdown; latest = null;
    mount();
    onCommit(saved);
    preview(); setMode(wasEditing);
  }
  function commit(document, hostResource = resource) {
    ++revision;
    saved = { ...document, assets }; draft = saved.markdown; resource = hostResource; latest = null;
    mount();
    savedAssets = { ...assets };
    clearRecovery(); message('recovery-error');
    onCommit(saved);
    preview();
    for (const id of ['save-dialog']) if ($(id).open) $(id).close();
    setMode(false);
    $('edit-toggle').focus();
  }
  async function exportCopy() {
    if (busy) return;
    busy = true; update();
    try {
      validateMarkdown(draft);
      if (hasAssets()) {
        const files = { [saved.filename]: strToU8(draft) };
        for (const [path, asset] of Object.entries(assets)) if (draft.includes(path)) files[path] = Uint8Array.from(window.atob(asset.data), c => c.charCodeAt(0));
        await download({ filename: saved.filename.replace(/\.[^.]+$/, '') + '.zip', bytes: zipSync(files), mimeType: 'application/zip' });
      } else await download({ markdown: draft, filename: saved.filename });
      for (const id of ['save-dialog']) if ($(id).open) $(id).close();
      persist();
      toast('Downloaded copy · the original file is unchanged.', 2000);
    } catch (error) {
      const id = $('save-dialog').open ? 'save-error' : 'edit-error';
      message(id, `Unable to download: ${error.message}`);
    }
    finally { busy = false; update(); }
  }
  async function writeOriginal() {
    if (busy || !writable() || hasAssets()) return;
    let target = latest?.resource || resource;
    busy = true; update();
    let queuedUpdate;
    try {
      validateMarkdown(draft);
      // Save applies the user's visible draft. Refresh version preconditions and
      // retry automatically; never ask the user to compare Markdown sources.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!target?.writable || !target.etag || target.uri !== resource?.uri) throw new Error('The original is no longer writable. Save as copy to keep your changes.');
        const result = await target.write({ text: draft, ifMatch: target.etag });
        if (result.outcome === 'conflict') {
          const fresh = await target.read();
          if (fresh.resource?.uri !== resource?.uri) throw new Error('Unable to refresh the original. Your draft is kept.');
          latest = fresh; target = fresh.resource;
          if (fresh.document.markdown === draft) {
            commit({ markdown: draft, filename: saved.filename }, target);
            toast('Changes saved.'); return;
          }
          continue;
        }
        if (result.outcome === 'too-large') throw new Error(`The host allows files up to ${result.maxBytes.toLocaleString()} bytes. Save as copy or shorten the draft.`);
        if (result.outcome !== 'saved') throw new Error('The host did not confirm the save. Your draft is still available.');
        if (latest && latest.resource.etag !== target.etag && latest.resource.etag !== result.etag) queuedUpdate = latest;
        commit({ markdown: draft, filename: saved.filename }, { ...target, etag: result.etag });
        toast('Changes saved.'); return;
      }
      throw new Error('The document is still changing. Try Save again in a moment; your draft is kept.');
    } catch (error) {
      message('save-error', `Unable to save: ${error.message}`);
    } finally {
      busy = false;
      if (queuedUpdate) externalUpdate(queuedUpdate.document, queuedUpdate.resource);
      update();
    }
  }
  function save() {
    if ((!dirty() && !latest) || busy) return;
    preview();
    if (!valid) return;
    message('save-error', hasAssets() ? 'Uploaded images stay on this device. Save as copy downloads a ZIP containing the Markdown and images.' : !writable() ? 'Saving to the original is unavailable. Save as copy downloads the edited Markdown to your device.' : '');
    $('save-dialog').showModal();
  }
  $('edit-toggle').addEventListener('click', () => setMode(!editing));
  function imageDialog() {
    const selected = rich.editor.isActive('image');
    const attrs = selected ? rich.editor.getAttributes('image') : {};
    $('image-url').value = attrs.src || ''; $('image-alt').value = attrs.alt || '';
    $('image-upload').value = ''; $('image-remove').hidden = !selected;
    message('image-error'); $('image-dialog').showModal();
  }
  $('format-toolbar').addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
  $('format-toolbar').addEventListener('click', event => {
    const command = event.target.closest('[data-command]')?.dataset.command;
    if (!command || !rich || busy) return;
    if (command === 'link') {
      const href = window.prompt('Link URL (leave empty to remove)', rich.editor.getAttributes('link').href || 'https://');
      if (href === null) return;
      if (!href) rich.editor.chain().focus().extendMarkRange('link').unsetLink().run();
      else if (/^(https?:\/\/|mailto:|#)/i.test(href)) rich.editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
      else toast('Use an HTTP, mailto, or document anchor link.');
      return;
    }
    if (command === 'image') { imageDialog(); return; }
    const chain = rich.editor.chain().focus();
    if (command === 'heading') chain.toggleHeading({ level: 2 }).run();
    else chain[command]().run();
  });
  $('inline-editor').addEventListener('dblclick', () => { if (rich?.editor.isActive('image')) imageDialog(); });
  $('image-close').addEventListener('click', () => $('image-dialog').close());
  $('image-remove').addEventListener('click', () => { rich.editor.chain().focus().deleteSelection().run(); $('image-dialog').close(); });
  $('image-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      let src = $('image-url').value.trim();
      const file = $('image-upload').files[0];
      if (file) {
        const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
        if (!extensions[file.type]) throw new Error('Choose a PNG, JPEG, GIF or WebP image.');
        if (file.size > 5 * 1024 * 1024) throw new Error('Images must be smaller than 5 MB.');
        if (Object.values(assets).reduce((n, a) => n + a.size, 0) + file.size > 20 * 1024 * 1024) throw new Error('Uploaded images must total less than 20 MB.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        src = `images/${window.crypto.randomUUID()}.${extensions[file.type]}`;
        assets[src] = { data: window.btoa(binary), type: file.type, size: file.size };
      }
      if (!src || /^(?:[a-z]+:)/i.test(src) && !/^https?:\/\//i.test(src)) throw new Error('Use an HTTP image URL or a relative file path.');
      rich.editor.chain().focus().setImage({ src, alt: $('image-alt').value }).run();
      persist(); $('image-dialog').close();
    } catch (error) { message('image-error', error.message); }
  });
  $('edit-save').addEventListener('click', save);
  $('edit-discard').addEventListener('click', () => {
    if (!window.confirm('Discard your unsaved changes?')) return;
    if (latest) commit(latest.document, latest.resource);
    else { assets = { ...savedAssets }; commit(saved); }
  });
  $('save-copy').addEventListener('click', exportCopy);
  $('save-original').addEventListener('click', () => writeOriginal());
  for (const [dialog, close] of [['save-dialog', 'save-close']]) {
    $(close).addEventListener('click', () => $(dialog).close());
    $(dialog).addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
    $(dialog).addEventListener('close', () => { if (editing) rich?.editor.commands.focus(); });
  }
  const beforeUnload = (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  window.document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && saved) {
      event.preventDefault();
      if (!window.document.querySelector('dialog[open]')) save();
    }
  });
  return {
    load, setMode, confirmReplace, externalUpdate, recovery,
    isDirty: dirty, isEditing: () => editing, resourceUri: () => resource?.uri,
    revision: () => revision,
    richEditor: () => rich.editor,
    download: exportCopy,
    dispose() { rich?.destroy(); window.removeEventListener('beforeunload', beforeUnload); },
  };
}
