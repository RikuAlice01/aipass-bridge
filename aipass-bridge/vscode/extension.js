// VS Code front end for the agent.
//
// The loop itself lives in agent/core.mjs and is shared with the CLI. This file
// supplies the two things the core deliberately does not have: a filesystem
// (vscode.workspace.fs) and somewhere to report to (a chat response stream).
//
// What it cannot supply is a session. The bridge still relays every request
// through the Chrome extension and an open de.aipass.net tab, because that is
// where the cookie lives and it is the whole point that it stays there. VS Code
// is a fourth hop, not a replacement for the browser.
const vscode = require('vscode');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ChatViewProvider } = require('./chatview');

const PENDING_SCHEME = 'aipass-pending';

/* ------------------------------------------------------------------- core */

let corePromise = null;

// core.mjs is ESM and this file is CommonJS, so it comes in through a dynamic
// import. Packaged, it sits beside us; in the repo it is one level up.
function loadCore(context) {
  if (corePromise) return corePromise;
  // Source first, staged copy second. Both exist in a checkout that has ever
  // been packaged, and preferring the copy there means editing agent/core.mjs
  // changes nothing until someone remembers to re-stage — which is exactly
  // how a stale build artifact ends up shadowing the code under test. Inside
  // a .vsix there is no `..`, so the copy is what gets loaded.
  const candidates = [
    path.join(context.extensionPath, '..', 'agent', 'core.mjs'),
    path.join(context.extensionPath, 'agent', 'core.mjs'),
  ];
  corePromise = (async () => {
    let lastErr;
    for (const p of candidates) {
      try { return await import(pathToFileURL(p).href); }
      catch (err) { lastErr = err; }
    }
    throw new Error(`could not load agent/core.mjs: ${lastErr?.message ?? 'not found'}`);
  })();
  return corePromise;
}

/* ------------------------------------------------------------------- host */

const decoder = new TextDecoder();

// workspace.fs rather than node:fs, so this keeps working in a remote,
// WSL or virtual workspace where the files are not on the local disk.
function createHost(terminalRunner) {
  return {
    async readFile(abs) {
      return decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(abs)));
    },
    async exists(abs) {
      try { await vscode.workspace.fs.stat(vscode.Uri.file(abs)); return true; }
      catch { return false; }
    },
    async readdir(abs) {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(abs));
      return entries.map(([name, type]) => ({ name, isDirectory: type === vscode.FileType.Directory }));
    },
    run: terminalRunner,
  };
}

/* -------------------------------------------------------- pending changes */

// Edits stay here until someone applies them. Keyed by the path of the
// aipass-pending: URI so the diff provider can look them up directly.
class Pending {
  constructor() {
    this.files = new Map();          // uri.path -> { abs, text }
    this.onDidChangeEmitter = new vscode.EventEmitter();
    this.onDidChange = this.onDidChangeEmitter.event;
  }

  static uriFor(abs) {
    return vscode.Uri.file(abs).with({ scheme: PENDING_SCHEME });
  }

  // Left-hand side when the file does not exist yet: the provider has no entry
  // for this path, so it renders as empty and the diff reads as an addition.
  static get emptyUri() {
    return vscode.Uri.from({ scheme: PENDING_SCHEME, path: '/(new file)' });
  }

  set(abs, text) {
    const uri = Pending.uriFor(abs);
    this.files.set(uri.path, { abs, text });
    this.onDidChangeEmitter.fire(uri);
  }

  provideTextDocumentContent(uri) {
    return this.files.get(uri.path)?.text ?? '';
  }

  get size() { return this.files.size; }
  entries() { return [...this.files.values()]; }
  clear() {
    const gone = [...this.files.keys()];
    this.files.clear();
    for (const p of gone) this.onDidChangeEmitter.fire(vscode.Uri.from({ scheme: PENDING_SCHEME, path: p }));
  }
}

// A WorkspaceEdit rather than a direct write, so applying lands in the normal
// undo stack and the user can back it out with ctrl+Z like any other edit.
async function applyPending(pending) {
  const edit = new vscode.WorkspaceEdit();
  for (const { abs, text } of pending.entries()) {
    const uri = vscode.Uri.file(abs);
    let existed = true;
    try { await vscode.workspace.fs.stat(uri); } catch { existed = false; }

    if (!existed) {
      edit.createFile(uri, { ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), text);
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
    }
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok) pending.clear();
  return ok;
}

/* --------------------------------------------------------------- the shell */

// Off unless aipass.allowRun is set. Even then it goes to a visible terminal
// rather than a hidden child process, so nothing runs where it cannot be seen.
function createTerminalRunner(getTerminal) {
  return async function run(command, { cwd }) {
    const terminal = getTerminal(cwd);
    terminal.show(true);
    terminal.sendText(command, true);
    return 'sent to the aipass terminal — its output is not read back into the conversation';
  };
}

/* ------------------------------------------------------------- bridge probe */

async function probe(bridge) {
  try {
    const res = await fetch(`${bridge}/status`);
    if (!res.ok) return { ok: false, reason: `the bridge answered ${res.status}` };
    const status = await res.json();
    if (!status.extensions) {
      return { ok: false, reason: 'the browser extension is not attached — open a https://de.aipass.net/chat tab and leave it open', status };
    }
    return { ok: true, status };
  } catch {
    return { ok: false, reason: `no bridge at ${bridge} — start it with \`npm run dev\`` };
  }
}

/* ------------------------------------------------------------ chat handler */

function createHandler(context, pending, terminalRunner) {
  return async function handler(request, chatContext, stream, token) {
    const cfg = vscode.workspace.getConfiguration('aipass');
    const bridge = String(cfg.get('bridge')).replace(/\/+$/, '');

    if (request.command === 'status') return await reportStatus(bridge, stream);
    if (request.command === 'models') return await reportModels(bridge, stream);

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      stream.markdown('Open a folder first — the agent works inside a workspace root.');
      return {};
    }
    if (folder.uri.scheme !== 'file') {
      stream.markdown(`This workspace is \`${folder.uri.scheme}:\`, and the agent needs a real folder path to confine itself to.`);
      return {};
    }

    const health = await probe(bridge);
    if (!health.ok) {
      stream.markdown(`Cannot reach aipass: ${health.reason}.`);
      return {};
    }

    const { runAgent, prose } = await loadCore(context);

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    const applyStraightAway = request.command === 'apply';
    const showMarkers = cfg.get('showModelMarkers') === true;

    // The server owns the history, so one chat session maps to one
    // conversation: the first turn opens it, later turns continue it.
    const reuse = chatContext.history.length > 0;

    let buffered = '';
    const flush = () => {
      if (!buffered.trim()) { buffered = ''; return; }
      const text = showMarkers ? buffered : prose(buffered);
      if (text.trim()) stream.markdown(`${text}\n\n`);
      buffered = '';
    };

    const onEvent = (evt) => {
      switch (evt.type) {
        case 'delta':
          buffered += evt.text;
          break;
        case 'reasoning':
          stream.progress(evt.text.split('\n')[0].slice(0, 120));
          break;
        case 'step':
          flush();
          stream.progress(`step ${evt.n}/${evt.total}`);
          break;
        case 'tool': {
          flush();
          const label = evt.arg || '.';
          if (evt.kind === 'read' || evt.kind === 'list') {
            stream.progress(`${evt.kind} ${label}`);
            try { stream.reference(vscode.Uri.file(path.resolve(folder.uri.fsPath, label))); } catch { /* best effort */ }
          } else {
            stream.progress(`${evt.kind} ${label}${evt.ok ? '' : ' — ' + evt.head}`);
          }
          break;
        }
        case 'notice':
        case 'warn':
          flush();
          stream.progress(evt.text);
          break;
        case 'rejected':
          flush();
          stream.markdown(`\n> A fragment was refused upstream even on its own, so the run stopped early.\n\n`);
          break;
        case 'error':
          flush();
          stream.markdown(`\n**${evt.message}**\n\n`);
          break;
        case 'cancelled':
          flush();
          stream.markdown('\n_cancelled_\n\n');
          break;
        default:
          break;
      }
    };

    let overlay;
    let summary;
    try {
      ({ overlay, summary } = await runAgent({
        task: request.prompt,
        root: folder.uri.fsPath,
        host: createHost(cfg.get('allowRun') ? terminalRunner : undefined),
        bridge,
        model: String(cfg.get('model') || '') || null,
        maxSteps: Number(cfg.get('maxSteps')) || 10,
        maxResult: Number(cfg.get('maxResult')) || 3000,
        allowRun: cfg.get('allowRun') === true,
        reuse,
        // Same conversation as the previous turn, so it already has the
        // instructions; resending them is pure payload.
        primed: reuse,
        signal: controller.signal,
        onEvent,
      }));
    } catch (err) {
      flush();
      stream.markdown(`\n**${String(err?.message ?? err)}**\n\n`);
      return {};
    }
    flush();

    if (!overlay.size) {
      if (summary) stream.markdown(`\n${summary}\n`);
      return { metadata: { changed: 0 } };
    }

    for (const [abs, text] of overlay) pending.set(abs, text);

    if (applyStraightAway) {
      const ok = await applyPending(pending);
      stream.markdown(ok
        ? `\nWrote **${overlay.size}** file(s).\n`
        : '\nThe edit could not be applied — the files may have changed underneath.\n');
      return { metadata: { changed: overlay.size } };
    }

    stream.markdown(`\n**${overlay.size} file(s) staged**, nothing written yet:\n\n`);
    for (const abs of overlay.keys()) {
      const rel = path.relative(folder.uri.fsPath, abs).split(path.sep).join('/');
      stream.markdown(`- \`${rel}\` `);
      stream.button({ command: 'aipass.showDiff', title: 'Review', arguments: [abs] });
      stream.markdown('\n');
    }
    stream.button({ command: 'aipass.applyAll', title: `Apply ${overlay.size} file(s)` });
    stream.button({ command: 'aipass.discardAll', title: 'Discard' });

    return { metadata: { changed: overlay.size } };
  };
}

async function reportStatus(bridge, stream) {
  const health = await probe(bridge);
  if (!health.ok) {
    stream.markdown(`**Not ready.** ${health.reason}.`);
    return {};
  }
  const s = health.status;
  stream.markdown([
    '**Ready.**',
    '',
    `| | |`,
    `|---|---|`,
    `| bridge | \`${bridge}\` |`,
    `| browser tabs attached | ${s.extensions} |`,
    `| default model | \`${s.defaultModel}\` |`,
    `| conversation | \`${s.conversation ?? 'resolves on first message'}\` |`,
    `| jobs in flight | ${s.activeJobs} |`,
  ].join('\n'));
  return {};
}

async function reportModels(bridge, stream) {
  try {
    const res = await fetch(`${bridge}/v1/models`);
    const { data } = await res.json();
    stream.markdown(['| model | | |', '|---|---|---|',
      ...data.map((m) => `| \`${m.id}\` | ${m.name ?? ''} | ${m.free_credit ? 'free credit' : ''} |`),
    ].join('\n'));
  } catch (err) {
    stream.markdown(`Could not list models: ${String(err?.message ?? err)}`);
  }
  return {};
}

/* ---------------------------------------------------------------- activate */

function activate(context) {
  const pending = new Pending();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PENDING_SCHEME, pending),
  );

  let terminal = null;
  const getTerminal = (cwd) => {
    if (!terminal || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal({ name: 'AI Bridge', cwd });
      context.subscriptions.push(terminal);
    }
    return terminal;
  };

  const terminalRunner = createTerminalRunner(getTerminal);

  // The panel is the front door. The chat participant stays registered beside
  // it: it costs one line, some people live in the VS Code chat view, and it
  // is what the test suite drives.
  const chat = new ChatViewProvider({
    extensionUri: context.extensionUri,
    // Workspace-scoped: the conversation is about this project, so it should
    // not follow the user into an unrelated folder.
    state: context.workspaceState,
    loadCore: () => loadCore(context),
    createHost,
    terminalRunner,
    probe,
    bridgeUrl: () =>
      String(vscode.workspace.getConfiguration('aipass').get('bridge')).replace(/\/+$/, ''),
    stage: (abs, text) => pending.set(abs, text),
    applyStaged: () => applyPending(pending),
    discardStaged: () => pending.clear(),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aipass.chat', chat, {
      // A conversation the user scrolled back through should still be there
      // when they switch to the terminal and back.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const participant = vscode.chat.createChatParticipant(
    'aipass.agent',
    createHandler(context, pending, terminalRunner),
  );
  participant.iconPath = new vscode.ThemeIcon('globe');
  context.subscriptions.push(participant);

  context.subscriptions.push(
    vscode.commands.registerCommand('aipass.openChat', () =>
      vscode.commands.executeCommand('aipass.chat.focus')),

    vscode.commands.registerCommand('aipass.showDiff', async (abs) => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const rel = folder ? path.relative(folder.uri.fsPath, abs).split(path.sep).join('/') : abs;
      const original = vscode.Uri.file(abs);
      let exists = true;
      try { await vscode.workspace.fs.stat(original); } catch { exists = false; }
      await vscode.commands.executeCommand(
        'vscode.diff',
        exists ? original : Pending.emptyUri,
        Pending.uriFor(abs),
        `${rel} — pending`,
        { preview: true },
      );
    }),

    vscode.commands.registerCommand('aipass.applyAll', async () => {
      if (!pending.size) { vscode.window.showInformationMessage('aipass: nothing staged.'); return; }
      const n = pending.size;
      const ok = await applyPending(pending);
      if (ok) vscode.window.showInformationMessage(`aipass: applied ${n} file(s).`);
      else vscode.window.showErrorMessage('aipass: could not apply the changes.');
    }),

    vscode.commands.registerCommand('aipass.discardAll', () => {
      const n = pending.size;
      pending.clear();
      vscode.window.showInformationMessage(`aipass: discarded ${n} staged file(s).`);
    }),

    vscode.commands.registerCommand('aipass.status', async () => {
      const bridge = String(vscode.workspace.getConfiguration('aipass').get('bridge')).replace(/\/+$/, '');
      const health = await probe(bridge);
      if (health.ok) vscode.window.showInformationMessage(`aipass: ready — ${health.status.extensions} tab(s) attached.`);
      else vscode.window.showWarningMessage(`aipass: ${health.reason}.`);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
