import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineModules, buildScript } from '../scripts/build-singlefile.mjs';

test('inlining strips module syntax but keeps the code', async () => {
  const src = await inlineModules(['src/protocol.js']);
  assert.ok(!/^\s*import\s/m.test(src), 'no import statements survive');
  assert.ok(!/^\s*export\s+(const|function)/m.test(src), 'no export keywords survive');
  assert.match(src, /const PROFILES/, 'the declarations are still there');
  assert.match(src, /0x34, ?0x52, ?0x2A/, 'the AES key survives verbatim');
});

test('inlined source is valid standalone JavaScript', async () => {
  const src = await inlineModules(['src/protocol.js']);
  // Throws SyntaxError if stripping the module syntax broke the file.
  const fn = new Function(src + '\nreturn { PROFILES, hex, masterFrame };');
  const { PROFILES, hex } = fn();
  assert.equal(hex(PROFILES.lotus.power(true)), '7E 04 04 01 00 01 FF 00 EF',
               'the inlined copy emits the same bytes as the module');
});

test('the whole generated script parses as a classic script', async () => {
  // Catches top-level await and bare `import`, neither of which a classic
  // <script> allows — the module build hides both.
  const js = await buildScript();
  assert.doesNotThrow(() => new Function(js),
                      'generated script must be valid outside a module');
});

test('the generated script registers a transport factory for main.js', async () => {
  const js = await buildScript();
  assert.match(js, /__LED_TRANSPORT__\s*=\s*\(\)\s*=>\s*new WebBluetoothTransport/);
  assert.ok(!/\bawait import\(/.test(js.split('__LED_TRANSPORT__')[0]),
            'nothing before the shim relies on a dynamic import');
});
