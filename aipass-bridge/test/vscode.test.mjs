// Drives vscode/extension.js against the real bridge, with the `vscode` module
// stubbed. Nothing here mocks the agent: the loop, the protocol and the HTTP
// surface are all the real ones, so these tests fail if the extension misuses
// the API or the core changes shape underneath it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { startBridge, FakeExtension, scripted, tempDir } from './harness.mjs';
import {
  createVscodeStub, createStream, createToken, createContext, createWebviewView, createMemento,
} from './vscode-stub.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const EXTENSION = path.join(HERE, '..', 'vscode', 'extension.js');

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

// require('vscode') only resolves inside VS Code, so intercept it. Each load
// gets a fresh copy of the extension so its module-level state does not leak.
function loadExtension(stub, file = EXTENSION) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub;
    return original.call(this, request, parent, isMain);
  };
  try {
    const require = createRequire(import.meta.url);
    // Every module under the extension captures `vscode` at require time, so
    // dropping only the entry point leaves the rest bound to the first stub
    // they ever saw -- and silently pointed at an earlier test's workspace.
    const root = path.dirname(file);
    for (const cached of Object.keys(require.cache)) {
      if (cached.startsWith(root + path.sep)) delete require.cache[cached];
    }
    return require(file);
  } finally {
    Module._load = original;
  }
}

// Stand up the extension and hand back everything a test needs to poke at it.
function activate({ root, config, state } = {}) {
  const { vscode, recorded } = createVscodeStub({ root, config: { bridge: bridge.base, ...config } });
  const ext = loadExtension(vscode);
  // Passing the same memento to two activate() calls is what a reload looks
  // like: new provider, new webview, the workspaceState that was left behind.
  const context = createContext(path.join(HERE, '..', 'vscode'), { workspaceState: state });
  ext.activate(context);

  const participant = recorded.participants[0];
  assert.ok(participant, 'the chat participant should be registered on activate');

  return {
    recorded,
    context,

    /** Resolve the chat panel and hand back the stubbed view driving it. */
    panel() {
      const entry = recorded.webviewProviders.get('aipass.chat');
      assert.ok(entry, 'the chat panel provider should be registered on activate');
      const view = createWebviewView();
      entry.provider.resolveWebviewView(view);
      return view;
    },

    async ask(prompt, { command, history = [] } = {}) {
      const stream = createStream();
      const token = createToken();
      const result = await participant.handler({ prompt, command, references: [] }, { history }, stream, token);
      return { stream, token, result };
    },
  };
}

/* ------------------------------------------------------------------ wiring */

test('activate registers the participant, the provider and the commands', () => {
  const { recorded } = activate({ root: tempDir({ 'a.txt': 'x' }) });

  assert.equal(recorded.participants.length, 1);
  assert.equal(recorded.participants[0].id, 'aipass.agent');
  assert.ok(recorded.providers.has('aipass-pending'), 'the diff provider must be registered');
  for (const name of ['aipass.showDiff', 'aipass.applyAll', 'aipass.discardAll', 'aipass.status']) {
    assert.ok(recorded.commands.has(name), `${name} should be registered`);
  }
});

test('every command the manifest declares is actually registered', () => {
  const require = createRequire(import.meta.url);
  const manifest = require(path.join(HERE, '..', 'vscode', 'package.json'));
  const { recorded } = activate({ root: tempDir({ 'a.txt': 'x' }) });

  for (const { command } of manifest.contributes.commands) {
    assert.ok(recorded.commands.has(command), `${command} is in package.json but never registered`);
  }
  // And the participant id must match too, or VS Code refuses to activate it.
  assert.equal(manifest.contributes.chatParticipants[0].id, recorded.participants[0].id);
});

/* ------------------------------------------------------------ the sad paths */

test('says so plainly when no folder is open', async () => {
  const { ask } = activate({ root: null });
  const { stream } = await ask('what is this?');
  assert.match(stream.text(), /Open a folder first/);
});

test('says so plainly when the extension is not attached', async () => {
  // No FakeExtension connected, so /status reports zero tabs.
  const { ask } = activate({ root: tempDir({ 'a.txt': 'x' }) });
  const { stream } = await ask('what is this?');
  assert.match(stream.text(), /not attached/);
});

/* ----------------------------------------------------------------- reading */

test('answers a question and cites what it read', async (t) => {
  const dir = tempDir({ 'README.md': 'a starter project\n' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted([
      'NEED file README.md',
      'DONE It is a starter project.',
    ]),
  }).connect();
  t.after(() => ext.disconnect());

  const { ask, recorded } = activate({ root: dir });
  const { stream, result } = await ask('what is this project?');

  assert.match(stream.text(), /It is a starter project\./);
  assert.ok(stream.parts.progress.some((p) => /read README\.md/.test(p)), 'the read should show as progress');
  assert.ok(stream.parts.references.length > 0, 'the file it read should be cited');
  assert.equal(result.metadata.changed, 0);
});

test('the protocol markers are hidden from the chat by default', async (t) => {
  const dir = tempDir({ 'README.md': 'hello\n' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['NEED file README.md', 'It reads hello.\nDONE summarised']),
  }).connect();
  t.after(() => ext.disconnect());

  const { ask } = activate({ root: dir });
  const { stream } = await ask('what is in the readme?');

  assert.match(stream.text(), /It reads hello\./);
  assert.doesNotMatch(stream.text(), /NEED file/, 'the markers are protocol, not prose');
  assert.doesNotMatch(stream.text(), /^DONE/m);
});

/* ----------------------------------------------------------------- editing */

test('an edit is staged, not written, until it is applied', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted([
      'EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND',
      'DONE renamed the greeting',
    ]),
  }).connect();
  t.after(() => ext.disconnect());

  const { ask, recorded } = activate({ root: dir });
  const { stream, result } = await ask('say goodbye instead');

  assert.equal(result.metadata.changed, 1);
  assert.match(stream.text(), /1 file\(s\) staged/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello', 'nothing is written yet');

  const titles = stream.parts.buttons.map((b) => b.title);
  assert.ok(titles.some((t2) => /Review/.test(t2)));
  assert.ok(titles.some((t2) => /^Apply/.test(t2)));
  assert.ok(titles.some((t2) => /Discard/.test(t2)));

  // The staged text is what the diff editor will show on the right.
  const provider = recorded.providers.get('aipass-pending');
  const uri = stream.parts.buttons.find((b) => /Review/.test(b.title)).arguments[0];
  const { Uri } = createVscodeStub({}).vscode;
  assert.equal(provider.provideTextDocumentContent(Uri.file(uri).with({ scheme: 'aipass-pending' })), 'goodbye');

  await recorded.commands.get('aipass.applyAll')();
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'goodbye', 'applied on request');
});

test('discarding leaves the disk untouched and clears the staging area', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND', 'DONE done']),
  }).connect();
  t.after(() => ext.disconnect());

  const { ask, recorded } = activate({ root: dir });
  await ask('change it');

  recorded.commands.get('aipass.discardAll')();
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello');

  await recorded.commands.get('aipass.applyAll')();
  assert.ok(recorded.info.some((m) => /nothing staged/.test(m)), 'there should be nothing left to apply');
});

test('/apply writes without staging', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND', 'DONE done']),
  }).connect();
  t.after(() => ext.disconnect());

  const { ask } = activate({ root: dir });
  const { stream } = await ask('change it', { command: 'apply' });

  assert.match(stream.text(), /Wrote \*\*1\*\* file\(s\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'goodbye');
});

test('a created file is written through the edit, not straight to disk', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['CREATE notes/new.md\nbrand new\nEND', 'DONE added a note']),
  }).connect();
  t.after(() => ext.disconnect());

  const { ask, recorded } = activate({ root: dir });
  await ask('add a note', { command: 'apply' });

  assert.equal(fs.readFileSync(path.join(dir, 'notes', 'new.md'), 'utf8'), 'brand new');
  assert.ok(recorded.appliedEdits.length > 0, 'it must go through a WorkspaceEdit so undo works');
});

/* ---------------------------------------------------------- the constraint */

test('a fresh chat opens a conversation and a follow-up continues it', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE nothing to do']) }).connect();
  t.after(() => ext.disconnect());

  const { ask } = activate({ root: dir });

  await ask('first question');
  assert.equal(ext.created.length, 1, 'the first turn opens a conversation');
  const opened = ext.chats.at(-1).conversationId;

  await ask('follow-up', { history: [{ prompt: 'first question' }] });
  assert.equal(ext.created.length, 1, 'a follow-up must not open a second one');
  assert.equal(ext.chats.at(-1).conversationId, opened, 'it continues the same conversation');
});

/* -------------------------------------------------------------- the shell */

test('shell commands are refused unless allowRun is set', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['RUN\nnpm test\nEND', 'DONE tried']),
  }).connect();
  t.after(() => ext.disconnect());

  const { ask, recorded } = activate({ root: dir });
  await ask('run the tests');
  assert.equal(recorded.terminals.length, 0, 'no terminal should be opened');
});

test('with allowRun the command goes to a visible terminal', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['RUN\nnpm test\nEND', 'DONE tried']),
  }).connect();
  t.after(() => ext.disconnect());

  const { ask, recorded } = activate({ root: dir, config: { allowRun: true } });
  await ask('run the tests');

  assert.equal(recorded.terminals.length, 1);
  assert.deepEqual(recorded.terminals[0].sent, ['npm test']);
});

/* -------------------------------------------------------------- the extras */

test('/status reports the bridge and the attached tab', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE']) }).connect();
  t.after(() => ext.disconnect());

  const { ask } = activate({ root: dir });
  const { stream } = await ask('', { command: 'status' });

  assert.match(stream.text(), /Ready/);
  assert.match(stream.text(), /browser tabs attached \| 1/);
});

/* ------------------------------------------------------------- chat panel */

test('the chat panel is registered and keeps its thread when hidden', () => {
  const { recorded } = activate({ root: tempDir({ 'a.txt': 'x' }) });
  const entry = recorded.webviewProviders.get('aipass.chat');

  assert.ok(entry, 'aipass.chat should be registered');
  assert.equal(entry.options?.webviewOptions?.retainContextWhenHidden, true,
    'a conversation must survive switching away from the panel');
});

test('the panel id and container in the manifest match what is registered', () => {
  const require = createRequire(import.meta.url);
  const manifest = require(path.join(HERE, '..', 'vscode', 'package.json'));
  const { recorded } = activate({ root: tempDir({ 'a.txt': 'x' }) });

  const view = manifest.contributes.views.aipass[0];
  assert.equal(view.type, 'webview', 'VS Code needs to be told this view is a webview');
  assert.ok(recorded.webviewProviders.has(view.id), `${view.id} is declared but never registered`);

  // The activity-bar icon has to exist, or the container renders blank.
  const icon = manifest.contributes.viewsContainers.activitybar[0].icon;
  assert.ok(fs.existsSync(path.join(HERE, '..', 'vscode', icon)), `${icon} is missing`);
});

test('the panel html locks itself down and loads its own assets', () => {
  const { panel } = activate({ root: tempDir({ 'a.txt': 'x' }) });
  const { webview } = panel();

  assert.equal(webview.options.enableScripts, true);
  assert.match(webview.html, /Content-Security-Policy/);
  assert.match(webview.html, /default-src 'none'/, 'a webview that can reach the network is a hole here');

  const nonce = /nonce-([A-Za-z0-9]+)/.exec(webview.html)?.[1];
  assert.ok(nonce && nonce.length >= 16, 'scripts must be nonce-gated');
  assert.match(webview.html, new RegExp(`<script nonce="${nonce}"`), 'the tag and the policy must agree');

  assert.match(webview.html, /chat\.css/);
  assert.match(webview.html, /chat\.js/);
});

test('asking in the panel answers and reports what it read', async (t) => {
  const dir = tempDir({ 'README.md': 'a starter project\n' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['NEED file README.md', 'DONE It is a starter project.']),
  }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'ask', text: 'what is this project?' });

  assert.equal(view.last('user').text, 'what is this project?', 'the question is echoed back');
  assert.match(view.of('assistant').map((m) => m.text).join(''), /It is a starter project\./);
  assert.ok(view.of('step').some((m) => /read README\.md/.test(m.text)), 'the read shows as a step');

  const busy = view.of('busy').map((m) => m.value);
  assert.deepEqual([busy.at(0), busy.at(-1)], [true, false], 'the composer unlocks when the turn ends');
});

test('the panel stages an edit and applies it only when asked', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND', 'DONE renamed it']),
  }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'ask', text: 'say goodbye instead' });

  const staged = view.last('staged');
  assert.ok(staged, `the panel should offer the edit for review; it posted ${JSON.stringify(view.posted)}`);
  assert.deepEqual(staged.files.map((f) => f.rel), ['a.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello', 'nothing written yet');

  await view.send({ type: 'apply' });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'goodbye');
});

test('the panel can discard instead', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND', 'DONE done']),
  }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'ask', text: 'change it' });
  await view.send({ type: 'discard' });

  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello');
});

test('the write-straight-to-disk box skips staging', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND', 'DONE done']),
  }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'ask', text: 'change it', apply: true });

  assert.equal(view.last('staged'), undefined, 'nothing to review when it writes directly');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'goodbye');
});

test('the panel keeps one conversation, and New chat opens the next', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE nothing to do']) }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();

  await view.send({ type: 'ask', text: 'first' });
  assert.equal(ext.created.length, 1, 'the first turn opens a conversation');
  const opened = ext.chats.at(-1).conversationId;

  await view.send({ type: 'ask', text: 'follow-up' });
  assert.equal(ext.created.length, 1, 'a follow-up must not open a second one');
  assert.equal(ext.chats.at(-1).conversationId, opened);

  await view.send({ type: 'new' });
  assert.ok(view.of('cleared').length > 0, 'the thread is emptied');
  await view.send({ type: 'ask', text: 'after new chat' });
  assert.equal(ext.created.length, 2, 'New chat must open a fresh conversation');
});

test('the panel says what is wrong rather than failing silently', async () => {
  // No FakeExtension attached, so the bridge reports zero tabs.
  const { panel } = activate({ root: tempDir({ 'a.txt': 'x' }) });
  const view = panel();
  await view.send({ type: 'ask', text: 'anything' });

  assert.match(view.last('notice').text, /not attached/);
  assert.equal(view.last('status').ok, false);
});

/* --------------------------------------------------- what actually goes out */

test('a primed conversation gets the bare task, not the preamble again', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const handler = scripted(['DONE nothing to do']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();

  await view.send({ type: 'ask', text: 'first question' });
  const opening = handler.sent.at(-1);
  assert.match(opening, /NEED file/, 'the opening turn carries the protocol');

  await view.send({ type: 'ask', text: 'second question' });
  const followUp = handler.sent.at(-1);

  assert.equal(followUp, 'second question', 'a later turn is just the question');
  assert.doesNotMatch(followUp, /NEED file/, 'the server already has the instructions');
  assert.ok(
    Buffer.byteLength(followUp) < Buffer.byteLength(opening) / 10,
    `a follow-up should not cost what the first turn did: ${Buffer.byteLength(opening)} -> ${Buffer.byteLength(followUp)}`,
  );
});

test('the CLI still sends the preamble, because --reuse cannot know', async (t) => {
  // Continuing "the most recent conversation" says nothing about whether that
  // one ever saw a preamble, so runAgent must not infer primed from reuse.
  const dir = tempDir({ 'a.txt': 'x' });
  const handler = scripted(['DONE nothing to do']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const core = await import('../agent/core.mjs');
  await core.runAgent({
    task: 'anything',
    root: dir,
    bridge: bridge.base,
    reuse: true,
    host: {
      readFile: async () => '',
      exists: async () => true,
      readdir: async () => [],
    },
  });
  assert.match(handler.sent.at(-1), /NEED file/, 'reuse alone must not suppress the preamble');
});

test('Ask mode sends the question and nothing else', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const handler = scripted(['Tuesday.']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'ask', text: 'วันนี้วันอะไร', mode: 'ask' });

  assert.equal(handler.sent.at(-1), 'วันนี้วันอะไร', 'no preamble, no directory listing');
  assert.match(view.of('assistant').map((m) => m.text).join(''), /Tuesday\./);

  const busy = view.of('busy').map((m) => m.value);
  assert.deepEqual([busy.at(0), busy.at(-1)], [true, false]);
});

test('Ask mode never touches the workspace', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  // Even handed an edit, Ask mode has no tools to run it with.
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND']),
  }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'ask', text: 'change it', mode: 'ask' });

  assert.equal(view.last('staged'), undefined, 'nothing is staged');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello', 'nothing is written');
});

test('the preamble no longer forces English', async () => {
  const core = await import('../agent/core.mjs');
  const text = core.preamble({ allowRun: false });
  assert.doesNotMatch(text, /Answer in English/, 'a Thai question was getting an English answer');
  assert.match(text, /same language|whatever language/i, 'it should follow the asker instead');
});

test('Ask mode works on an account with no conversation yet', async (t) => {
  // Agent mode opens one on its way through runAgent; Ask went straight to the
  // model and inherited whatever the bridge could find, which on a fresh
  // account is nothing at all.
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, {
    conversations: [],
    onChat: scripted(['Tuesday.']),
  }).connect();
  t.after(() => ext.disconnect());

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation: null }),
  });

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'ask', text: 'วันนี้วันอะไร', mode: 'ask' });

  assert.equal(view.last('notice'), undefined,
    `Ask should open a conversation rather than report there is none: ${JSON.stringify(view.last('notice'))}`);
  assert.equal(ext.created.length, 1, 'it has to create one, the way Agent does');
  assert.match(view.of('assistant').map((m) => m.text).join(''), /Tuesday\./);
});

test('Ask and Agent share one conversation, but only Agent primes it', async (t) => {
  // The panel is one conversation whichever mode is driving. But a
  // conversation opened by Ask has never seen the instructions, so a later
  // Agent turn must still send them -- priming is about the preamble, not
  // about whether a conversation exists.
  const dir = tempDir({ 'a.txt': 'x' });
  const handler = scripted(['fine', 'DONE nothing to do']);
  const ext = await new FakeExtension(bridge.base, { conversations: [], onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation: null }),
  });

  const { panel } = activate({ root: dir });
  const view = panel();

  await view.send({ type: 'ask', text: 'hello', mode: 'ask' });
  const opened = ext.chats.at(-1).conversationId;
  assert.equal(ext.created.length, 1);

  await view.send({ type: 'ask', text: 'now read the project' });
  assert.equal(ext.created.length, 1, 'the same conversation carries on');
  assert.equal(ext.chats.at(-1).conversationId, opened);
  assert.match(handler.sent.at(-1), /NEED file/,
    'an Ask-opened conversation has no instructions yet, so Agent must send them');
});

test('a second Ask turn does not open another conversation', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, {
    conversations: [],
    onChat: scripted(['one', 'two']),
  }).connect();
  t.after(() => ext.disconnect());

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation: null }),
  });

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'ask', text: 'first', mode: 'ask' });
  await view.send({ type: 'ask', text: 'second', mode: 'ask' });

  assert.equal(ext.created.length, 1, 'one conversation for the session');
});

/* --------------------------------------------------------- session on disk */

test('the thread and the conversation survive a reload', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['DONE it is a starter project']),
  }).connect();
  t.after(() => ext.disconnect());

  // One workspaceState carried across both activations, the way VS Code does.
  const state = createMemento();

  const first = activate({ root: dir, state });
  const a = first.panel();
  await a.send({ type: 'ask', text: 'what is this?' });
  const opened = ext.chats.at(-1).conversationId;

  const saved = state.get('aipass.session');
  assert.ok(saved, 'the session should be written to workspaceState');
  assert.equal(saved.conversationId, opened, 'so a reload can find the conversation again');
  assert.deepEqual(saved.messages.map((m) => m.role), ['user', 'agent']);

  // Reload: a fresh provider, same stored state, a brand new webview.
  const second = activate({ root: dir, state });
  const b = second.panel();
  await b.send({ type: 'ready' });

  const restored = b.last('restore');
  assert.ok(restored, 'the panel should replay what it had');
  assert.equal(restored.messages[0].text, 'what is this?');
  assert.match(restored.messages[1].text, /starter project/);
});

test('the first turn after a reload continues the same conversation', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE ok']) }).connect();
  t.after(() => ext.disconnect());

  const state = createMemento();
  const first = activate({ root: dir, state });
  await first.panel().send({ type: 'ask', text: 'first' });
  const opened = ext.chats.at(-1).conversationId;
  assert.equal(ext.created.length, 1);

  // Something else moves the bridge off that conversation in the meantime.
  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation: 'bbbb2222bbbb2222' }),
  });

  const second = activate({ root: dir, state });
  await second.panel().send({ type: 'ask', text: 'after the reload' });

  assert.equal(ext.created.length, 1, 'a reload must not open a second conversation');
  assert.equal(ext.chats.at(-1).conversationId, opened,
    'the panel has to point the bridge back at the one it was using');
});

test('a restored Ask conversation still gets the instructions from Agent', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const handler = scripted(['fine', 'DONE nothing to do']);
  const ext = await new FakeExtension(bridge.base, { conversations: [], onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation: null }),
  });

  const state = createMemento();
  await activate({ root: dir, state }).panel().send({ type: 'ask', text: 'hi', mode: 'ask' });
  assert.equal(state.get('aipass.session').primed, false, 'Ask never sends the preamble');

  // Reload, then switch to Agent: the conversation exists but has no protocol.
  await activate({ root: dir, state }).panel().send({ type: 'ask', text: 'read the project' });
  assert.match(handler.sent.at(-1), /NEED file/,
    'priming has to survive the reload as false, or Agent skips a preamble the server lacks');
});

test('New chat clears what was stored', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE ok']) }).connect();
  t.after(() => ext.disconnect());

  const state = createMemento();
  const { panel } = activate({ root: dir, state });
  const view = panel();
  await view.send({ type: 'ask', text: 'something' });
  assert.ok(state.get('aipass.session').messages.length > 0);

  await view.send({ type: 'new' });
  const cleared = state.get('aipass.session');
  assert.deepEqual(cleared.messages, [], 'the thread goes');
  assert.equal(cleared.conversationId, null, 'and so does the conversation it was tied to');
});

test('a very long thread is trimmed rather than growing without limit', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE ok']) }).connect();
  t.after(() => ext.disconnect());

  const state = createMemento();
  const { panel } = activate({ root: dir, state });
  const view = panel();

  // workspaceState is not a database; one enormous turn must not park itself
  // there forever.
  for (let i = 0; i < 4; i++) await view.send({ type: 'ask', text: 'x'.repeat(40 * 1024) });

  const stored = state.get('aipass.session');
  const chars = stored.messages.reduce((n, m) => n + m.text.length, 0);
  assert.ok(chars <= 96 * 1024, `stored thread should stay under the cap, got ${chars}`);
  assert.ok(stored.messages.length > 0, 'but not empty itself out');
});

/* ------------------------------------------------------------ model picker */

test('the panel lists the models the account can use', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, {
    models: [
      { id: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', isFreeCredit: true },
      { id: 'claude-sonnet-5@default', displayName: 'Claude Sonnet 5' },
    ],
    onChat: scripted(['DONE']),
  }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'ready' });

  const models = view.last('models');
  assert.ok(models, 'the panel should be told what it can pick from');
  assert.deepEqual(models.list.map((m) => m.id), ['gemini-3.1-flash-lite', 'claude-sonnet-5@default']);
  assert.equal(models.list[0].free, true, 'free credit is worth showing');
  assert.equal(models.selected, '', 'nothing chosen yet means the bridge default');
  assert.equal(models.fallback, 'gemini-3.1-flash-lite', 'and it says which one that is');
});

test('choosing a model writes the setting, not the bridge default', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE']) }).connect();
  t.after(() => ext.disconnect());

  const { panel, recorded } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'model', id: 'claude-sonnet-5@default' });

  assert.deepEqual(recorded.configWrites, [
    { key: 'model', value: 'claude-sonnet-5@default', target: 1 },
  ], 'it belongs in this editor, not in the bridge everything else shares');

  // POST /config would have moved the bridge's own default; it must not have.
  const status = await fetch(`${bridge.base}/status`).then((r) => r.json());
  assert.equal(status.defaultModel, 'gemini-3.1-flash-lite', 'the CLI is untouched');
});

test('the chosen model is what actually gets sent', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE nothing to do']) }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'model', id: 'claude-sonnet-5@default' });
  await view.send({ type: 'ask', text: 'anything' });

  assert.equal(ext.chats.at(-1).modelId, 'claude-sonnet-5@default');
});

test('Ask mode honours the choice too', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['fine']) }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir });
  const view = panel();
  await view.send({ type: 'model', id: 'claude-sonnet-5@default' });
  await view.send({ type: 'ask', text: 'วันนี้วันอะไร', mode: 'ask' });

  assert.equal(ext.chats.at(-1).modelId, 'claude-sonnet-5@default');
});

test('clearing the choice goes back to whatever the bridge defaults to', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE']) }).connect();
  t.after(() => ext.disconnect());

  const { panel } = activate({ root: dir, config: { model: 'claude-sonnet-5@default' } });
  const view = panel();
  await view.send({ type: 'model', id: '' });
  await view.send({ type: 'ask', text: 'anything' });

  assert.equal(ext.chats.at(-1).modelId, 'gemini-3.1-flash-lite', 'the bridge default takes over again');
});

/* ------------------------------------------------------------ packaged .vsix */

// Inside a .vsix everything above the extension root is gone, so ../agent is
// not there and the staged copy is the only way core.mjs can be found. Build
// that layout and drive a real request through it, rather than trusting that
// the fallback in loadCore does what it says.
test('the packaged layout loads core.mjs from the staged copy', async (t) => {
  const staged = tempDir({});
  const src = path.join(HERE, '..', 'vscode');
  fs.mkdirSync(path.join(staged, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(staged, 'media'), { recursive: true });

  // Everything the extension requires at runtime has to be inside the .vsix.
  // Listing them here is what catches a new file that packaging forgot.
  for (const file of ['extension.js', 'chatview.js', 'package.json']) {
    fs.copyFileSync(path.join(src, file), path.join(staged, file));
  }
  for (const asset of fs.readdirSync(path.join(src, 'media'))) {
    fs.copyFileSync(path.join(src, 'media', asset), path.join(staged, 'media', asset));
  }
  fs.copyFileSync(path.join(HERE, '..', 'agent', 'core.mjs'), path.join(staged, 'agent', 'core.mjs'));

  assert.ok(
    !fs.existsSync(path.join(staged, '..', 'agent', 'core.mjs')),
    'the sibling path must be absent, or this would not be testing the packaged case',
  );

  const dir = tempDir({ 'README.md': 'a starter project\n' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['NEED file README.md', 'DONE It is a starter project.']),
  }).connect();
  t.after(() => ext.disconnect());

  const { vscode, recorded } = createVscodeStub({ root: dir, config: { bridge: bridge.base } });
  const loaded = loadExtension(vscode, path.join(staged, 'extension.js'));
  loaded.activate(createContext(staged));

  const stream = createStream();
  await recorded.participants[0].handler(
    { prompt: 'what is this?', references: [] }, { history: [] }, stream, createToken(),
  );

  assert.match(stream.text(), /It is a starter project\./);
});

test('/models lists what the account can use', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE']) }).connect();
  t.after(() => ext.disconnect());

  const { ask } = activate({ root: dir });
  const { stream } = await ask('', { command: 'models' });
  assert.match(stream.text(), /gemini/);
});
