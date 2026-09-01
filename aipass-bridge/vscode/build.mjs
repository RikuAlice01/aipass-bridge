#!/usr/bin/env node
// Stage the files a packaged .vsix needs but cannot reach.
//
// Running from the repo, extension.js resolves ../agent/core.mjs and vsce
// finds nothing else it wants. Inside a .vsix everything above the extension
// root is left behind, so each of these has to be copied in first. vsce runs
// this through the vscode:prepublish hook.
//
// The copies are build artifacts: gitignored, and `--check` proves they still
// match their sources so a stale one cannot be shipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = path.join(HERE, '..', '..');

const STAGE = [
  // [ source, destination relative to the extension root ]
  [path.join(HERE, '..', 'agent', 'core.mjs'), 'agent/core.mjs'],
  [path.join(REPO, 'LICENSE'), 'LICENSE'],
];

const check = process.argv.includes('--check');
let failed = false;

for (const [source, rel] of STAGE) {
  const target = path.join(HERE, rel);

  if (!fs.existsSync(source)) {
    console.error(`missing source: ${source}`);
    process.exit(1);
  }
  const bytes = fs.readFileSync(source);

  if (check) {
    if (!fs.existsSync(target)) {
      console.error(`${rel} is not staged — run \`npm run stage\``);
      failed = true;
    } else if (!fs.readFileSync(target).equals(bytes)) {
      console.error(`${rel} is out of date — run \`npm run stage\``);
      failed = true;
    } else {
      console.log(`${rel} matches its source`);
    }
    continue;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  console.log(`staged ${rel} (${bytes.length} bytes)`);
}

process.exit(failed ? 1 : 0);
