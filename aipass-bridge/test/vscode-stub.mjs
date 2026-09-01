// A stand-in for the `vscode` module, enough of it to load and drive
// vscode/extension.js outside VS Code.
//
// Same idea as FakeExtension in harness.mjs: the thing under test talks to the
// real API shape, and the double records what it was asked to do — so a test
// can assert on behaviour rather than on a mock of it.
import fs from 'node:fs';
import path from 'node:path';

const toUriPath = (p) => {
  const slashed = p.replace(/\\/g, '/');
  return slashed.startsWith('/') ? slashed : `/${slashed}`;
};
const fromUriPath = (p) => (path.sep === '\\' ? p.replace(/^\//, '').replace(/\//g, '\\') : p);

class Uri {
  constructor(scheme, uriPath) {
    this.scheme = scheme;
    this.path = uriPath;
  }
  static file(p) { return new Uri('file', toUriPath(path.resolve(p))); }
  // chatview.js builds media/ paths with this.
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, [base.path.replace(/\/+$/, ''), ...parts].join('/'));
  }
  static from({ scheme, path: p }) { return new Uri(scheme, p); }
  get fsPath() { return fromUriPath(this.path); }
  with({ scheme }) { return new Uri(scheme ?? this.scheme, this.path); }
  toString() { return `${this.scheme}:${this.path}`; }
}

class EventEmitter {
  constructor() { this.listeners = []; this.fired = []; }
  get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(value) { this.fired.push(value); for (const fn of this.listeners) fn(value); }
  dispose() {}
}

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(a, b, c, d) { this.start = new Position(a, b); this.end = new Position(c, d); }
}

// Records the edit rather than applying it; workspace.applyEdit below is what
// actually touches disk, so a test can assert on either.
class WorkspaceEdit {
  constructor() { this.ops = []; }
  createFile(uri, opts) { this.ops.push({ op: 'create', uri, opts }); }
  insert(uri, position, text) { this.ops.push({ op: 'insert', uri, position, text }); }
  replace(uri, range, text) { this.ops.push({ op: 'replace', uri, range, text }); }
}

export function createVscodeStub({ root, config = {} } = {}) {
  const recorded = {
    participants: [],
    webviewProviders: new Map(),
    commands: new Map(),
    providers: new Map(),
    info: [],
    warn: [],
    error: [],
    terminals: [],
    appliedEdits: [],
  };

  const defaults = {
    bridge: 'http://127.0.0.1:8787',
    model: '',
    maxSteps: 10,
    maxResult: 3000,
    allowRun: false,
    showModelMarkers: false,
  };
  const settings = { ...defaults, ...config };

  const vscode = {
    Uri,
    EventEmitter,
    Position,
    Range,
    WorkspaceEdit,
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    ThemeIcon: class { constructor(id) { this.id = id; } },

    workspace: {
      workspaceFolders: root ? [{ uri: Uri.file(root), name: path.basename(root), index: 0 }] : undefined,
      getConfiguration() { return { get: (key) => settings[key] }; },
      fs: {
        async readFile(uri) { return new Uint8Array(fs.readFileSync(uri.fsPath)); },
        async stat(uri) {
          const st = fs.statSync(uri.fsPath); // throws when missing, as the real one does
          return { type: st.isDirectory() ? 2 : 1, size: st.size, ctime: 0, mtime: 0 };
        },
        async readDirectory(uri) {
          return fs.readdirSync(uri.fsPath, { withFileTypes: true })
            .map((e) => [e.name, e.isDirectory() ? 2 : 1]);
        },
      },
      async openTextDocument(uri) {
        const text = fs.readFileSync(uri.fsPath, 'utf8');
        return { uri, lineCount: text.split('\n').length, getText: () => text };
      },
      async applyEdit(edit) {
        recorded.appliedEdits.push(edit);
        for (const op of edit.ops) {
          const target = op.uri.fsPath;
          if (op.op === 'create') {
            if (op.opts?.ignoreIfExists && fs.existsSync(target)) continue;
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, '');
          } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, op.text);
          }
        }
        return true;
      },
      registerTextDocumentContentProvider(scheme, provider) {
        recorded.providers.set(scheme, provider);
        return { dispose() {} };
      },
    },

    chat: {
      createChatParticipant(id, handler) {
        const participant = { id, handler, dispose() {} };
        recorded.participants.push(participant);
        return participant;
      },
    },

    commands: {
      registerCommand(name, fn) {
        recorded.commands.set(name, fn);
        return { dispose() {} };
      },
      async executeCommand(name, ...args) {
        recorded.commands.get('__executed__')?.(name, args);
        recorded.executed = [...(recorded.executed ?? []), { name, args }];
        return undefined;
      },
    },

    window: {
      registerWebviewViewProvider(id, provider, options) {
        recorded.webviewProviders.set(id, { provider, options });
        return { dispose() {} };
      },
      showInformationMessage(m) { recorded.info.push(m); },
      showWarningMessage(m) { recorded.warn.push(m); },
      showErrorMessage(m) { recorded.error.push(m); },
      createTerminal(opts) {
        const t = { ...opts, sent: [], show() {}, sendText(text) { t.sent.push(text); }, dispose() {}, exitStatus: undefined };
        recorded.terminals.push(t);
        return t;
      },
    },
  };

  return { vscode, recorded, settings };
}

// What the chat API hands a participant. Records everything written to it.
export function createStream() {
  const parts = { markdown: [], progress: [], buttons: [], references: [] };
  return {
    parts,
    markdown(v) { parts.markdown.push(typeof v === 'string' ? v : String(v?.value ?? v)); },
    progress(v) { parts.progress.push(v); },
    button(v) { parts.buttons.push(v); },
    reference(v) { parts.references.push(v); },
    anchor(v) { parts.references.push(v); },
    text: () => parts.markdown.join(''),
  };
}

export function createToken() {
  const listeners = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested(fn) { listeners.push(fn); return { dispose() {} }; },
    cancel() { this.isCancellationRequested = true; for (const fn of listeners) fn(); },
  };
}

export function createContext(extensionPath) {
  return { extensionPath, subscriptions: [], extensionUri: Uri.file(extensionPath) };
}

// What VS Code hands a WebviewViewProvider. Records what the extension posts
// out, and `send` plays a message back in as if the panel's script sent it.
export function createWebviewView() {
  const posted = [];
  let onMessage = null;
  let onDispose = null;

  const view = {
    posted,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://unit-test',
      asWebviewUri: (uri) => `vscode-webview:/${uri.path}`,
      postMessage(message) { posted.push(message); return Promise.resolve(true); },
      onDidReceiveMessage(fn) { onMessage = fn; return { dispose() {} }; },
    },
    onDidDispose(fn) { onDispose = fn; return { dispose() {} }; },

    /** Play a message in from the panel and wait for the handler to settle. */
    send: (message) => Promise.resolve(onMessage?.(message)),
    dispose: () => onDispose?.(),
    /** Every message of one type, in order. */
    of: (type) => posted.filter((m) => m.type === type),
    last: (type) => posted.filter((m) => m.type === type).at(-1),
  };
  return view;
}
