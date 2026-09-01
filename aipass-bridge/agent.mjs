#!/usr/bin/env node
// Terminal front end for the agent.
//
// Everything interesting lives in agent/core.mjs, which knows nothing about a
// filesystem or a terminal. This file supplies both: node:fs as the host, and
// an ANSI printer that turns the core's event stream into the output you see.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runAgent, unifiedDiff } from './agent/core.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const task = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim();
const ROOT = path.resolve(flag('root', process.cwd()));
const BRIDGE = (flag('bridge', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const MODEL = flag('model', null);
const MAX_STEPS = Number(flag('max', 10));
const APPLY = has('apply');
const ALLOW_RUN = has('allow-run');
const MAX_RESULT = Number(flag('max-result', 3000));
const CONVERSATION = flag('conversation', null);
const REUSE = has('reuse');

if (!task) {
  console.error(`usage: npm run agent -- "<task>" [options]

  --root DIR      project root the agent may touch   (default: cwd)
  --model ID      model id                           (default: bridge default)
  --apply         write changes to disk              (default: dry run)
  --allow-run     let the agent run shell commands   (default: off)
  --max N         max steps                          (default: 10)
  --max-result N  truncate each tool result          (default: 3000 bytes)
  --reuse         continue the most recent conversation
  --conversation ID  continue a specific one`);
  process.exit(1);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

/* ----------------------------------------------------------------- the host */

const host = {
  async readFile(abs) { return fs.readFileSync(abs, 'utf8'); },
  async exists(abs) { return fs.existsSync(abs); },
  async readdir(abs) {
    return fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  },
  // execSync picks the platform shell, so this works on a stock Windows box
  // as well as it does under sh.
  async run(command, { cwd }) {
    try {
      return execSync(command, { cwd, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return `exit ${err.status}\n${String(err.stdout ?? '')}${String(err.stderr ?? '')}`;
    }
  },
};

/* ---------------------------------------------------------------- reporting */

function report(evt) {
  switch (evt.type) {
    case 'session':
      console.log(bold('task  ') + evt.task);
      console.log(bold('root  ') + evt.root);
      console.log(bold('mode  ') + (APPLY ? green('APPLY — files will be written') : 'dry run (pass --apply to write)'));
      console.log(bold('chat  ') + (evt.conversation ?? 'resolves on first message') + dim(`  (${evt.mode})`));
      break;
    case 'step':
      console.log(bold(`\n─── step ${evt.n}/${evt.total} ${'─'.repeat(40)}`));
      break;
    case 'reasoning':
      process.stdout.write(cyan(evt.text));
      break;
    case 'delta':
      process.stdout.write(dim(evt.text));
      break;
    case 'tool':
      console.log(`  ${evt.ok ? green('✓') : red('✗')} ${evt.kind} ${evt.arg} ${dim(evt.head)}`);
      break;
    case 'notice':
      console.log(dim(`  (${evt.text})`));
      break;
    case 'warn':
      console.log(red(`\n${evt.text}`));
      break;
    case 'rejected':
      console.error(red('\nthis fragment was rejected even on its own:\n') + dim(evt.text));
      break;
    case 'done':
      console.log(green(`\n✓ ${evt.summary}`));
      break;
    case 'cancelled':
      console.log(red('\ncancelled'));
      break;
    case 'error':
      console.error(red(`\n${evt.message}`));
      break;
    default:
      break;
  }
}

// The stream writes without newlines, so a step boundary needs one first.
let midLine = false;
const onEvent = (evt) => {
  if (evt.type === 'delta' || evt.type === 'reasoning') { midLine = true; }
  else if (midLine) { process.stdout.write('\n'); midLine = false; }
  report(evt);
};

/* ------------------------------------------------------------------ the run */

const { overlay } = await runAgent({
  task,
  root: ROOT,
  host,
  bridge: BRIDGE,
  model: MODEL,
  maxSteps: MAX_STEPS,
  maxResult: MAX_RESULT,
  allowRun: ALLOW_RUN,
  conversation: CONVERSATION,
  reuse: REUSE,
  onEvent,
});

if (midLine) process.stdout.write('\n');

/* --------------------------------------------------------------- the result */

if (!overlay.size) {
  console.log(dim('\nno file changes'));
} else {
  console.log(bold(`\n${overlay.size} file(s) changed:\n`));
  for (const [abs, next] of overlay) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    for (const line of unifiedDiff(before, next, { label: rel }).split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) console.log(green(line));
      else if (line.startsWith('-') && !line.startsWith('---')) console.log(red(line));
      else console.log(dim(line));
    }
  }
}

if (APPLY && overlay.size) {
  for (const [abs, text] of overlay) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  console.log(green(`\nwrote ${overlay.size} file(s) to disk`));
} else if (overlay.size) {
  console.log(dim('\ndry run — nothing written. re-run with --apply'));
}
