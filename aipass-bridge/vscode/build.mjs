#!/usr/bin/env node
// Stage agent/core.mjs inside the extension so a packaged .vsix carries it.
//
// Running from the repo, extension.js resolves ../agent/core.mjs and this
// script is not needed. Inside a .vsix that path is gone — everything above
// the extension root is left behind — so the file has to be copied in first.
// vsce runs this through the vscode:prepublish hook.
//
// The copy is a build artifact: gitignored, and `--check` proves it still
// matches the source so a stale one cannot be shipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = path.join(HERE, '..', 'agent', 'core.mjs');
const TARGET = path.join(HERE, 'agent', 'core.mjs');

const check = process.argv.includes('--check');

if (!fs.existsSync(SOURCE)) {
  console.error(`missing source: ${SOURCE}`);
  process.exit(1);
}

const source = fs.readFileSync(SOURCE);

if (check) {
  if (!fs.existsSync(TARGET)) {
    console.error('the staged copy is missing — run `npm run stage`');
    process.exit(1);
  }
  if (!fs.readFileSync(TARGET).equals(source)) {
    console.error('the staged copy is out of date — run `npm run stage`');
    process.exit(1);
  }
  console.log('staged copy matches agent/core.mjs');
  process.exit(0);
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, source);
console.log(`staged ${path.relative(HERE, TARGET).split(path.sep).join('/')} (${source.length} bytes)`);
