import { build } from 'esbuild';
import { readFile, stat, mkdir, cp } from 'node:fs/promises';
import { Script } from 'node:vm';
import { gzipSync } from 'node:zlib';

const readerBuild = { entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'iife', target: ['es2022'], write: false, legalComments: 'none' };
const [standalone, embedded] = await Promise.all([
  build({ ...readerBuild, define: { __EMBEDDED__: 'false' } }),
  build({ ...readerBuild, define: { __EMBEDDED__: 'true' } }),
]);
const css = await build({ entryPoints: ['src/styles.css'], bundle: true, minify: true, write: false });
const html = await readFile('src/reader.html', 'utf8');
function readerHtml(bundle, embedded = false) {
  const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  new Script(script, { filename: 'pretty-md-reader.js' });
  return html.replace('__READER_SURFACE__', embedded ? 'embedded' : 'standalone')
    .replace('<!-- READER_FAVICON -->', embedded ? '' : '<link rel="icon" href="/assets/logo-v1.svg" type="image/svg+xml">')
    .replace('<!-- READER_BRAND -->', embedded ? '' : '<span class="brand"><img src="/assets/logo-v1.svg" alt="" width="20" height="20">pretty-md</span>')
    .replace('/* APP_STYLES */', () => css.outputFiles[0].text).replace('/* APP_SCRIPT */', () => script);
}
const standaloneHtml = readerHtml(standalone);
const embeddedHtml = readerHtml(embedded, true);
const standaloneJsGzip = gzipSync(standalone.outputFiles[0].contents).byteLength;
if (standaloneJsGzip > 230 * 1024) throw new Error(`Standalone reader JS exceeds 230 KB gzip budget (inline editor included): ${standaloneJsGzip} bytes.`);
await mkdir('worker', { recursive: true });
await build({
  entryPoints: ['src/worker.js'],
  loader: { '.svg': 'text', '.png': 'dataurl', '.md': 'text' },
  outfile: 'worker/index.js',
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022'],
  legalComments: 'none',
  banner: { js: `const APP_HTML = ${JSON.stringify(standaloneHtml)}; const EMBEDDED_HTML = ${JSON.stringify(embeddedHtml)};` },
});
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await cp('worker/index.js', 'dist/server/index.js');
try {
  await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('No local Sites binding: built for development without deployment metadata.');
}
console.log(`Built pretty-md: ${(Buffer.byteLength(standaloneHtml) / 1024).toFixed(0)} KB standalone (${(standaloneJsGzip / 1024).toFixed(0)} KB gzip JS), ${(Buffer.byteLength(embeddedHtml) / 1024).toFixed(0)} KB embedded + ${((await stat('worker/index.js')).size / 1024).toFixed(0)} KB MCP service.`);
