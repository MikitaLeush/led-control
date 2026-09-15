/* Copy the two Capacitor runtime scripts into src/vendor/.

   There is no bundler in this project, and a WebView cannot resolve a bare
   specifier like '@capacitor-community/bluetooth-le'. Both packages ship an
   IIFE build meant for a plain <script> tag:

     @capacitor/core/dist/capacitor.js            → defines capacitorExports, Capacitor
     @capacitor-community/…/dist/plugin.js        → defines capacitorCommunityBluetoothLe

   Run before `cap sync`, so the copies are inside webDir when Capacitor mirrors
   it into the Android assets. src/vendor/ is generated and gitignored. */

import { mkdir, copyFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'src', 'vendor');

const FILES = [
  ['node_modules/@capacitor/core/dist/capacitor.js', 'capacitor.js'],
  ['node_modules/@capacitor-community/bluetooth-le/dist/plugin.js', 'bluetooth-le.js']
];

await mkdir(dest, { recursive: true });
for (const [from, to] of FILES) {
  const src = join(root, from);
  await stat(src);                       // fail loudly if the dependency moved
  await copyFile(src, join(dest, to));
  console.log('vendor →', to);
}
