import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--repository') throw new Error('Usage: npm run release:export -- --repository https://github.com/OWNER/REPO');
const repository = new URL(args[1]);
if (repository.protocol !== 'https:' || repository.hostname !== 'github.com' || repository.username || repository.password || repository.search || repository.hash || !/^\/[^/]+\/[^/]+(?:\.git)?$/.test(repository.pathname)) throw new Error('Provide a GitHub HTTPS repository URL without credentials.');
const url = repository.href.replace(/\.git$/, '').replace(/\/$/, '');
const target = resolve('output/github-release');
try { await access(target); throw new Error(`Release directory already exists: ${target}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const files = ['LICENSE', 'README.md', 'plugin.json', 'mcp.json', 'package.json', 'package-lock.json', 'agents', 'assets', 'hooks', 'skills', 'src', 'tests', 'docs'];
await mkdir(target, { recursive: true });
for (const file of files) await cp(file, resolve(target, file), { recursive: true, filter: path => !basename(path).startsWith('.') && basename(path) !== 'node_modules' });
await cp('.app.json', resolve(target, '.app.json'));
await mkdir(resolve(target, 'scripts'));
for (const file of ['build.mjs', 'dev.mjs', 'validate-artifact.mjs', 'preview-host.html', 'export-release.mjs']) await cp(`scripts/${file}`, resolve(target, 'scripts', file));
await mkdir(resolve(target, '.agents/plugins'), { recursive: true });
await cp('.agents/plugins/marketplace.json', resolve(target, '.agents/plugins/marketplace.json'));
await mkdir(resolve(target, '.openai'), { recursive: true });
await cp('.openai/hosting.example.json', resolve(target, '.openai/hosting.example.json'));
await writeFile(resolve(target, '.gitignore'), 'node_modules/\ndist/\nworker/\noutput/\n.env*\n!.env.example\n.openai/hosting.json\n.DS_Store\n');
const manifest = JSON.parse(await readFile(resolve(target, 'plugin.json'), 'utf8'));
manifest.repository = url;
manifest.homepage = url;
await writeFile(resolve(target, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Public source exported to ${target}. Inspect, build, and test it before pushing to ${url}.`);
