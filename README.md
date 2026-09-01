# aipass-bridge

Use [de.aipass.net](https://de.aipass.net/chat) from your terminal — streaming
chat, model switching, and a file-editing agent — without a single credential
leaving the browser.

> ฉบับภาษาไทย: [README-th.md](README-th.md)

```
terminal ──HTTP──▶ bridge (node, no deps, :8787)
                      │  SSE: jobs out, POST: deltas back
                      ▼
                   Chrome extension service worker
                      │  chrome.runtime
                      ▼
                   de.aipass.net tab ──▶ /actions/send-message/<id>
```

The bridge never sees a session cookie. The real request runs as ordinary page
JavaScript inside an open de.aipass.net tab, so Chrome attaches the cookie
itself. Nothing is stored on disk.

## Repository layout

| path | what it is |
|---|---|
| [aipass-bridge/bridge/server.mjs](aipass-bridge/bridge/server.mjs) | the bridge — HTTP server, job hub, OpenAI-compatible surface |
| [aipass-bridge/extension/](aipass-bridge/extension/) | Chrome MV3 extension (service worker + MAIN/ISOLATED content scripts) |
| [aipass-bridge/chat.mjs](aipass-bridge/chat.mjs) | terminal chat client |
| [aipass-bridge/agent.mjs](aipass-bridge/agent.mjs) | file-editing agent with a dry-run overlay filesystem |
| [aipass-bridge/list.mjs](aipass-bridge/list.mjs) | printers for `npm run models` / `conversations` |
| [aipass-bridge/agent/core.mjs](aipass-bridge/agent/core.mjs) | the agent loop, with no host in it — shared by the CLI and the editor |
| [aipass-bridge/vscode/](aipass-bridge/vscode/) | VS Code extension: `@aipass` chat participant, staged edits |
| [aipass-bridge/test/](aipass-bridge/test/) | 67 tests driving the real bridge as a subprocess |
| [aipass-bridge/handoff.html](aipass-bridge/handoff.html) | standalone field guide: architecture, the 403 investigation, next steps |
| [app/](app/) | the Next.js 16 app this repo was scaffolded from — untouched |

Full documentation lives in [aipass-bridge/README.md](aipass-bridge/README.md).

## Setup

```bash
npm run dev
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked**
→ select [aipass-bridge/extension](aipass-bridge/extension). Open a
`https://de.aipass.net/chat` tab and leave it open; the popup should read
**connected**.

## Scripts

| script | |
|---|---|
| `npm run dev` | start the bridge on :8787 |
| `npm run chat` | terminal client — `/models` lists, `/model <id>` switches, Ctrl+C quits |
| `npm run agent -- "task" --root .` | local file tools, in a fresh conversation |
| `npm run models` | list models, marking free-credit ones |
| `npm run conversations` | list conversations and which is in use |
| `npm test` | run the test suite |
| `npm run dev:next` | start the Next.js app |

The same agent runs inside VS Code — see [aipass-bridge/vscode/](aipass-bridge/vscode/).

```bash
npm run chat -- "ช่วยสรุปข่าว AI วันนี้"   # one-shot
```

You get whatever the web UI gives you for the same message, including its
server-side tools. A `web_search` streams live and its sources are listed at the
end. Tool activity is sent as `reasoning_content`, so an OpenAI client reading
only `content` sees a clean answer.

## The constraint everything is built around

Only the user's message is sent — no system prompt, no transcript.

That is what the endpoint accepts, not a shortcut. A `messages` array containing
an **assistant** turn is rejected upstream with a bare `403` from Google
Frontend, before the model sees it. Multi-turn still works, because the server
owns the conversation and its history exactly as it does for the web UI.

## The agent

```bash
npm run agent -- "add a health route that returns ok" --root .
```

Dry run by default: edits land in an in-memory overlay so the model can read
back its own pending work, you get a unified diff at the end, and nothing
touches disk until `--apply`. Paths are confined to `--root`; shell access needs
`--allow-run`.

It works within the constraint rather than against it:

- **Instructions are sent once**, as the first message of the conversation.
  Later turns carry only tool results — a couple hundred bytes, not a resent
  prompt.
- **The format is prose-shaped** (`NEED file README.md`, `EDIT`/`FIND`/`NEW`).
  No angle brackets, no `key=value`, no absolute paths — every one of those drew
  a 403, and none was load-bearing.
- **It never claims the model has tools.** The model's own system prompt says
  its tool is `web_search`, so a preamble written like a tool protocol makes it
  refuse on the grounds that it has no file access. The preamble states the
  division of labour plainly instead.
- **A rejected turn is split and resent**, halving recursively down to ~300
  bytes. The server remembers each part, so the model still sees the whole thing.
- **Loopback addresses are substituted.** `localhost`, `127.0.0.1`, `0.0.0.0`,
  `169.254.169.254`, `file://` go out as `LCLHST`, `LOOPBACK-IP` and so on, and
  are restored before anything is written — a README saying *"open
  http://localhost:3000"* is enough on its own to get a request rejected.
- **Lines that cannot be sent at any size are dropped** with a note —
  `node -e`, `curl`, `rm -rf`, `/bin/sh`, `../../`. One bad line costs a line,
  not the run.

Each run starts a fresh conversation, since reusing one drags in prior history
— including a refusal the model then sees itself having made and repeats.
`--reuse` continues the most recent, `--conversation ID` a specific one.

## In VS Code

`@aipass` in the chat panel — same agent loop, edits staged as a reviewable diff
before anything touches disk:

```
@aipass what does the bridge do when the extension disconnects mid-stream?
@aipass add a health route that returns ok
@aipass /apply rename the log helper to `note`
```

Open [aipass-bridge/vscode/](aipass-bridge/vscode/) in VS Code and press F5.
`/status` checks the bridge and the tab, `/models` lists what the account can
use, `/apply` writes straight to disk. Applying goes through a `WorkspaceEdit`,
so ctrl+Z backs it out like any other edit.

VS Code is a **fourth hop**, not a replacement for the browser: the extension
host has no de.aipass.net cookie jar, so the bridge and an open tab are still
required. What it does replace is the terminal.

`npm run package` in that folder builds an installable `.vsix` — it is not
Marketplace material, since it does nothing without the bridge and a browser tab.

The loop lives in [aipass-bridge/agent/core.mjs](aipass-bridge/agent/core.mjs),
which carries no host — no `node:fs`, no `console`, no `process.argv`. The CLI
injects `node:fs` and an ANSI printer; the extension injects `workspace.fs` and a
chat response stream. Both run the same code.

## HTTP surface

`POST /v1/chat/completions` and `GET /v1/models` make the bridge usable from any
OpenAI-compatible client at `http://127.0.0.1:8787/v1` (only the last user
message is forwarded). Also: `/conversations`, `/conversations/new`, `/config`,
`/status`, and the `/ext/*` endpoints the extension talks to.

| env | default | |
|---|---|---|
| `AIPASS_PORT` | `8787` | |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | used when no model is given |
| `AIPASS_MODELS` | two known ids | fallback when no extension is attached |
| `AIPASS_MODEL_FILTER` | `chat` | `all` keeps image/video/audio models |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | `text` or `off` |
| `AIPASS_CONVERSATION_ID` | *(unset)* | pin one conversation |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | fail a job after this long with no delta |

## Tests

```bash
npm test
```

67 tests, no dependencies, about 2 seconds.
[test/harness.mjs](aipass-bridge/test/harness.mjs) runs the real bridge as a
subprocess alongside a scriptable stand-in for the extension, and
[test/vscode-stub.mjs](aipass-bridge/test/vscode-stub.mjs) does the same for the
VS Code API — so tests drive the actual HTTP surface, the real CLIs and the real
editor extension rather than mocks of them.

They cover the failures this thing actually hit: only the newest user message
being forwarded; conversation rotation past a locked one; a job surviving the
extension disconnecting mid-stream; loopback substitution round-tripping;
splitting a rejected turn; dropping an unsendable line; a premature `DONE`;
refusing paths outside the root; dry run leaving disk untouched; and, on the
editor side, an edit staying staged until it is applied and a follow-up turn
continuing the same conversation instead of opening a second one.

## Known limits

- A de.aipass.net tab must stay open. Its content script holds a port that keeps
  the MV3 service worker alive; without it Chrome evicts the worker every ~30s.
- Every message appears in the account's chat history — this uses the real
  product.
- Long sessions burn credits. Only `gemini-3.1-flash-lite` is free-credit;
  `npm run models` marks it.
