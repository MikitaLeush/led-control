/* The overlay bug: `.sheet { display: flex }` beat the UA's `[hidden] { display: none }`
   (same specificity, author wins), so el.hidden stopped hiding anything and a
   full-screen overlay ate every click. Guard the author-scope restatement. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/app.css', import.meta.url), 'utf8');

test('app.css restates [hidden] in author scope', () => {
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'without this, any class rule that sets display silently overrides el.hidden');
});

test('every rule that sets display on a class comes after the [hidden] guard', () => {
  const guard = css.search(/\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.ok(guard > -1, 'guard rule must exist');
  // !important beats later rules of equal specificity, so position does not
  // actually matter — but keeping the guard near the top documents the intent.
  const beforeGuard = css.slice(0, guard);
  assert.ok(!/^\s*\.[\w-]+\s*\{[^}]*display:/m.test(beforeGuard),
    'no display-setting class rules should precede the guard');
});
