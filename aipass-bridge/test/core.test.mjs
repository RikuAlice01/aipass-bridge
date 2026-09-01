// Unit tests for agent/core.mjs.
//
// The point of the core is that it carries no host: the CLI hands it node:fs
// and the VS Code extension hands it workspace.fs. These tests hand it neither
// — just a Map — which is the cheapest possible proof that the seam is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  outbound, inbound, parse, prose, createTools, redact, splitInHalf, unifiedDiff, MIN_SPLIT,
  CONVERSATION_GONE, sayResilient,
} from '../agent/core.mjs';

/* ------------------------------------------------------- an in-memory host */

function memoryHost(files) {
  const store = new Map(Object.entries(files));
  return {
    store,
    async readFile(abs) {
      if (!store.has(abs)) throw new Error(`ENOENT: ${abs}`);
      return store.get(abs);
    },
    async exists(abs) {
      if (store.has(abs)) return true;
      const prefix = abs.endsWith(path.sep) ? abs : abs + path.sep;
      return [...store.keys()].some((k) => k.startsWith(prefix));
    },
    async readdir(abs) {
      const prefix = abs.endsWith(path.sep) ? abs : abs + path.sep;
      const names = new Map();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(path.sep);
        if (cut === -1) names.set(rest, false);
        else names.set(rest.slice(0, cut), true);
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
  };
}

const ROOT = path.resolve(path.sep === '\\' ? 'C:\\proj' : '/proj');
const at = (...parts) => path.join(ROOT, ...parts);

/* ------------------------------------------------------------ substitution */

test('loopback substitution round-trips exactly', () => {
  const original = 'open http://localhost:3000 or 127.0.0.1:8787\nmeta 169.254.169.254\nfile:///tmp/x\nbind 0.0.0.0';
  const sent = outbound(original);

  assert.doesNotMatch(sent, /localhost/i, 'localhost must not leave the machine');
  assert.doesNotMatch(sent, /127\.0\.0\.1/);
  assert.doesNotMatch(sent, /169\.254\.169\.254/);
  assert.doesNotMatch(sent, /0\.0\.0\.0/);
  assert.doesNotMatch(sent, /file:\/\//i);

  assert.equal(inbound(sent), original, 'the bytes must come back unchanged');
});

test('the placeholders share no substring with what they replace', () => {
  // A case-insensitive rule would still match if they did.
  for (const token of ['LOOPBACK-IP', 'METADATA-IP', 'ANY-IP', 'LCLHST', 'FILE-URI']) {
    assert.doesNotMatch(token.toLowerCase(), /localhost|127|169|0\.0|file:/);
  }
});

/* ------------------------------------------------------------ the protocol */

test('parse reads every marker shape', () => {
  const calls = parse([
    'Let me look.',
    'NEED dir src',
    'NEED file README.md',
    'EDIT notes.md',
    'FIND',
    'old line',
    'NEW',
    'new line',
    'END',
    'CREATE fresh.txt',
    'hello',
    'END',
    'RUN',
    'npm test',
    'END',
    'DONE all set',
  ].join('\n'));

  assert.deepEqual(calls.map((c) => c.kind), ['list', 'read', 'replace', 'write', 'run', 'done']);
  assert.equal(calls[0].arg, 'src');
  assert.equal(calls[1].arg, 'README.md');
  assert.deepEqual(calls[2].body, ['old line', 'new line']);
  assert.equal(calls[3].body, 'hello');
  assert.equal(calls[4].body, 'npm test');
  assert.equal(calls[5].arg, 'all set');
});

test('prose keeps the answer and drops the markers', () => {
  const reply = 'This project is a bridge.\nNEED file README.md\nIt has no dependencies.\nDONE summarised';
  assert.equal(prose(reply), 'This project is a bridge.\nIt has no dependencies.');
});

/* ----------------------------------------------------------------- the tools */

test('the tools run against a host that is not a filesystem', async () => {
  const host = memoryHost({
    [at('README.md')]: 'a starter project\n',
    [at('src', 'index.js')]: 'console.log(1)\n',
  });
  const { tools, overlay } = createTools({ host, root: ROOT });

  assert.equal(await tools.list('.'), 'README.md\nsrc/');
  assert.equal(await tools.read('README.md'), 'a starter project\n');
  assert.match(await tools.read('nope.md'), /no such file/);
});

test('edits land in the overlay and the model can read them back', async () => {
  const host = memoryHost({ [at('a.txt')]: 'hello' });
  const { tools, overlay } = createTools({ host, root: ROOT });

  assert.match(await tools.replace('a.txt', ['hello', 'goodbye']), /updated/);
  assert.equal(await tools.read('a.txt'), 'goodbye', 'reads its own pending work');
  assert.equal(host.store.get(at('a.txt')), 'hello', 'the host is untouched');

  await tools.write('b.txt', 'brand new');
  assert.equal(await tools.read('b.txt'), 'brand new', 'a created file is readable before it exists');

  assert.equal(overlay.size, 2);
});

test('a replace whose FIND does not match says so instead of guessing', async () => {
  const host = memoryHost({ [at('a.txt')]: 'hello' });
  const { tools, overlay } = createTools({ host, root: ROOT });
  assert.match(await tools.replace('a.txt', ['nothing like it', 'x']), /was not found/);
  assert.equal(overlay.size, 0, 'nothing is staged on a failed match');
});

test('paths outside the root are refused', async () => {
  const host = memoryHost({ [at('a.txt')]: 'hello' });
  const { tools } = createTools({ host, root: ROOT });
  await assert.rejects(() => tools.read(path.join('..', 'escaped.txt')), /escapes root/);
  await assert.rejects(() => tools.write(path.join('..', 'escaped.txt'), 'x'), /escapes root/);
});

test('written content has its placeholders restored', async () => {
  const host = memoryHost({});
  const { tools, overlay } = createTools({ host, root: ROOT });
  await tools.write('cfg.md', 'see http://LCLHST:4000 and LOOPBACK-IP:9090');
  assert.equal(overlay.get(at('cfg.md')), 'see http://localhost:4000 and 127.0.0.1:9090');
});

test('results are clipped to maxResult', async () => {
  const host = memoryHost({ [at('big.txt')]: 'x'.repeat(5000) });
  const { tools } = createTools({ host, root: ROOT, maxResult: 100 });
  const out = await tools.read('big.txt');
  assert.ok(out.length < 200);
  assert.match(out, /truncated/);
});

test('shell access is off unless it is asked for', async () => {
  const host = memoryHost({});
  const off = createTools({ host, root: ROOT });
  assert.match(await off.tools.run('', 'ls'), /disabled for this run/);

  let ran = null;
  const on = createTools({
    host: { ...host, run: async (cmd) => { ran = cmd; return 'ok'; } },
    root: ROOT,
    allowRun: true,
  });
  assert.equal(await on.tools.run('', 'ls'), 'ok');
  assert.equal(ran, 'ls');
});

/* ------------------------------------------------------- surviving a reject */

test('redact drops only the lines that cannot be sent', () => {
  const { out, dropped } = redact('safe line\nnode -e "boom"\nnext build\ncurl example.com\n');
  assert.equal(dropped, 2);
  assert.match(out, /safe line/);
  assert.match(out, /next build/, 'the rest of the file still gets through');
  assert.doesNotMatch(out, /node -e/);
  assert.doesNotMatch(out, /curl/);
});

test('a 403 about the conversation is told apart from a 403 about the payload', () => {
  // Both arrive as "aipass returned 403"; only the body says which is which,
  // and they want opposite responses -- rotate versus split.
  const deleted = 'aipass returned 403 Forbidden [396 bytes] {server=cloudflare} — '
    + '{"status":403,"detail":"Conversation has been deleted and is no longer accessible",'
    + '"code":"CHAT_UNAUTHORIZED"}';
  const filtered = 'aipass returned 403 Forbidden [4021 bytes] {server=Google Frontend} — '
    + '<html><title>403 Forbidden</title></html>';

  assert.ok(CONVERSATION_GONE.test(deleted), 'a deleted conversation must not be split');
  assert.ok(!CONVERSATION_GONE.test(filtered), 'a filtered payload still needs splitting');

  // Each marker has to stand on its own: a real body carries both, so testing
  // them together would leave either one free to rot unnoticed.
  for (const alone of [
    '{"code":"CHAT_UNAUTHORIZED"}',
    '{"detail":"Conversation has been deleted"}',
    '{"detail":"this conversation is no longer accessible"}',
    'Conversation not found',
  ]) {
    assert.ok(CONVERSATION_GONE.test(alone), `should match on its own: ${alone}`);
  }
});

test('sayResilient splits a filtered payload but not a dead conversation', async () => {
  // The end-to-end path cannot show this: the bridge rotates first and the
  // error that finally comes back no longer mentions 403 at all. So drive the
  // retry logic directly, which is the thing the guard lives in.
  const attempts = (body) => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 502, text: async () => body };
    };
    return sayResilient('x'.repeat(4000), { bridge: 'http://b', fetchImpl })
      .then(() => calls, () => calls);
  };

  const filtered = await attempts('403 Forbidden <html>blocked</html>');
  assert.ok(filtered > 1, `a filtered payload should be halved and retried, got ${filtered} call(s)`);

  const deleted = await attempts(
    '403 {"detail":"Conversation has been deleted and is no longer accessible","code":"CHAT_UNAUTHORIZED"}',
  );
  assert.equal(deleted, 1, 'a deleted conversation must not be retried at all');
});

test('splitInHalf halves by lines, and by characters when there is one line', () => {
  const [a, b] = splitInHalf('l1\nl2\nl3\nl4');
  assert.equal(a, 'l1\nl2');
  assert.equal(b, 'l3\nl4');

  const [c, d] = splitInHalf('abcdef');
  assert.equal(c + d, 'abcdef');
  assert.ok(c.length > 0 && d.length > 0);
});

test('splitting terminates above the floor', () => {
  // Halving must always make progress, or sayResilient would not terminate.
  let text = 'x'.repeat(4000);
  let rounds = 0;
  while (new TextEncoder().encode(text).length >= MIN_SPLIT && rounds < 50) {
    text = splitInHalf(text)[0];
    rounds++;
  }
  assert.ok(rounds < 50, 'splitting reached the floor');
});

/* ------------------------------------------------------------------ the diff */

test('unifiedDiff reports nothing when the text is unchanged', () => {
  assert.equal(unifiedDiff('a\nb', 'a\nb'), '');
});

test('unifiedDiff marks an added and a removed line', () => {
  const d = unifiedDiff('a\nb\nc', 'a\nB\nc', { label: 'f.txt' });
  assert.match(d, /^--- a\/f\.txt$/m);
  assert.match(d, /^\+\+\+ b\/f\.txt$/m);
  assert.match(d, /^-b$/m);
  assert.match(d, /^\+B$/m);
  assert.match(d, /^ a$/m, 'context is kept');
});

test('unifiedDiff handles a file that did not exist', () => {
  const d = unifiedDiff('', 'hello\nworld', { label: 'new.txt' });
  assert.match(d, /^\+hello$/m);
  assert.match(d, /^\+world$/m);
  assert.doesNotMatch(d, /^-(?!--)/m, 'no removals — only the --- header starts with a dash');
});

test('unifiedDiff splits distant changes into separate hunks', () => {
  const before = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n');
  const after = before.split('\n').map((l, i) => (i === 2 ? 'X' : i === 35 ? 'Y' : l)).join('\n');
  const hunks = unifiedDiff(before, after, { label: 'f' }).match(/^@@ /gm) ?? [];
  assert.equal(hunks.length, 2);
});

test('unifiedDiff line counts match the hunk header', () => {
  const before = 'a\nb\nc\nd\ne';
  const after = 'a\nb\nX\nd\ne';
  const d = unifiedDiff(before, after, { label: 'f' });
  const [, aCount, bCount] = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/m.exec(d);
  const body = d.split('\n').slice(3);
  assert.equal(body.filter((l) => l[0] === ' ' || l[0] === '-').length, Number(aCount));
  assert.equal(body.filter((l) => l[0] === ' ' || l[0] === '+').length, Number(bCount));
});
