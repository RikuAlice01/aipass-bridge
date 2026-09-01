// The chat panel: a webview in the activity bar, driving the same agent loop
// the chat participant does.
//
// Everything it needs is injected rather than imported, so this file has no
// opinion about how the core is loaded or how edits are staged — the same
// seam that lets agent/core.mjs run under both the CLI and the editor.
const vscode = require('vscode');
const path = require('node:path');

function nonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

class ChatViewProvider {
  constructor(deps) {
    this.deps = deps;
    this.view = null;
    this.controller = null;
    // The server owns conversation history, so the panel holds one
    // conversation: the first turn opens it, later turns continue it, and
    // "New chat" drops it so the next turn opens a fresh one.
    this.started = false;
    // Whether that conversation has been given the agent instructions. Kept
    // apart from `started` because Ask mode opens a conversation without ever
    // sending them — treating the two as one would leave a later Agent turn
    // skipping a preamble the server never received.
    this.primed = false;
  }

  post(message) {
    this.view?.webview.postMessage(message);
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => { this.view = null; });
  }

  html(webview) {
    const asset = (name) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, 'media', name));
    const n = nonce();

    // Scripts are nonce-gated and nothing else may load: a webview that can
    // reach the network is a hole in a project whose whole point is that the
    // credential never leaves the browser.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}'; img-src ${webview.cspSource};">
<link rel="stylesheet" href="${asset('chat.css')}">
<title>AI Bridge</title>
</head>
<body>
  <div class="bar">
    <span class="name">AI Bridge</span>
    <span class="pill" id="status"><span class="dot"></span><span>checking…</span></span>
    <button class="icon-btn" id="new" title="Start a new conversation">New chat</button>
  </div>

  <div class="thread" id="thread"></div>

  <div class="composer">
    <div class="box">
      <textarea id="input" rows="1" placeholder="Ask about this workspace, or ask for an edit…"></textarea>
      <button id="send">Send</button>
      <button id="stop" class="ghost" hidden>Stop</button>
    </div>
    <div class="foot">
      <select id="model" title="Model" aria-label="Model">
        <option value="">default</option>
      </select>
      <div class="modes" role="group" aria-label="Mode">
        <button type="button" id="mode-agent" class="mode on" title="Reads and edits files in this workspace">Agent</button>
        <button type="button" id="mode-ask" class="mode" title="Just asks the model — no files, no preamble">Ask</button>
      </div>
      <label class="apply" id="applywrap"><input type="checkbox" id="autoapply"> write straight to disk</label>
      <span class="spacer"></span>
      <span class="tip">Enter to send</span>
    </div>
  </div>

  <script nonce="${n}" src="${asset('chat.js')}"></script>
</body>
</html>`;
  }

  async onMessage(msg) {
    switch (msg.type) {
      case 'ready':   return this.refresh();
      case 'model':   return this.setModel(msg.id);
      case 'ask':     return this.ask(msg.text, msg.apply === true, msg.mode);
      case 'cancel':  return this.controller?.abort();
      case 'new':     return this.newChat();
      case 'apply':   return this.deps.applyStaged();
      case 'discard': return this.deps.discardStaged();
      case 'diff':    return vscode.commands.executeCommand('aipass.showDiff', msg.path);
      default:        return undefined;
    }
  }

  newChat() {
    this.started = false;
    this.primed = false;
    this.post({ type: 'cleared' });
    this.refreshStatus();
  }

  async refresh() {
    await this.refreshStatus();
    return this.refreshModels();
  }

  /// The picker writes to the VS Code setting, not to the bridge's /config.
  /// /config moves the bridge's own default, which would silently change what
  /// `npm run chat` and every other OpenAI client on this machine get; a
  /// choice made in one editor should not reach that far.
  async setModel(id) {
    await vscode.workspace
      .getConfiguration('aipass')
      .update('model', id, vscode.ConfigurationTarget.Global);
    return this.refreshModels();
  }

  async refreshModels() {
    const bridge = this.deps.bridgeUrl();
    try {
      const res = await fetch(`${bridge}/v1/models`);
      if (!res.ok) return;
      const { data } = await res.json();
      const chosen = String(vscode.workspace.getConfiguration('aipass').get('model') || '');
      this.post({
        type: 'models',
        list: (data ?? []).map((m) => ({
          id: m.id,
          name: m.name || m.id,
          free: m.free_credit === true,
        })),
        selected: chosen,
        fallback: this.defaultModel ?? '',
      });
    } catch {
      // The status pill already says the bridge cannot be reached; a second
      // complaint about the same thing is noise.
    }
  }

  async refreshStatus() {
    const bridge = this.deps.bridgeUrl();
    const health = await this.deps.probe(bridge);
    this.defaultModel = health.status?.defaultModel;
    this.post({
      type: 'status',
      ok: health.ok,
      text: health.ok
        ? `ready · ${health.status.extensions} tab${health.status.extensions === 1 ? '' : 's'}`
        : 'not ready',
    });
    return health;
  }

  /// Ask mode: the question goes straight to the model, with no preamble, no
  /// directory listing and no tools. "What day is it" does not need 1.4kB of
  /// file-editing protocol in front of it, and the bytes are not free — a
  /// bigger payload is a bigger target for the upstream filter.
  async askPlain(core, prompt, bridge, cfg) {
    try {
      // Agent mode opens a conversation on its way through runAgent. Ask goes
      // straight to the model, so without this it inherits whatever the bridge
      // can find — and on an account with none, or once rotation has walked
      // past the end of the list, that is nothing.
      if (!this.started) {
        const conv = await core.prepareConversation({
          bridge,
          model: String(cfg().get('model') || '') || null,
          reuse: false,
        });
        if (conv.error) throw new Error(conv.error);
        this.started = true;
      }

      await core.say(prompt, {
        bridge,
        model: String(cfg().get('model') || '') || null,
        signal: this.controller.signal,
        onEvent: (evt) => {
          if (evt.type === 'delta') this.post({ type: 'assistant', text: evt.text });
          else if (evt.type === 'reasoning') {
            this.post({ type: 'step', text: evt.text.split('\n')[0].slice(0, 160) });
          }
        },
      });
      this.post({ type: 'assistant', text: '\n' });
    } catch (err) {
      const aborted = this.controller?.signal.aborted;
      this.post({ type: 'notice', text: aborted ? 'Cancelled.' : String(err?.message ?? err) });
    } finally {
      this.controller = null;
      this.post({ type: 'busy', value: false });
    }
  }

  async ask(prompt, applyStraightAway, mode = 'agent') {
    const { deps } = this;
    const cfg = () => vscode.workspace.getConfiguration('aipass');
    const bridge = deps.bridgeUrl();

    this.post({ type: 'user', text: prompt });

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return this.post({ type: 'notice', text: 'Open a folder first — the agent works inside a workspace root.' });
    }
    if (folder.uri.scheme !== 'file') {
      return this.post({
        type: 'notice',
        text: `This workspace is ${folder.uri.scheme}:, and the agent needs a real folder path to confine itself to.`,
      });
    }

    const health = await this.refreshStatus();
    this.refreshModels();
    if (!health.ok) {
      return this.post({ type: 'notice', text: `Cannot reach aipass: ${health.reason}.` });
    }

    const core = await deps.loadCore();
    this.controller = new AbortController();
    this.post({ type: 'busy', value: true });

    if (mode === 'ask') return this.askPlain(core, prompt, bridge, cfg);

    const { runAgent, prose } = core;

    // Model prose is buffered per step and flushed as prose(), so the panel
    // shows the answer rather than the NEED/EDIT protocol carrying it.
    let buffered = '';
    const flush = () => {
      const text = prose(buffered).trim();
      buffered = '';
      if (text) this.post({ type: 'assistant', text: `${text}\n` });
    };

    const onEvent = (evt) => {
      switch (evt.type) {
        case 'delta':
          buffered += evt.text;
          break;
        case 'step':
          flush();
          break;
        case 'tool':
          flush();
          this.post({ type: 'step', text: `${evt.kind} ${evt.arg || '.'}${evt.ok ? '' : ` — ${evt.head}`}` });
          break;
        case 'reasoning':
          this.post({ type: 'step', text: evt.text.split('\n')[0].slice(0, 160) });
          break;
        case 'notice':
        case 'warn':
          flush();
          this.post({ type: 'step', text: evt.text });
          break;
        case 'cancelled':
          flush();
          this.post({ type: 'notice', text: 'Cancelled.' });
          break;
        case 'error':
          flush();
          this.post({ type: 'notice', text: evt.message });
          break;
        default:
          break;
      }
    };

    let overlay;
    let summary;
    try {
      ({ overlay, summary } = await runAgent({
        task: prompt,
        root: folder.uri.fsPath,
        host: deps.createHost(cfg().get('allowRun') ? deps.terminalRunner : undefined),
        bridge,
        model: String(cfg().get('model') || '') || null,
        maxSteps: Number(cfg().get('maxSteps')) || 10,
        maxResult: Number(cfg().get('maxResult')) || 3000,
        allowRun: cfg().get('allowRun') === true,
        reuse: this.started,
        // The server keeps the history, so the instructions go out once per
        // conversation rather than once per turn.
        primed: this.primed,
        signal: this.controller.signal,
        onEvent,
      }));
      this.started = true;
      this.primed = true;
    } catch (err) {
      flush();
      this.post({ type: 'notice', text: String(err?.message ?? err) });
      return this.post({ type: 'busy', value: false });
    } finally {
      this.controller = null;
    }
    flush();

    if (!overlay.size) {
      if (summary) this.post({ type: 'assistant', text: `${summary}\n` });
      return this.post({ type: 'busy', value: false });
    }

    for (const [abs, text] of overlay) deps.stage(abs, text);

    if (applyStraightAway) {
      const ok = await deps.applyStaged();
      this.post({
        type: 'notice',
        text: ok ? `Wrote ${overlay.size} file(s).` : 'The edit could not be applied — the files may have changed underneath.',
      });
    } else {
      this.post({
        type: 'staged',
        files: [...overlay.keys()].map((abs) => ({
          abs,
          rel: path.relative(folder.uri.fsPath, abs).split(path.sep).join('/'),
        })),
      });
    }
    this.post({ type: 'busy', value: false });
  }
}

module.exports = { ChatViewProvider };
