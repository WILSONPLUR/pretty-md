import { marked } from 'marked';

export const MAX_BYTES = 2 * 1024 * 1024;
export const PART_BYTES = 12000;
export const CONTENTS_SIZE = 50;
const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text).byteLength;

export class DocumentError extends Error {
  constructor(message, navigation = {}) {
    super(message);
    this.navigation = navigation;
  }
}

export function safeFileName(name = 'Untitled.md') {
  if (typeof name !== 'string' || name.length > 255) throw new DocumentError('filename must be a string of at most 255 characters.');
  return name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'Untitled.md';
}

function escapeText(text) {
  return text.replace(/[\\`*_{}\[\]()<>#!|~]/g, '\\$&');
}
function longestRun(text, pattern, minimum = 0) {
  let length = minimum;
  for (const match of text.matchAll(pattern)) length = Math.max(length, match[0].length);
  return length;
}
function inlineCode(text) {
  const fence = '`'.repeat(longestRun(text, /`+/g) + 1);
  return `${fence} ${text.replace(/\n/g, ' ')} ${fence}`;
}
function fencedCode(text, language = '') {
  const ticks = longestRun(text, /`+/g, 2);
  const tildes = longestRun(text, /~+/g, 2);
  const fence = (ticks <= tildes ? '`' : '~').repeat(Math.min(ticks, tildes) + 1);
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
}
function safeHref(href) {
  return typeof href === 'string' && /^(https?:\/\/|mailto:|#)/i.test(href) && !/[\u0000-\u0020\u007f]/.test(href);
}

// Serialize Markdown, not HTML. Untrusted markup is displayed as inert text;
// images never become image syntax, and reference links resolve on every part.
function inline(tokens = []) {
  return tokens.map((token) => {
    switch (token.type) {
      case 'image': return escapeText(`Image: ${token.text || 'embedded image'} (not loaded)`);
      case 'html': return inlineCode(token.raw);
      case 'link': {
        const label = inline(token.tokens);
        if (!safeHref(token.href)) return label;
        const href = token.href.replace(/[<>()[\]\\"`]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
        return `[${label}](${href})`;
      }
      case 'strong': return `**${inline(token.tokens)}**`;
      case 'em': return `*${inline(token.tokens)}*`;
      case 'del': return `~~${inline(token.tokens)}~~`;
      case 'codespan': return inlineCode(token.text);
      case 'text': return token.tokens ? inline(token.tokens) : token.raw;
      case 'escape': case 'br': return token.raw;
      default: return escapeText(token.raw || token.text || '');
    }
  }).join('');
}

function pipeCell(text) {
  let result = '';
  let slashes = 0;
  for (const char of text.replace(/\n/g, ' ')) {
    if (char === '|' && slashes % 2 === 0) result += '\\';
    result += char;
    slashes = char === '\\' ? slashes + 1 : 0;
  }
  return result;
}
function tableRow(cells) { return `| ${cells.map((cell) => pipeCell(inline(cell.tokens))).join(' | ')} |\n`; }
function tableHeader(token) {
  return tableRow(token.header) + `| ${token.align.map((align) => align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---').join(' | ')} |\n`;
}
function plainTitle(tokens = []) {
  return tokens.map((token) => token.tokens ? plainTitle(token.tokens) : token.text ?? token.raw ?? '').join('');
}
function renderBlock(token) {
  switch (token.type) {
    case 'space': case 'def': case 'checkbox': return '';
    case 'heading': return `${'#'.repeat(token.depth)} ${inline(token.tokens)}\n\n`;
    case 'paragraph': case 'text': return `${inline(token.tokens || marked.Lexer.lexInline(token.text || token.raw))}\n\n`;
    case 'hr': return '---\n\n';
    case 'html': return fencedCode(token.raw, 'html');
    case 'code': {
      const language = /^[\w+-]{1,80}$/.test(token.lang || '') ? token.lang : '';
      const info = token.lang && token.lang !== language ? `Code info: ${inlineCode(token.lang)}\n\n` : '';
      return info + fencedCode(token.text, language);
    }
    case 'blockquote': return token.tokens.map(renderBlock).join('').trimEnd().split('\n').map((line) => `> ${line}`).join('\n') + '\n\n';
    case 'list': return token.items.map((item, index) => {
      const marker = token.ordered ? `${Number(token.start) + index}. ` : '- ';
      const task = item.task ? `[${item.checked ? 'x' : ' '}] ` : '';
      const body = item.tokens.map(renderBlock).join('').trimEnd();
      const lines = body.split('\n');
      return marker + task + lines[0] + (lines.length > 1 ? '\n' + lines.slice(1).map((line) => ' '.repeat(marker.length) + line).join('\n') : '');
    }).join(token.loose ? '\n\n' : '\n') + '\n\n';
    case 'table': return tableHeader(token) + token.rows.map(tableRow).join('') + '\n';
    default: return fencedCode(token.raw || '', 'text');
  }
}

// Offsets refer to the original input, including CRLF. Normalization is only
// for the lexer; sourceRanges remain a lossless partition of the saved file.
function normalize(source) {
  const offsets = new Uint32Array(source.length + 1);
  const text = source.replace(/\r\n?/g, '\n');
  let index = 0;
  for (let i = 0; i < source.length; i++) {
    offsets[index++] = i;
    if (source[i] === '\r') {
      if (source[i + 1] === '\n') i++;
    }
  }
  offsets[index] = source.length;
  return { text, offsets };
}

function splitText(text, limit) {
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let size = 0;
    let lineEnd = start;
    while (end < text.length) {
      const point = text.codePointAt(end);
      const length = point > 0xffff ? 2 : 1;
      const count = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (size + count > limit) break;
      size += count;
      end += length;
      if (text[end - 1] === '\n') lineEnd = end;
    }
    if (end < text.length && lineEnd > start) end = lineEnd;
    parts.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return parts;
}

function fitPieces(raw, start, renderer, scaffold = []) {
  const units = [];
  function append(piece, offset) {
    const display = renderer(piece, offset);
    if (bytes(display) <= PART_BYTES) {
      units.push({ start: offset, end: offset + piece.length, markdown: display, scaffolding: scaffold });
      return;
    }
    const limit = Math.max(4, Math.floor(bytes(piece) / 2));
    const pieces = splitText(piece, limit);
    if (pieces.length < 2) throw new DocumentError('This Markdown block cannot be displayed within the part limit.');
    for (const chunk of pieces) append(chunk.text, offset + chunk.start);
  }
  for (const piece of splitText(raw, PART_BYTES - 1000)) append(piece.text, start + piece.start);
  return units;
}

function codeUnits(token, start) {
  const opening = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n/.exec(token.raw);
  let bodyStart = 0;
  let bodyEnd = token.raw.length;
  let language = '';
  if (opening) {
    bodyStart = opening[0].length;
    language = /^[\w+-]{1,80}$/.test(token.lang || '') ? token.lang : '';
    const char = opening[2][0];
    const close = new RegExp(`\\n {0,3}${char}{${opening[2].length},}[ \\t]*(?:\\n)?$`).exec(token.raw);
    if (close) bodyEnd = close.index + 1;
  }
  const units = [];
  if (opening && token.lang && token.lang !== language) {
    units.push(...fitPieces(token.raw.slice(0, bodyStart), start, (piece) => fencedCode(piece, 'text'), [{ kind: 'code-info-label' }]));
  }
  const body = token.raw.slice(bodyStart, bodyEnd);
  const indent = opening ? opening[1].length : 4;
  const chunks = fitPieces(body, start + bodyStart, (piece, offset) => {
    // A Unicode split in the middle of a code line must not remove spaces
    // that happen to begin the continuation fragment.
    const lineStart = offset === start + bodyStart || token.raw[offset - start - 1] === '\n';
    const lines = piece.split('\n');
    const text = indent ? lines.map((line, i) => (i || lineStart) ? line.replace(new RegExp(`^ {0,${indent}}`), '') : line).join('\n') : piece;
    return fencedCode(text, language);
  }, [{ kind: 'balanced-code-fences', language }]);
  if (!chunks.length) chunks.push({ start: start + bodyStart, end: start + bodyEnd, markdown: fencedCode('', language), scaffolding: [] });
  if (!units.length) chunks[0].start = start;
  chunks.at(-1).end = start + token.raw.length;
  return units.concat(chunks);
}

function linesWithOffsets(raw) {
  let start = 0;
  return (raw.match(/[^\n]*\n|[^\n]+$/g) || []).map((text) => {
    const line = { text, start, end: start + text.length };
    start = line.end;
    return line;
  });
}
function cellsWithOffsets(line) {
  const end = line.replace(/\n$/, '').length;
  const boundaries = [];
  let slashes = 0;
  for (let i = 0; i < end; i++) {
    if (line[i] === '|' && slashes % 2 === 0) boundaries.push(i);
    slashes = line[i] === '\\' ? slashes + 1 : 0;
  }
  const leading = boundaries[0] !== undefined && !line.slice(0, boundaries[0]).trim();
  const trailing = boundaries.at(-1) !== undefined && !line.slice(boundaries.at(-1) + 1, end).trim();
  const cuts = [0, ...boundaries.map((i) => i + 1), line.length];
  const cells = [];
  for (let i = leading ? 1 : 0; i < cuts.length - (trailing ? 2 : 1); i++) {
    cells.push({ start: cuts[i], end: cuts[i + 1], text: line.slice(cuts[i], cuts[i + 1]).replace(/\|$/, '').trim() });
  }
  if (cells.length) { cells[0].start = 0; cells.at(-1).end = line.length; }
  return cells;
}

function recordUnits(line, start, labels, rowNumber, links) {
  const units = [];
  const cells = cellsWithOffsets(line);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const label = escapeText(labels[i] || `Column ${i + 1}`);
    const prefix = `**Row ${rowNumber} · ${label}**\n\n`;
    const raw = line.slice(cell.start, cell.end);
    const display = prefix + safeBlocks(cell.text, links);
    if (bytes(display) <= PART_BYTES) units.push({ start: start + cell.start, end: start + cell.end, markdown: display, scaffolding: [{ kind: 'table-cell-label', row: rowNumber, column: i + 1 }] });
    else units.push(...fitPieces(raw, start + cell.start, (piece) => prefix + safeBlocks(piece, links), [{ kind: 'table-cell-label', row: rowNumber, column: i + 1 }]));
  }
  return units.length ? units : fitPieces(line, start, (piece) => safeBlocks(piece, links));
}

function tableUnits(token, start, links) {
  const lines = linesWithOffsets(token.raw);
  const header = tableHeader(token);
  const labels = token.header.map((cell) => plainTitle(cell.tokens).slice(0, 120));
  const units = [];
  let group;
  if (bytes(header) > PART_BYTES / 2) {
    // Very large headers cannot be repeated on every page. Display them once
    // as records and use numbered, bounded labels for subsequent rows.
    units.push(...recordUnits(lines[0].text, start, token.header.map((_, i) => `Header ${i + 1}`), 0, links));
    if (lines[1]) units.at(-1).end = start + lines[1].end;
  } else {
    group = { start, end: start + (lines[1]?.end ?? lines[0].end), markdown: header, scaffolding: [] };
  }
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    const row = token.rows[i - 2];
    const display = row ? tableRow(row) : safeBlocks(line.text, links);
    if (bytes(header) > PART_BYTES / 2 || bytes(header + display) > PART_BYTES || cellsWithOffsets(line.text).length > token.header.length) {
      if (group) { units.push(group); group = undefined; }
      units.push(...recordUnits(line.text, start + line.start, labels, i - 1, links));
    } else if (group && bytes(group.markdown + display) <= PART_BYTES) {
      group.markdown += display;
      group.end = start + line.end;
    } else {
      if (group) units.push(group);
      group = { start: start + line.start, end: start + line.end, markdown: header + display, scaffolding: [{ kind: 'repeated-table-header' }] };
    }
  }
  if (group) units.push(group);
  if (!units.length) return fitPieces(token.raw, start, (piece) => safeBlocks(piece, links));
  units[0].start = start;
  units.at(-1).end = start + token.raw.length;
  return units;
}

function safeBlocks(raw, links) {
  const lexer = new marked.Lexer({ gfm: true });
  if (links) lexer.tokens.links = links;
  return lexer.lex(raw).map(renderBlock).join('');
}

function containerUnits(token, start, links) {
  // Keep fenced-code context when splitting a large list or quote. Reparsing
  // a continuation without its opener would turn code into ordinary Markdown.
  const intervals = [];
  let fence;
  for (const line of linesWithOffsets(token.raw)) {
    const match = /^((?:[ \t]*>[ \t]?)*[ \t]*)(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})([^\n]*)(?:\n|$)/.exec(line.text);
    if (!match) continue;
    if (!fence) fence = { start: line.end, prefix: match[1], marker: match[2], info: match[3] };
    else if (match[2][0] === fence.marker[0] && match[2].length >= fence.marker.length && !match[3].trim()) {
      intervals.push({ ...fence, end: line.start });
      fence = undefined;
    }
  }
  if (fence) intervals.push({ ...fence, end: token.raw.length });
  return fitPieces(token.raw, start, (piece, offset) => {
    const begin = offset - start;
    const end = begin + piece.length;
    const inside = intervals.find((interval) => begin >= interval.start && begin < interval.end);
    const atEnd = intervals.find((interval) => end > interval.start && end <= interval.end);
    if (inside && end <= inside.end) {
      const lineStart = begin === inside.start || token.raw[begin - 1] === '\n';
      const text = piece.split('\n').map((line, i) => (i || lineStart) && line.startsWith(inside.prefix) ? line.slice(inside.prefix.length) : line).join('\n');
      return fencedCode(text, /^[\w+-]{1,80}$/.test(inside.info.trim()) ? inside.info.trim() : '');
    }
    const opener = inside ? `${inside.prefix}${inside.marker}${inside.info}\n` : '';
    const closer = atEnd ? `\n${atEnd.prefix}${atEnd.marker}\n` : '';
    return safeBlocks(opener + piece + closer, links);
  }, intervals.length ? [{ kind: 'balanced-code-fences-in-container' }] : []);
}

function buildUnits(tokens, text, scopeStart, scopeEnd) {
  const units = [];
  let cursor = 0;
  for (const token of tokens) {
    const start = text.indexOf(token.raw, cursor);
    if (start < 0) throw new DocumentError('Unable to locate a Markdown block in its source.');
    const end = start + token.raw.length;
    if (start > cursor && cursor >= scopeStart && start <= scopeEnd) units.push(...fitPieces(text.slice(cursor, start), cursor, (piece) => safeBlocks(piece, tokens.links)));
    cursor = end;
    if (start < scopeStart || end > scopeEnd) continue;
    const display = renderBlock(token);
    const extraCells = token.type === 'table' && linesWithOffsets(token.raw).slice(2).some((line) => cellsWithOffsets(line.text).length > token.header.length);
    if (extraCells) units.push(...tableUnits(token, start, tokens.links));
    else if (bytes(display) <= PART_BYTES) units.push({ start, end, markdown: display, scaffolding: [] });
    else if (token.type === 'code') units.push(...codeUnits(token, start));
    else if (token.type === 'html') units.push(...fitPieces(token.raw, start, (piece) => fencedCode(piece, 'html'), [{ kind: 'balanced-code-fences', language: 'html' }]));
    else if (token.type === 'table') units.push(...tableUnits(token, start, tokens.links));
    else if (token.type === 'list' || token.type === 'blockquote') units.push(...containerUnits(token, start, tokens.links));
    else units.push(...fitPieces(token.raw, start, (piece) => safeBlocks(piece, tokens.links)));
  }
  if (cursor < scopeEnd) units.push(...fitPieces(text.slice(Math.max(cursor, scopeStart), scopeEnd), Math.max(cursor, scopeStart), (piece) => safeBlocks(piece, tokens.links)));
  return units;
}

function paginate(units, forceSingle = false) {
  const pages = [];
  let page = { markdown: '', ranges: [], scaffolding: [] };
  for (const unit of units) {
    if (!forceSingle && page.ranges.length && bytes(page.markdown + unit.markdown) > PART_BYTES) {
      pages.push(page);
      page = { markdown: '', ranges: [], scaffolding: [] };
    }
    page.markdown += unit.markdown;
    page.ranges.push({ start: unit.start, end: unit.end });
    page.scaffolding.push(...unit.scaffolding);
  }
  if (page.ranges.length || !pages.length) pages.push(page);
  return pages;
}

export async function readDocument(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new DocumentError('Tool arguments must be an object.');
  if (Object.keys(args).some((key) => !['markdown', 'filename', 'view', 'part', 'section', 'expectedFingerprint'].includes(key))) throw new DocumentError('Supported arguments: markdown, filename, view, part, section, expectedFingerprint.');
  if (typeof args.markdown !== 'string') throw new DocumentError('markdown must contain the full Markdown text.');
  const size = bytes(args.markdown);
  if (size > MAX_BYTES) throw new DocumentError('Markdown exceeds the 2 MB UTF-8 limit.');
  const filename = safeFileName(args.filename);
  let view = args.view === undefined ? 'read' : args.view;
  const requestedPart = args.part === undefined ? 1 : args.part;
  if (!['read', 'contents'].includes(view)) throw new DocumentError('view must be read or contents.', { views: ['read', 'contents'] });
  if (!Number.isSafeInteger(requestedPart) || requestedPart < 1) throw new DocumentError('part must be a positive integer.', { firstPart: 1 });
  if (args.section !== undefined && (!Number.isSafeInteger(args.section) || args.section < 1)) throw new DocumentError('section must be a positive heading number.', { view: 'contents', part: 1 });
  if (args.expectedFingerprint !== undefined && (typeof args.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedFingerprint))) throw new DocumentError('expectedFingerprint must be a SHA-256 fingerprint returned by pretty-md.');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(args.markdown));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const changed = args.expectedFingerprint !== undefined && args.expectedFingerprint !== fingerprint;
  if (changed) view = 'read';
  const { text, offsets } = normalize(args.markdown);
  const tokens = marked.lexer(text, { gfm: true });
  const headings = [];
  let cursor = 0;
  for (const token of tokens) {
    const start = text.indexOf(token.raw, cursor);
    cursor = start + token.raw.length;
    if (token.type === 'heading') {
      const title = plainTitle(token.tokens);
      headings.push({ number: headings.length + 1, title: title.slice(0, 300), titleTruncated: title.length > 300, level: token.depth, start });
    }
  }
  const section = changed ? undefined : args.section;
  const part = changed ? 1 : requestedPart;
  if (section > headings.length) throw new DocumentError(`Section ${section} does not exist. Choose a heading number from Contents.`, { view: 'contents', part: 1, sectionCount: headings.length });
  const selected = section ? headings[section - 1] : undefined;
  const scopeStart = selected?.start ?? 0;
  const scopeEnd = selected ? (headings.slice(section).find((heading) => heading.level <= selected.level)?.start ?? text.length) : text.length;
  const contents = headings.map(({ start, ...heading }) => heading);
  const contentsParts = Math.max(1, Math.ceil(contents.length / CONTENTS_SIZE));
  const contentsPage = view === 'contents' ? part : 1;
  const visibleContents = contents.slice((contentsPage - 1) * CONTENTS_SIZE, contentsPage * CONTENTS_SIZE);
  let pages;
  if (view === 'contents') pages = Array.from({ length: contentsParts }, () => ({ markdown: '', ranges: [], scaffolding: [] }));
  else pages = paginate(buildUnits(tokens, text, scopeStart, scopeEnd), bytes(text.slice(scopeStart, scopeEnd)) <= PART_BYTES);
  if (part > pages.length) throw new DocumentError(`Part ${part} does not exist. Choose part 1–${pages.length}.`, { view, section: section ?? null, firstPart: 1, lastPart: pages.length, previous: pages.length });
  const page = pages[part - 1];
  return {
    delivery: 'chat', filename, fingerprint, view, section: section ?? null,
    markdown: page.markdown.trimEnd(), empty: !text.trim(), part, totalParts: pages.length,
    contents: visibleContents, contentsPart: contentsPage, contentsTotalParts: contentsParts, headingCount: headings.length,
    includeContents: view === 'contents' || (part === 1 && size > PART_BYTES),
    sourceRanges: page.ranges.map((range) => ({ start: offsets[range.start], end: offsets[range.end] })),
    displayScaffolding: page.scaffolding,
    navigation: { previous: part > 1 ? part - 1 : null, next: part < pages.length ? part + 1 : null, view, section: section ?? null, expectedFingerprint: fingerprint },
    sourceChanged: changed,
    notice: changed ? 'The document changed since the previous part. Reading restarted at part 1 of the whole document.' : null,
  };
}

export function chatResponse(document) {
  const lines = [`**${escapeText(document.filename)}** · ${document.view === 'contents' ? 'Contents page' : 'Part'} ${document.part} of ${document.totalParts}`, ''];
  if (document.notice) lines.push(document.notice, '');
  if (document.includeContents) {
    lines.push('**Contents**', '');
    for (const heading of document.contents) lines.push(`${heading.number}. ${escapeText(heading.title)}${heading.titleTruncated ? '…' : ''} (section ${heading.number})`);
    if (!document.contents.length) lines.push('This document has no headings. Read it by part number.');
    if (document.contentsTotalParts > document.contentsPart) lines.push('', `More headings: ask for contents page ${document.contentsPart + 1}.`);
    lines.push('');
  }
  if (document.view === 'read') lines.push(document.empty ? '*This document is empty.*' : document.markdown, '');
  const choices = [];
  if (document.navigation.previous) choices.push(`“previous” (${document.navigation.previous})`);
  if (document.navigation.next) choices.push(`“next” (${document.navigation.next})`);
  if (document.headingCount) choices.push('“section N” or a section name');
  if (choices.length) lines.push(`Continue with ${choices.join(', ')}.`);
  return lines.join('\n').trimEnd();
}
