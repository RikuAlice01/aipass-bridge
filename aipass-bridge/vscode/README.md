# AI Bridge for VS Code

`@aipass` in the chat panel: ask about the workspace, or ask for an edit. Reads
and edits go through the same agent loop the CLI uses, and land as a staged diff
you review before anything touches disk.

## It does not replace the browser

VS Code is a **fourth hop**, not a substitute for any existing one:

```
VS Code ──HTTP──▶ bridge :8787 ──SSE──▶ Chrome extension ──▶ de.aipass.net tab
```

The whole point of this project is that the session cookie never leaves the
browser — the real request runs as first-party page JavaScript, so Chrome
attaches it. The VS Code extension host has no de.aipass.net cookie jar and a
webview cannot get one either. So the bridge and an open de.aipass.net tab are
still required; this extension only replaces the terminal.

## Setup

1. Start the bridge: `npm run dev` in the repo root.
2. Load the Chrome extension and open a `https://de.aipass.net/chat` tab.
3. Open this folder in VS Code and press **F5** — an Extension Development Host
   launches with the participant registered.

Check all three with `@aipass /status`.

## The panel

Click the AI Bridge icon in the activity bar. Type a question, press Enter —
Shift+Enter for a new line. Tool activity collapses into a **steps** block so a
long run does not bury the answer it produced, edits arrive as a staged list
with **Review** / **Apply** / **Discard**, and **New chat** starts a fresh
conversation.

Tick **write changes straight to disk** to skip staging.

### Picking a model

The dropdown next to the mode toggle lists what the account can use, marking
the free-credit ones. **default** follows whatever the bridge is set to, and
names it.

The choice is written to the `aipass.model` setting, not to the bridge's
`/config`. Moving the bridge's own default would silently change what
`npm run chat` and every other OpenAI client on the machine gets; a choice made
in one editor should not reach that far.

### Agent or Ask

| mode | |
|---|---|
| **Agent** | reads and edits files in the workspace — the full protocol |
| **Ask** | the question goes straight to the model: no preamble, no directory listing, no tools |

Agent mode costs about 1.4kB of file-editing protocol on the turn that opens a
conversation. A question like *"what day is it"* does not want any of that, and
the bytes are not free — a bigger payload is a bigger target for the upstream
filter this project exists to stay under.

Within one conversation the instructions go out **once**. The server keeps the
history, so every later turn is just the question.

The panel takes the editor's theme rather than a palette of its own — a
light-blue card in someone's dark theme reads as a bug.

## Or the chat participant

```
@aipass what does the bridge do when the extension disconnects mid-stream?
@aipass add a health route that returns ok
@aipass /apply rename the log helper to `note`
```

`@aipass` stages edits and gives you **Review** / **Apply** / **Discard**;
`/apply` writes them immediately. Either way the write goes through a
`WorkspaceEdit`, so ctrl+Z backs it out like any other edit.

| command | |
|---|---|
| `/status` | is the bridge up, is a tab attached, which conversation |
| `/models` | what the account can use, and which are free-credit |
| `/apply` | run the task and write straight to disk |

## Settings

| setting | default | |
|---|---|---|
| `aipass.bridge` | `http://127.0.0.1:8787` | where the bridge is listening |
| `aipass.model` | *(empty)* | empty means the bridge's default |
| `aipass.maxSteps` | `10` | read/edit rounds per request |
| `aipass.maxResult` | `3000` | bytes per tool result sent upstream |
| `aipass.allowRun` | `false` | let the agent send commands to a terminal |
| `aipass.showModelMarkers` | `false` | show the raw `NEED`/`EDIT`/`DONE` protocol |

`allowRun` sends the command to a visible **aipass** terminal rather than a
hidden child process, and its output is *not* read back into the conversation —
so the model cannot see what it ran. That is deliberate: piping terminal output
back upstream is exactly the shape that gets a request rejected.

## How it maps onto the constraint

The endpoint accepts one user message and no transcript, and the server owns the
conversation history. So:

- **One chat session is one conversation.** The first turn opens it; later turns
  continue it, which is why follow-up questions work without resending anything.
- **A new chat starts a new conversation**, because reusing one drags in prior
  history — including a refusal, which the model then repeats.
- The instructions go out once, as the first message. Later turns carry only
  tool results.

## The icon

`logo.png` at the repo root is the project's artwork; `icon.png` here is a
128px render of it, because VS Code's `icon` field wants a PNG. `vsce` packages
a `.ico` without complaining, which is not the same as VS Code drawing it well.

Rebuild it with `python tools/icons.py` rather than by hand.

The activity-bar glyph is separate — [media/aipass.svg](media/aipass.svg), a
monochrome speech bubble drawn with `currentColor`, because VS Code masks
container icons to a single colour and the pixel-art face would not survive it.

## Packaging

```bash
npm run package     # -> aipass-bridge-vscode-0.1.0.vsix
```

Install it with **Extensions: Install from VSIX...** in the command palette.

Inside a `.vsix` everything above the extension root is gone, so
`../agent/core.mjs` is not there. `build.mjs` stages a copy at
`vscode/agent/core.mjs`, and `vscode:prepublish` runs it automatically before
packaging. The copy is gitignored — `agent/core.mjs` at the repo level stays the
only source of truth, and `npm run check` fails if the staged copy has drifted.

A test builds that exact layout and drives a request through it, so the packaged
case is verified rather than assumed.

**Not for the Marketplace.** The extension is useless on its own: whoever
installs it also needs the bridge running and the Chrome extension loaded with a
de.aipass.net tab open. Hand out the `.vsix` to people who have those.

## Notes

- The agent is confined to the first workspace folder. A non-`file:` workspace
  is refused, since there is no path to confine it to.
- Reads go through `vscode.workspace.fs`, so remote and WSL workspaces work.
- Cancelling the chat request aborts the run at the next step boundary.
- `agent/core.mjs` is loaded from `../agent/core.mjs` in the repo and from the
  staged copy in a `.vsix`; the loader checks the staged path first.
