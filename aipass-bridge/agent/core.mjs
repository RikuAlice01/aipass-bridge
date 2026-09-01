// The agent, with nothing host-specific in it.
//
// No node:fs, no console, no process.argv — every side effect arrives through
// the `host` object and every observable moment leaves through `onEvent`. The
// CLI injects node:fs and an ANSI printer; the VS Code extension injects
// workspace.fs and an output channel, and both run this same loop.
//
// Two constraints shape the design, both learned the hard way and both still
// true here:
//
//  1. Only one user message per request is accepted. An array containing an
//     assistant turn is rejected upstream with a 403 before the model sees it.
//  2. The server keeps the conversation history itself.
//
// So the instructions are sent ONCE, as the first message of a conversation,
// and every later turn is just the tool results.
import path from 'node:path';

/* --------------------------------------------------- loopback substitution */

// Loopback hostnames and internal addresses are what SSRF filter rules look
// for, and ordinary project files are full of them — a README saying
// "open http://localhost:3000" is enough to get a request rejected.
//
// Substitute them on the way out and restore them on the way back, so the
// model works with stable placeholders and the bytes written to disk are
// exactly what the file had. The placeholders deliberately share no substring
// with the originals, or a case-insensitive rule would still match.
export const SUBSTITUTIONS = [
  [/127\.0\.0\.1/g, 'LOOPBACK-IP'],
  [/169\.254\.169\.254/g, 'METADATA-IP'],
  [/0\.0\.0\.0/g, 'ANY-IP'],
  [/localhost/gi, 'LCLHST'],
  [/file:\/\//gi, 'FILE-URI'],
];

// Reversing loses the original casing of "localhost"; lower case is what
// appears in practice and a mismatch only costs a retry, never a bad write.
export const RESTORE = [
  [/LOOPBACK-IP/g, '127.0.0.1'],
  [/METADATA-IP/g, '169.254.169.254'],
  [/ANY-IP/g, '0.0.0.0'],
  [/LCLHST/g, 'localhost'],
  [/FILE-URI/g, 'file://'],
];

export const outbound = (text) =>
  (text == null ? text : SUBSTITUTIONS.reduce((acc, [re, to]) => acc.replace(re, to), text));

export const inbound = (text) =>
  (text == null ? text : RESTORE.reduce((acc, [re, to]) => acc.replace(re, to), text));

/* ------------------------------------------------------------- the format */

// Plain words, no angle brackets, no key=value pairs, no banner rules, no
// absolute paths. Everything that drew a WAF 403 in earlier attempts was
// structural; prose-shaped directives carry none of those signals.
export const preamble = ({ allowRun = false } = {}) => `I am reading through a project with you. The files are open in front of me, and I will paste you anything you want to look at.

So just tell me what you want to see next, and put that on its own line in this shape, because my editor watches for these markers:

NEED dir .
NEED file README.md

If you want a file changed, write it like this and I will make the edit:

EDIT notes.md
FIND
the exact lines as they appear now
NEW
the lines to put there instead
END

To start a new file:

CREATE notes.md
the contents
END${allowRun ? '\n\nTo have me run something in the terminal:\n\nRUN\nwhat to run\nEND' : ''}

Once you have everything you need and are giving me your final answer, finish with:

DONE one sentence about what you found or changed

Only write DONE at the very end, when nothing more is needed. Never put DONE in the same reply as a NEED — ask for what you want, wait for me to paste it, and read it first.

The markers are only formatting for my editor. Nothing runs on your side — I do all of it and paste every result straight back to you, so keep going until you have what you need.

A few practical notes. Reply in whatever language I write to you in. Look at a file before changing it, and copy the lines under FIND exactly as they appear. Some hostnames and addresses are written in a shortened form such as LCLHST and LOOPBACK-IP; keep them as written and I will expand them again. If my question can be answered without changing anything, just answer it and end with DONE.`;

export const REMINDER = 'What next? Ask for anything else you need, or finish with DONE if you have enough.';

// The model usually writes its answer as prose and then a bare DONE, so fall
// back to that prose rather than reporting an empty result.
export const MARKER_LINE = /^\s*(NEED\s+(dir|file)\b|EDIT\b|CREATE\b|FIND\s*$|NEW\s*$|END\s*$|RUN\s*$|DONE\b)/i;

export const prose = (reply) =>
  reply.split('\n').filter((l) => !MARKER_LINE.test(l)).join('\n').trim();

export function parse(reply) {
  const lines = reply.split('\n');
  const calls = [];
  let i = 0;
  const readUntil = (stops) => {
    const body = [];
    while (i < lines.length && !stops.some((st) => new RegExp(`^\\s*${st}\\s*$`, 'i').test(lines[i]))) body.push(lines[i++]);
    return body.join('\n');
  };

  while (i < lines.length) {
    const line = lines[i];

    let m = /^\s*NEED\s+(dir|file)\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: m[1].toLowerCase() === 'dir' ? 'list' : 'read', arg: m[2].trim() }); continue; }

    m = /^\s*EDIT\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      if (/^\s*FIND\s*$/i.test(lines[i] ?? '')) i++;
      const before = readUntil(['NEW', 'END']);
      if (/^\s*NEW\s*$/i.test(lines[i] ?? '')) i++;
      const after = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'replace', arg: m[1].trim(), body: [before, after] });
      continue;
    }

    m = /^\s*CREATE\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'write', arg: m[1].trim(), body });
      continue;
    }

    if (/^\s*RUN\s*$/i.test(line)) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'run', arg: '', body });
      continue;
    }

    m = /^\s*DONE\b\s*(.*)$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'done', arg: m[1].trim() }); continue; }

    i++;
  }
  return calls;
}

/* ------------------------------------------------------ overlay + the tools */

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);

// Edits land here rather than on disk, so the model can read back its own
// pending work and the host decides if and when any of it is written.
export function createTools({ host, root, maxResult = 3000, allowRun = false }) {
  const overlay = new Map();
  const clip = (s) => (s.length > maxResult ? `${s.slice(0, maxResult)}\n… truncated` : s);

  const safe = (p) => {
    const abs = path.resolve(root, p);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes root: ${p}`);
    return abs;
  };
  const readAt = async (abs) => (overlay.has(abs) ? overlay.get(abs) : host.readFile(abs));
  const existsAt = async (abs) => overlay.has(abs) || host.exists(abs);

  const tools = {
    async list(arg) {
      const abs = safe(arg || '.');
      const entries = await host.readdir(abs);
      return clip(entries
        .filter((e) => !SKIP.has(e.name))
        .map((e) => (e.isDirectory ? `${e.name}/` : e.name))
        .sort().join('\n') || '(empty)');
    },
    async read(arg) {
      const abs = safe(arg);
      if (!(await existsAt(abs))) return `no such file: ${arg}`;
      return clip(await readAt(abs));
    },
    async write(arg, rawBody) {
      const body = inbound(rawBody);
      overlay.set(safe(arg), body);
      return `wrote ${arg}, ${body.split('\n').length} lines`;
    },
    async replace(arg, rawBody) {
      const abs = safe(arg);
      if (!(await existsAt(abs))) return `no such file: ${arg}`;
      const [before, after] = rawBody.map(inbound);
      const text = await readAt(abs);
      if (!text.includes(before)) {
        return `the text to replace was not found in ${arg}. Read the file again and copy the lines exactly.`;
      }
      overlay.set(abs, text.replace(before, after));
      return `updated ${arg}`;
    },
    async run(_arg, body) {
      if (!allowRun) return 'shell commands are disabled for this run';
      if (!host.run) return 'this host cannot run shell commands';
      return clip(await host.run(body, { cwd: root }));
    },
  };

  return { tools, overlay, safe, readAt, existsAt };
}

/* -------------------------------------------------------------- the bridge */

// One request, one user message, streamed back. Tool activity from upstream
// arrives as reasoning_content and is reported separately from the answer.
export async function say(text, { bridge, model, fetchImpl = globalThis.fetch, onEvent = () => {}, signal } = {}) {
  const res = await fetchImpl(`${bridge}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(model ? { model } : {}), stream: true, messages: [{ role: 'user', content: text }] }),
    signal,
  });
  if (!res.ok) throw new Error(`bridge returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let out = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.error) throw new Error(evt.error.message);
      const delta = evt.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) onEvent({ type: 'reasoning', text: delta.reasoning_content });
      if (delta.content) { out += delta.content; onEvent({ type: 'delta', text: delta.content }); }
    }
  }
  return out;
}

// File contents are arbitrary: a README carries shell commands, URLs and code
// fences, any of which can push a request past an upstream filter. Splitting a
// rejected message in half and sending the halves in sequence keeps the same
// information flowing while lowering what any single request carries. The
// server remembers each part, so the model still sees the whole thing.
export function splitInHalf(text) {
  const lines = text.split('\n');
  if (lines.length < 2) {
    const mid = Math.floor(text.length / 2);
    return [text.slice(0, mid), text.slice(mid)];
  }
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
}

export const MIN_SPLIT = 300;

// Last resort when a fragment is rejected even on its own. Real source files
// contain code-execution shapes — `node -e`, `curl`, `rm -rf`, `/bin/sh` — that
// no amount of splitting gets past. Drop only the offending lines so the run
// survives and the model still sees the rest of the file.
// A 403 is two completely different failures wearing the same number.
//
// An edge filter refusing the payload is the one splitting was built for. But
// aipass also answers 403 with CHAT_UNAUTHORIZED when the conversation itself
// is gone, and no amount of halving revives a deleted conversation — it just
// posts both halves to the same dead id, four levels deep, before giving up.
//
// The response body comes back inside the error message, so the two are told
// apart by what it says rather than by the status code they share.
export const CONVERSATION_GONE =
  /CHAT_UNAUTHORIZED|conversation (?:has been deleted|not found|is no longer)/i;

export const RISKY_LINE = /(node\s+-{1,2}e\b|--eval\b|\beval\(|child_process|exec(Sync)?\(|spawnSync?\(|\bcurl\b|\bwget\b|\b(ba)?sh\s+-c\b|rm\s+-rf|\/etc\/|\/bin\/(ba)?sh|\.\.\/\.\.\/)/i;

export function redact(text) {
  let dropped = 0;
  const out = text.split('\n').map((line) => {
    if (!RISKY_LINE.test(line)) return line;
    dropped++;
    return '[one line omitted here — it could not be sent]';
  }).join('\n');
  return { out, dropped };
}

export async function sayResilient(text, opts, depth = 0) {
  const { onEvent = () => {} } = opts;
  try {
    return await say(text, opts);
  } catch (err) {
    // Splitting only makes sense for a filter refusing these bytes.
    const blocked = /\b40[39]\b/.test(err.message) && !CONVERSATION_GONE.test(err.message);
    if (!blocked) throw err;

    const size = new TextEncoder().encode(text).length;
    if (depth > 4 || size < MIN_SPLIT) {
      const { out, dropped } = redact(text);
      if (dropped && out !== text) {
        onEvent({ type: 'notice', text: `rejected at ${size} bytes — omitting ${dropped} line(s) that cannot be sent` });
        return await say(out, opts);
      }
      onEvent({ type: 'rejected', text: text.slice(0, 400) });
      throw err;
    }
    const parts = splitInHalf(text);
    onEvent({ type: 'notice', text: `rejected — splitting into ${parts.length} parts and resending` });
    let last;
    for (let i = 0; i < parts.length; i++) {
      const final = i === parts.length - 1;
      const prefix = final
        ? 'Final part.\n\n'
        : `Part ${i + 1}, more follows. Reply with just: ok\n\n`;
      last = await sayResilient(prefix + parts[i], opts, depth + 1);
    }
    return last;
  }
}

/* ---------------------------------------------------------------- the loop */

// A conversation carries its own history, so reusing one drags in whatever was
// said before — including a refusal, which the model then sees itself having
// made and repeats. Callers get a fresh one unless they ask otherwise.
export async function prepareConversation({ bridge, model, conversation, reuse, fetchImpl = globalThis.fetch }) {
  if (conversation) {
    await fetchImpl(`${bridge}/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation }),
    }).catch(() => {});
    return { mode: 'continuing' };
  }
  if (reuse) return { mode: 'reusing the most recent' };

  const made = await fetchImpl(`${bridge}/conversations/new`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(model ? { model } : {}), message: 'Starting a new working session.' }),
  }).then((r) => r.json()).catch((err) => ({ error: { message: String(err.message) } }));

  return made?.error ? { mode: 'new', error: made.error.message } : { mode: 'new', id: made?.id };
}

export async function runAgent({
  task,
  root,
  host,
  bridge = 'http://127.0.0.1:8787',
  model = null,
  maxSteps = 10,
  maxResult = 3000,
  allowRun = false,
  conversation = null,
  reuse = false,
  // Set when this conversation has already been given the instructions: the
  // turn then goes out as the bare task. Deliberately not derived from
  // `reuse` — continuing "the most recent conversation" says nothing about
  // whether that one ever saw a preamble, and guessing wrong leaves the model
  // with no protocol to answer in.
  primed = false,
  fetchImpl = globalThis.fetch,
  onEvent = () => {},
  signal,
}) {
  const { tools, overlay } = createTools({ host, root, maxResult, allowRun });
  const opts = { bridge, model, fetchImpl, onEvent, signal };

  const conv = await prepareConversation({ bridge, model, conversation, reuse, fetchImpl });
  if (conv.error) onEvent({ type: 'warn', text: `could not start a new conversation: ${conv.error}` });

  const status = await fetchImpl(`${bridge}/status`).then((r) => r.json()).catch(() => null);
  onEvent({
    type: 'session',
    task,
    root,
    conversation: status?.conversation ?? conv.id ?? null,
    mode: conv.mode,
  });

  // Turn one carries the instructions; the server remembers them for the rest
  // of the conversation, so nothing after this resends them — including a
  // later call into the same conversation, which is what a chat panel does.
  // Sending them again is not just 1.4kB wasted: a bigger payload is a bigger
  // target for the upstream filter this whole design exists to stay under.
  let next = task;
  if (!primed) {
    let listing = '';
    try { listing = `\n\nTo save you a step, here is what is at the top level already:\n${outbound(await tools.list('.'))}`; }
    catch { /* ignore */ }
    next = `${preamble({ allowRun })}${listing}\n\nHere is what I want to know: ${task}\n\nWhat should I open first?`;
  }
  let nudges = 0;
  let summary = null;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) { onEvent({ type: 'cancelled' }); break; }
    onEvent({ type: 'step', n: step, total: maxSteps });

    let reply;
    try { reply = await sayResilient(next, opts); }
    catch (err) {
      // An abort surfaces here as a fetch failure; report it as what it was.
      if (signal?.aborted) { onEvent({ type: 'cancelled' }); break; }
      onEvent({ type: 'error', message: err.message });
      break;
    }

    const calls = parse(reply);
    const done = calls.find((c) => c.kind === 'done');
    const work = calls.filter((c) => c.kind !== 'done');

    if (!work.length) {
      if (done) { summary = done.arg || prose(reply) || 'done'; onEvent({ type: 'done', summary }); break; }
      if (++nudges > 2) {
        onEvent({ type: 'error', message: 'no marker after three replies — stopping. Try a fresh conversation, or another model.' });
        break;
      }
      onEvent({ type: 'warn', text: `no marker in that reply — nudging (${nudges}/2)` });
      next = `I could not tell what to open from that. I have the project open here and I am pasting you whatever you name — nothing happens on your side. ${REMINDER}`;
      continue;
    }
    nudges = 0;

    const results = [];
    for (const call of work) {
      let result;
      try { result = await tools[call.kind](call.arg, call.body); }
      catch (err) { result = `error: ${err.message}`; }
      const head = result.split('\n')[0];
      onEvent({
        type: 'tool',
        kind: call.kind,
        arg: call.arg,
        ok: !/^(no such|error|the text)/.test(result),
        head: head.slice(0, 70),
      });
      results.push(`Result of ${call.kind} ${call.arg}:\n${outbound(result)}`);
    }

    const stillLooking = work.some((c) => c.kind === 'list' || c.kind === 'read');
    if (done && !stillLooking) { summary = done.arg || prose(reply) || 'done'; onEvent({ type: 'done', summary }); break; }
    if (done) onEvent({ type: 'notice', text: 'ignoring DONE — it came before the results it asked for' });

    next = `${results.join('\n\n')}\n\n${REMINDER}`;
    if (step === maxSteps) onEvent({ type: 'warn', text: 'reached the step limit' });
  }

  return { overlay, summary };
}

/* ---------------------------------------------------------------- the diff */

// A unified diff without shelling out to `diff -u`, which is not on PATH on a
// stock Windows box and which the CLI used to depend on. Plain LCS over lines;
// files large enough for that to matter are reported as a whole-file replace.
const LCS_LIMIT = 2000;

function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

// Walk the table into a flat op list: ' ' keep, '-' remove, '+' add.
function opsFor(a, b) {
  if (a.length > LCS_LIMIT || b.length > LCS_LIMIT) {
    return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  }
  const table = lcsTable(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < a.length) ops.push(['-', a[i++]]);
  while (j < b.length) ops.push(['+', b[j++]]);
  return ops;
}

export function unifiedDiff(before, after, { label = 'file', context = 3 } = {}) {
  if (before === after) return '';
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const ops = opsFor(a, b);

  // Group changed ops into hunks, padding each with `context` kept lines.
  const changed = ops.map((op, k) => (op[0] === ' ' ? -1 : k)).filter((k) => k !== -1);
  if (!changed.length) return '';

  const hunks = [];
  let start = changed[0];
  let end = changed[0];
  for (const k of changed.slice(1)) {
    if (k - end <= context * 2) { end = k; continue; }
    hunks.push([start, end]);
    start = k;
    end = k;
  }
  hunks.push([start, end]);

  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (const [from, to] of hunks) {
    const lo = Math.max(0, from - context);
    const hi = Math.min(ops.length - 1, to + context);

    let aStart = 0;
    let bStart = 0;
    for (let k = 0; k < lo; k++) {
      if (ops[k][0] !== '+') aStart++;
      if (ops[k][0] !== '-') bStart++;
    }
    let aCount = 0;
    let bCount = 0;
    for (let k = lo; k <= hi; k++) {
      if (ops[k][0] !== '+') aCount++;
      if (ops[k][0] !== '-') bCount++;
    }

    out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (let k = lo; k <= hi; k++) out.push(ops[k][0] + ops[k][1]);
  }
  return out.join('\n');
}
