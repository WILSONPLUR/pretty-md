import { Editor, Extension, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import { Marked } from 'marked';
const marked = new Marked();
import { renderMarkdown } from './markdown.js';

const RootIdentity = Extension.create({
  name: 'sourceIdentity',
  addGlobalAttributes() {
    return [{ types: ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'horizontalRule', 'table', 'protectedBlock'], attributes: { sourceId: { default: null, rendered: false } } }];
  },
});
const Protected = Node.create({
  name: 'protectedBlock', group: 'block', atom: true,
  addAttributes: () => ({ raw: { default: '' } }),
  parseHTML: () => [],
  renderHTML: () => ['div', { class: 'protected-block', contenteditable: 'false' }, 'Source preserved · unsupported Markdown'],
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div'); dom.className = 'protected-block';
      dom.contentEditable = 'false'; dom.title = 'Protected source: preserved unchanged';
      dom.append(renderMarkdown(node.attrs.raw).fragment);
      if (!dom.textContent.trim()) dom.textContent = 'Protected Markdown source';
      return { dom };
    };
  },
});
const SafeImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      dom.className = 'image-link editable-image';
      dom.textContent = `Image: ${node.attrs.alt || 'embedded image'} · select to replace`;
      return { dom };
    };
  },
}).configure({ inline: true, allowBase64: false });

// Keep raw spans for untouched roots. IDs survive transactions, splits and undo.
// A repeated ID (for example after a split) can reuse its raw span only once.
export function createRichDocument({ element, markdown, onChange, onSelection, assets = {} }) {
  const ledger = new Map();
  let sequence = 0;
  const editor = new Editor({
    injectCSS: false,
    element, extensions: [StarterKit.configure({ trailingNode: false, link: { openOnClick: false } }), Markdown, TableKit, TaskList, TaskItem.configure({ nested: true }), SafeImage.extend({
      addNodeView() { return ({ node }) => {
        const dom = document.createElement('span'); dom.className = 'image-link editable-image';
        const asset = assets[node.attrs.src];
        if (asset && /^image\/(png|jpeg|gif|webp)$/.test(asset.type)) {
          const img = document.createElement('img'); img.src = `data:${asset.type};base64,${asset.data}`; img.alt = node.attrs.alt || ''; dom.append(img);
        } else dom.textContent = `Image: ${node.attrs.alt || 'embedded image'} · select to replace`;
        return { dom };
      }; },
    }), RootIdentity, Protected],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: { attributes: { class: 'prose inline-document', 'aria-label': 'Edit document', role: 'textbox', 'aria-multiline': 'true' } },
    onUpdate: () => onChange(serialize()),
    onSelectionUpdate: () => onSelection?.(editor),
  });
  function load(source) {
    ledger.clear();
    const tokens = marked.lexer(source, { gfm: true });
    // marked normalizes line endings, so map token spans back to original bytes.
    const offsets = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\r' && source[i + 1] === '\n') i++;
      offsets.push(i + 1);
    }
    let cursor = 0;
    const definitions = tokens.filter(t => t.type === 'def').map(t => t.raw).join('\n');
    const nodes = [];
    let prefix = '';
    for (const token of tokens) {
      const raw = source.slice(offsets[cursor], offsets[cursor + token.raw.length]);
      cursor += token.raw.length;
      if (token.type === 'space') { prefix += raw; continue; }
      let parsed;
      if (['html', 'def'].includes(token.type) || /<\/?[A-Za-z][^>]*>/.test(token.raw)) parsed = [{ type: 'protectedBlock', attrs: { raw } }];
      else {
        try { parsed = editor.markdown.parse(token.raw.trimEnd() + (definitions ? `\n\n${definitions}` : '')).content; } catch {}
      }
      while (parsed?.length > 1 && parsed.at(-1).type === 'paragraph' && !parsed.at(-1).content?.length) parsed.pop();
      if (!parsed?.length) parsed = [{ type: 'protectedBlock', attrs: { raw } }];
      // Parsing one raw root into several roots is kept opaque rather than losing bytes.
      if (parsed.length !== 1) parsed = [{ type: 'protectedBlock', attrs: { raw } }];
      const node = parsed[0];
      const id = `source-${++sequence}`;
      node.attrs = { ...node.attrs, sourceId: id };
      ledger.set(id, { json: JSON.stringify(node), raw, prefix });
      nodes.push(node); prefix = '';
    }
    trailing = prefix;
    original = source;
    editor.chain().setContent({ type: 'doc', content: nodes.length ? nodes : [{ type: 'paragraph' }] }, { emitUpdate: false }).setMeta('addToHistory', false).run();
    for (const node of editor.getJSON().content || []) {
      const entry = ledger.get(node.attrs?.sourceId);
      if (entry) entry.json = JSON.stringify(node);
    }
    initial = JSON.stringify(editor.getJSON());
  }
  let trailing = '', original = '', initial = '';
  function serialize() {
    const json = editor.getJSON();
    if (JSON.stringify(json) === initial) return original;
    const used = new Set();
    return (json.content || []).map((node, index, nodes) => {
      const entry = ledger.get(node.attrs?.sourceId);
      const first = entry && !used.has(node.attrs.sourceId);
      if (entry) used.add(node.attrs.sourceId);
      if (first && JSON.stringify(node) === entry.json) return entry.prefix + entry.raw;
      const raw = node.type === 'protectedBlock' ? node.attrs.raw : editor.markdown.serialize({ type: 'doc', content: [node] });
      const newline = original.includes('\r\n') ? '\r\n' : '\n';
      const suffix = first ? entry.raw.match(/\s*$/)[0] : index < nodes.length - 1 ? newline + newline : '';
      return (first ? entry.prefix : index ? newline + newline : '') + raw.replace(/\r?\n/g, newline).replace(/\s*$/, '') + suffix;
    }).join('') + trailing;
  }
  load(markdown);
  return { editor, load, serialize, destroy: () => editor.destroy() };
}
