#!/usr/bin/env node
// Run the JS test suite against the Rust bridge.
//
// The point of this file is that there is no second suite. The harness starts
// whichever bridge AIPASS_TEST_BRIDGE names and drives it over the same HTTP
// surface, so the Rust port is held to the JS bridge's behaviour rather than
// to a description of it — including the CLI and VS Code tests, which never
// learn which implementation they are talking to.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const profile = process.argv.includes('--debug') ? 'debug' : 'release';
const exe = path.join(HERE, 'target', profile, process.platform === 'win32' ? 'aipass-bridge.exe' : 'aipass-bridge');

if (!fs.existsSync(exe)) {
  console.error(`no ${profile} binary at ${exe}\nbuild it first: npm run bridge:build`);
  process.exit(1);
}

const tests = path.join(HERE, '..', 'test');
const files = fs.readdirSync(tests).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(tests, f));

console.log(`running ${files.length} test files against the ${profile} Rust bridge`);
try {
  execFileSync(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    env: { ...process.env, AIPASS_TEST_BRIDGE: exe },
  });
} catch {
  process.exit(1);
}
