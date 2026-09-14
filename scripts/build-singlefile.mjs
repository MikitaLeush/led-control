/* Regenerates the standalone ../../led-control.html from the src/ modules, so the
   "just open the file in Chrome" workflow keeps working after the code moved to
   ES modules. Not a bundler: the module graph here is a known, ordered list. */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Load each module and strip the module syntax. Order matters — these are
   concatenated into one classic script, so a module must come after whatever
   it references at load time. */
export async function inlineModules(paths) {
  const parts = [];
  for (const p of paths) {
    const src = await readFile(join(root, p), 'utf8');
    parts.push(src
      .replace(/^\s*import[^;]+;\s*$/gm, '')
      .replace(/^(\s*)export\s+(const|function|class|let)\s/gm, '$1$2 '));
  }
  return parts.join('\n');
}

const ORDER = ['src/protocol.js', 'src/transport.js', 'src/transport-web.js',
               'src/strip.js', 'src/ui.js', 'src/main.js'];

/* main.js resolves its transport with a dynamic import, which has nothing to
   resolve against once everything is one classic script. Hand it a factory
   instead — WebBluetoothTransport is already inlined above this point. */
const TRANSPORT_SHIM =
  '\nglobalThis.__LED_TRANSPORT__ = () => new WebBluetoothTransport();\n';

export async function buildScript() {
  const parts = [];
  for (const p of ORDER) {
    try { await readFile(join(root, p)); }
    catch { continue; }                    // not written yet — partial page is fine
    if (p === 'src/main.js') parts.push(TRANSPORT_SHIM);
    parts.push(await inlineModules([p]));
  }
  // main.js uses top-level await, which only modules allow. Wrap the lot.
  return '(async () => {\n' + parts.join('\n') + '\n})();';
}

export async function build() {
  const js   = await buildScript();
  const css  = await readFile(join(root, 'src/app.css'), 'utf8').catch(() => '');
  const html = await readFile(join(root, 'src/index.html'), 'utf8');

  const out = html
    .replace(/[ \t]*<link[^>]+app\.css[^>]*>\n?/, `<style>\n${css}\n</style>\n`)
    .replace(/[ \t]*<script type="module"[^>]*>\s*<\/script>\n?/,
             `<script>\n"use strict";\n${js}\n</script>\n`);

  await writeFile(join(root, '../../led-control.html'), out);
  return out.length;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href
    || process.argv[1]?.endsWith('build-singlefile.mjs')) {
  build().then(n => console.log('wrote ../../led-control.html,', n, 'bytes'));
}
