import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { stat, readFile } from 'node:fs/promises';

const port = Number(process.env.PORT || 4317);
const documents = new Map();
const bucket = {
  async put(key, markdown, options) {
    if (options.onlyIf && documents.get(key)?.etag !== options.onlyIf.etagMatches) return null;
    const etag = crypto.randomUUID(); documents.set(key, { markdown, customMetadata: options.customMetadata, etag }); return { etag };
  },
  async get(key) {
    const document = documents.get(key);
    return document && { etag: document.etag, customMetadata: document.customMetadata, text: async () => document.markdown };
  },
  async delete(key) { documents.delete(key); },
  async list() {
    return { objects: Array.from(documents, ([key, value]) => ({ key, customMetadata: value.customMetadata })), truncated: false };
  },
};
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
      res.end(await readFile(new URL('./preview-host.html', import.meta.url), 'utf8'));
      return;
    }
    const file = resolve('worker/index.js');
    const worker = (await import(pathToFileURL(file).href + '?v=' + (await stat(file)).mtimeMs)).default;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers(req.headers);
    headers.set('oai-authenticated-user-id', 'local-preview');
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const response = await worker.fetch(request, { BUCKET: bucket }, {});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(error.message);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Local MCP App test host: http://127.0.0.1:${port}`));
