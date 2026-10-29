import { Marked } from 'marked';
const marked = new Marked();
import createDOMPurify from 'dompurify';

export const MAX_BYTES = 2 * 1024 * 1024;
export function validateMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new Error('Markdown must be text.');
  if (new TextEncoder().encode(markdown).byteLength > MAX_BYTES) throw new Error('This document is too large. Open a Markdown file smaller than 2 MB.');
  return markdown;
}
export function safeFileName(name = 'Untitled.md') {
  const clean = String(name).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return clean || 'Untitled.md';
}
export function renderMarkdown(markdown, browserWindow = window, assets = {}) {
  validateMarkdown(markdown);
  const purify = createDOMPurify(browserWindow);
  const html = marked.parse(markdown, { gfm: true, breaks: false });
  const template = browserWindow.document.createElement('template'); template.innerHTML = html;
  for (const img of template.content.querySelectorAll('img')) img.setAttribute('data-local-path', img.getAttribute('src') || '');
  const fragment = purify.sanitize(template.innerHTML, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'textarea', 'button', 'video', 'audio', 'source', 'link', 'meta'],
    FORBID_ATTR: ['style', 'srcset', 'src', 'id', 'name', 'autofocus', 'action', 'formaction'],
  });
  // Markdown is document data. Never execute instructions, scripts, or load remote images.
  for (const image of fragment.querySelectorAll('img')) {
    const placeholder = browserWindow.document.createElement('span');
    placeholder.className = 'image-link';
    placeholder.textContent = `Image: ${image.getAttribute('alt') || 'embedded image'} (not loaded)`;
    const asset = assets[image.getAttribute('data-local-path')];
    if (asset && /^image\/(png|jpeg|gif|webp)$/.test(asset.type)) {
      const local = browserWindow.document.createElement('img'); local.src = `data:${asset.type};base64,${asset.data}`; local.alt = image.getAttribute('alt') || ''; image.replaceWith(local);
    } else image.replaceWith(placeholder);
  }
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (!/^(https?:\/\/|mailto:|#)/i.test(href)) {
      link.removeAttribute('href');
      link.setAttribute('title', 'Relative links need the original repository or document location.');
    } else if (!href.startsWith('#')) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove();
    else input.disabled = true;
  }
  const used = new Set();
  const headingLinks = new Map();
  const headings = Array.from(fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((heading) => {
    const title = heading.textContent.trim();
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    let id = slug;
    let duplicate = 0;
    while (used.has(id)) id = `${slug}-${++duplicate}`;
    used.add(id);
    const readerId = `pretty-md-heading-${id}`;
    headingLinks.set(id, readerId);
    heading.id = readerId;
    return { id: readerId, title, level: Number(heading.tagName.slice(1)) };
  });
  for (const link of fragment.querySelectorAll('a[href^="#"]')) {
    let target;
    try { target = decodeURIComponent(link.getAttribute('href').slice(1)); } catch { continue; }
    if (headingLinks.has(target)) link.setAttribute('href', `#${headingLinks.get(target)}`);
    else link.removeAttribute('href');
  }
  return { fragment, headings };
}
