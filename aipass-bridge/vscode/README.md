# aipass bridge for VS Code

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

## Use it

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
