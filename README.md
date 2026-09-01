# aipass-bridge

Use [de.aipass.net](https://de.aipass.net/chat) from your terminal, your editor,
or any OpenAI-compatible client — without a single credential leaving the
browser.

> ฉบับภาษาไทย: [README-th.md](README-th.md)

```
you ──HTTP──▶ bridge (node, no deps, :8787)
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

**Contents** — [Before you start](#before-you-start) ·
[Install](#install) · [Chat](#chat-from-the-terminal) ·
[Edit files](#edit-files-with-the-agent) · [VS Code](#vs-code) ·
[Tray app](#tray-app) ·
[OpenAI clients](#use-it-from-any-openai-compatible-client) ·
[Conversations](#conversations) · [Configuration](#configuration) ·
[Troubleshooting](#troubleshooting) · [How it works](#how-it-works) ·
[Tests](#tests) · [Limits](#known-limits)

---

## Before you start

| you need | why |
|---|---|
| **Node 20+** | top-level await, global `fetch`, the built-in test runner. Verified on v24.12.0. |
| **Google Chrome** | the extension is MV3 and must run in Chrome; there is no substitute — see [How it works](#how-it-works). |
| **A working de.aipass.net account** | you must be able to open [de.aipass.net/chat](https://de.aipass.net/chat) and send a message by hand first. |

There is nothing to install with npm for the bridge itself — it has no
dependencies. `npm install` is only needed if you also want to run the Next.js
app in [app/](app/).

> **Everything you send appears in that account's real chat history.** This
> drives the actual product, not a sandbox.

---

## Install

### 1 · Get the code and start the bridge

```bash
git clone https://github.com/RikuAlice01/aipass-bridge.git
cd aipass-bridge
npm run dev
```

> Prefer it in the taskbar instead of a terminal? `npm run bridge:build` gives
> you a 1.1 MB `.exe` that lives in the tray and needs no Node —
> see [Tray app](#tray-app).

You should see:

```
aipass bridge on http://127.0.0.1:8787
  default model : gemini-3.1-flash-lite
  conversation  : most recent on the account
  waiting for the Chrome extension…
```

Leave this running. Every other command talks to it.

### 2 · Load the Chrome extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the [aipass-bridge/extension](aipass-bridge/extension) folder

### 3 · Open a de.aipass.net tab and leave it open

Go to [https://de.aipass.net/chat](https://de.aipass.net/chat) and sign in if you
are not already. **Keep this tab open** — the bridge cannot work without it, and
closing it stops everything mid-request.

### 4 · Check that it worked

Click the extension icon. The popup should show:

| field | what you want to see |
|---|---|
| connection | a green dot and **connected** |
| tab | `/chat` |
| jobs | `0` |
| Default model | a populated dropdown |

Then:

```bash
npm run chat -- "hello"
```

A streamed reply means all four hops work. If anything is off, jump to
[Troubleshooting](#troubleshooting).

---

## Chat from the terminal

### One-shot

```bash
npm run chat -- "ช่วยสรุปข่าว AI วันนี้"
npm run chat -- "what is the difference between SSE and WebSocket?"
```

### Interactive

```bash
npm run chat
```

```
aipass  model gemini-3.1-flash-lite  ·  conversation 7f3a1c9e2b5d4a80
/model <id> to switch  ·  /models to list  ·  Ctrl+C to quit

> what is aipass?
```

| in interactive mode | |
|---|---|
| `/models` | list every model the account can use |
| `/model <id>` | switch model, and make it the bridge's default |
| Ctrl+C | quit |

### Flags

| flag | default | |
|---|---|---|
| `--model <id>` | the bridge's default | model for this run |
| `--new` | off | start a fresh conversation instead of continuing |
| `--conversation <id>` | most recent | continue one specific conversation |
| `--bridge <url>` | `http://127.0.0.1:8787` | where the bridge is |

```bash
npm run chat -- --model claude-sonnet-5@default "explain this codebase"
npm run chat -- --new                  # clean slate, interactive
```

### What you get

Whatever the web UI gives you for the same message, **including its server-side
tools**. A `web_search` streams live and its sources are listed at the end:

```
[web_search] {"query":"aipass.go.th"}
[web_search] returned 4821 chars
AiPASS เป็นแพลตฟอร์มภายใต้โครงการ TH-AI Passport …
sources:
  - Aipass https://aipass.go.th/
```

Tool activity is sent as `reasoning_content`, so an OpenAI client that only
reads `content` sees a clean answer. Change this with
[`AIPASS_TOOL_VISIBILITY`](#configuration).

---

## Edit files with the agent

```bash
npm run agent -- "add a health route that returns ok" --root .
```

**It is a dry run by default.** Edits go to an in-memory overlay, so the model
can read back its own pending work; at the end you get a unified diff and
nothing has touched disk. Add `--apply` to write.

### A full run, start to finish

```bash
npm run agent -- "what does the bridge do when the extension disconnects?" --root .
```

```
task  what does the bridge do when the extension disconnects?
root  E:\github\aipass-bridge
mode  dry run (pass --apply to write)
chat  a41f2c8b91d3e07f  (new)

─── step 1/10 ────────────────────────────────
  ✓ list . README.md
─── step 2/10 ────────────────────────────────
  ✓ read aipass-bridge/bridge/server.mjs // Local bridge to de.aipass.net's chat.

✓ The job is kept and retried on the next client; it only fails after
  AIPASS_IDLE_TIMEOUT_MS with no delta.

no file changes
```

When it does change something:

```
1 file(s) changed:

--- a/app/health/route.ts
+++ b/app/health/route.ts
@@ -1,0 +1,3 @@
+export function GET() {
+  return Response.json({ ok: true });
+}

dry run — nothing written. re-run with --apply
```

### Flags

| flag | default | |
|---|---|---|
| `--root <dir>` | cwd | the only directory the agent may read or write |
| `--apply` | off | write the changes to disk |
| `--model <id>` | bridge default | model for this run |
| `--max <n>` | `10` | how many read/edit rounds before it stops |
| `--max-result <n>` | `3000` | truncate each tool result to this many bytes |
| `--allow-run` | off | let the model run shell commands |
| `--reuse` | off | continue the most recent conversation |
| `--conversation <id>` | — | continue one specific conversation |
| `--bridge <url>` | `http://127.0.0.1:8787` | where the bridge is |

### Things worth knowing

- **`--root` is a hard boundary.** A path that escapes it is refused, not
  clamped. Run it from the project you mean.
- **Every run starts a fresh conversation** unless you pass `--reuse` or
  `--conversation`. Reusing one drags in whatever was said before — including a
  refusal, which the model then sees itself having made and repeats.
- **`--allow-run` is genuinely dangerous.** The model picks the command and it
  runs in your shell, in `--root`. Leave it off unless you are watching.
- **`--max-result` exists because of upstream filtering**, not just token cost.
  Raising it makes rejections more likely.
- Review the diff before `--apply`. The model is writing whole line ranges.

---

## VS Code

A chat panel in the activity bar, driving the same agent loop. Edits are staged
and shown as a diff before anything touches disk. `@aipass` in VS Code's own
chat view still works too.

### Run it from source

Open [aipass-bridge/vscode/](aipass-bridge/vscode/) in VS Code and press **F5**.
An Extension Development Host window opens with the participant registered.

### Or install it

```bash
cd aipass-bridge/vscode
npm run package          # -> aipass-bridge-vscode-0.1.0.vsix
```

Then **Extensions: Install from VSIX…** in the command palette.

### Using it

Click the AI Bridge icon in the activity bar. Enter sends, Shift+Enter breaks the
line; tool activity collapses into a **steps** block, edits arrive as a staged
list with **Review** / **Apply** / **Discard**, and **New chat** opens a fresh
conversation. The panel follows the editor's theme.

A dropdown picks the model — it writes the `aipass.model` setting rather than
moving the bridge's default, so it does not change what the CLI gets.

Two modes: **Agent** reads and edits files, **Ask** sends the question straight
to the model with no preamble and no tools — for anything that is not about the
code. Within one conversation the instructions go out once, so a follow-up turn
carries only the question.

The same thing from VS Code's own chat view:

```
@aipass /status
@aipass what does the bridge do when the extension disconnects mid-stream?
@aipass add a health route that returns ok
@aipass /apply rename the log helper to `note`
```

Ask `@aipass /status` first — it tells you whether the bridge is up and a tab is
attached, which is the failure that accounts for most confusion.

| command | |
|---|---|
| `/status` | bridge reachable? tab attached? which conversation? |
| `/models` | what the account can use, and which are free-credit |
| `/apply` | run the task and write straight to disk |

Without `/apply`, edits are staged and you get **Review** (opens a real diff
editor), **Apply**, and **Discard** buttons. Applying goes through a
`WorkspaceEdit`, so ctrl+Z backs it out like any other edit.

### Settings

| setting | default | |
|---|---|---|
| `aipass.bridge` | `http://127.0.0.1:8787` | where the bridge is |
| `aipass.model` | *(empty)* | empty means the bridge's default |
| `aipass.maxSteps` | `10` | read/edit rounds per request |
| `aipass.maxResult` | `3000` | bytes per tool result sent upstream |
| `aipass.allowRun` | `false` | let the agent send commands to a terminal |
| `aipass.showModelMarkers` | `false` | show the raw `NEED`/`EDIT`/`DONE` protocol |

`allowRun` sends the command to a visible **aipass** terminal, and its output is
*not* read back into the conversation — the model cannot see what it ran.

One chat session maps to one conversation: the first turn opens it, later turns
continue it. Start a new chat to get a clean one.

Details in [aipass-bridge/vscode/README.md](aipass-bridge/vscode/README.md).

---

## Tray app

The bridge also exists as a single Windows executable that sits in the taskbar,
so nothing has to keep a terminal open:

```bash
npm run bridge:build     # -> aipass-bridge/rust/target/release/aipass-bridge.exe
npm run bridge:tray      # build and run it
```

Double-click it and it runs in the tray. Hover for status — **no browser tab
attached**, **ready · n tabs**, or **n job(s) in flight** — and its menu shows
the conversation in use and offers **Copy bridge URL**,
**Open de.aipass.net/chat** and **Quit**.

`logo.png` at the repo root is the project's one piece of artwork.
[tools/icons.py](tools/icons.py) renders everything else from it — the
multi-size `icon.ico` compiled into the `.exe`, and the PNGs both extensions
use. Run it after changing the logo; nothing is hand-edited.

It is a port, not a rewrite: same routes, same `AIPASS_*` variables, same
behaviour, and no credential reaches it either. How that is kept honest —
there is no second test suite, the existing one runs against both:

```bash
npm test            # 90 against the Node bridge
npm run test:rust   # the same 76 against the Rust one
```

Details in [aipass-bridge/rust/README.md](aipass-bridge/rust/README.md).

## Use it from any OpenAI-compatible client

The bridge serves `POST /v1/chat/completions` and `GET /v1/models`:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-3.1-flash-lite","messages":[{"role":"user","content":"hello"}]}'
```

Streaming works too — add `"stream": true` and you get standard SSE chunks
ending in `data: [DONE]`.

Point any SDK at it:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
client.chat.completions.create(model="gemini-3.1-flash-lite",
                               messages=[{"role": "user", "content": "hello"}])
```

There is no auth — the bridge binds to `127.0.0.1` and the credential lives in
the browser, so `api_key` can be anything.

> **Only the last user message is forwarded.** A system prompt or a prior
> assistant turn in `messages` is dropped, not sent. This is a hard limit of the
> endpoint, not a shortcut — see [How it works](#how-it-works). Multi-turn still
> works because the server remembers the conversation itself.

A leading `aipass/` on the model id is stripped, for clients that insist on a
provider prefix.

---

## Conversations

The server owns conversation history, exactly as it does for the web UI.

```bash
npm run conversations
```

```
* 7f3a1c9e2b5d4a80  2026-08-31T14:22  Bridge questions
  a41f2c8b91d3e07f  2026-08-31T09:05  New chat
```

The `*` marks the one in use. To create one without sending a real message:

```bash
curl -s localhost:8787/conversations/new \
  -H 'content-type: application/json' -d '{"message":"hello"}'
```

Which one gets used:

| | |
|---|---|
| `npm run chat` | the most recent, so a chat stays a chat |
| `npm run chat -- --new` | a fresh one |
| `npm run agent` | **always a fresh one**, unless `--reuse`/`--conversation` |
| VS Code | one conversation per chat session |
| `AIPASS_CONVERSATION_ID` | pins one, overriding all of the above |

If a conversation stops accepting messages — `404` when deleted, `409` when the
server still thinks a generation is running — the bridge moves to the next most
recent on its own.

---

## Configuration

| env | default | |
|---|---|---|
| `AIPASS_PORT` | `8787` | |
| `AIPASS_HOST` | `127.0.0.1` | |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | used when no model is given |
| `AIPASS_MODELS` | two known ids | fallback list when no extension is attached |
| `AIPASS_MODEL_FILTER` | `chat` | `all` keeps image/video/audio models |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | `text` inlines tool activity, `off` drops it |
| `AIPASS_CONVERSATION_ID` | *(unset)* | pin one conversation |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | fail a job after this long with no delta |

```bash
AIPASS_PORT=9000 AIPASS_TOOL_VISIBILITY=off npm run dev
```

The popup can also change the default model and the bridge URL at runtime.

### All scripts

| script | |
|---|---|
| `npm run dev` | start the bridge on :8787 |
| `npm run chat` | terminal client |
| `npm run agent -- "task" --root .` | local file tools |
| `npm run models` | list models, marking free-credit ones |
| `npm run conversations` | list conversations and which is in use |
| `npm test` | run the test suite |
| `npm run bridge:build` | build the Rust tray app |
| `npm run bridge:tray` | build and run it |
| `npm run test:rust` | run the suite against the Rust bridge |
| `npm run dev:next` | start the Next.js app in [app/](app/) |

---

## Troubleshooting

| what you see | what it means | what to do |
|---|---|---|
| `No bridge at http://127.0.0.1:8787` | the bridge is not running | `npm run dev` |
| `The extension is not connected` | no de.aipass.net tab, or Chrome evicted the worker | open [de.aipass.net/chat](https://de.aipass.net/chat) and check the popup says **connected** |
| `no extension connected — open a de.aipass.net tab and check the popup` | the tab closed mid-request | reopen it and retry |
| popup: `bridge not reachable — is server.mjs running?` | same as the first row, from the browser's side | `npm run dev`, then **Refresh** in the popup |
| popup says **not connected** with a tab open | the tab predates the extension, or Chrome discarded it | reload the de.aipass.net tab |
| the reply stops partway and nothing else happens | no delta for `AIPASS_IDLE_TIMEOUT_MS` | check the tab is still alive; raise the timeout for long answers |
| `Conversation not found` | the id was deleted or invented | `npm run conversations` to see real ones, or `--new` |
| `403 … CHAT_UNAUTHORIZED … Conversation has been deleted` | that conversation was deleted on the account | nothing — the bridge rotates to the next one on its own |
| agent: `rejected — splitting into 2 parts` | a file tripped an upstream filter | nothing — it recovers on its own |
| agent: `omitting 1 line(s) that cannot be sent` | a line looked like code execution | expected; the rest of the file still goes through |
| agent: `this fragment was rejected even on its own` | a single line cannot pass at any size | it is printed so you can see which |
| agent: `no marker after three replies` | the model drifted out of the protocol | try another `--model`, or rerun — each run is a fresh conversation |
| agent: `path escapes root` | the model asked for a file outside `--root` | working as intended |
| VS Code: `Cannot reach aipass` | bridge or tab | `@aipass /status` says which |
| VS Code: `Open a folder first` | no workspace folder | open the project folder, not a loose file |

**Tests fail to even start** — you are probably on an old checkout. Both the
Windows path bug in the harness and the `process.exit` crash in `chat.mjs` are
fixed; run `npm test` and expect 90 passing in about two seconds.

---

## How it works

### Why the browser is not optional

Authentication is a same-origin session cookie. The extension's `page.js` runs
in the **MAIN world** of a de.aipass.net tab, so its `fetch` is a genuine
first-party request and Chrome attaches the cookie — the bridge never sees it,
and nothing is written to disk.

The socket to the bridge lives in the **service worker** instead, because an
`https://` page talking to `http://127.0.0.1` runs into mixed-content and
Private Network Access checks that an extension request does not. The content
script also holds a port open, because Chrome evicts an idle MV3 worker after
~30 seconds and inbound SSE does not count as activity.

### The constraint everything is built around

Only the user's message is sent — no system prompt, no transcript.

That is what the endpoint accepts. A `messages` array containing an **assistant**
turn is rejected upstream with a bare `403` from Google Frontend, before the
model sees it. Multi-turn works because the server owns the conversation.

The agent lives within this rather than fighting it: instructions are sent once
as the first message; the marker format is prose-shaped because every structural
shape drew a 403; a rejected turn is halved and resent; `localhost` and friends
are substituted on the way out because SSRF filters match on them; and lines that
cannot be sent at any size are dropped with a note rather than failing the run.

Each of those is a scar. The reasoning is in
[aipass-bridge/README.md](aipass-bridge/README.md) and the investigation is laid
out in [aipass-bridge/handoff.html](aipass-bridge/handoff.html).

### Layout

| path | |
|---|---|
| [aipass-bridge/bridge/server.mjs](aipass-bridge/bridge/server.mjs) | the bridge — HTTP server, job hub, OpenAI surface |
| [aipass-bridge/extension/](aipass-bridge/extension/) | Chrome MV3 extension |
| [aipass-bridge/agent/core.mjs](aipass-bridge/agent/core.mjs) | the agent loop, with no host in it |
| [aipass-bridge/agent.mjs](aipass-bridge/agent.mjs) | CLI front end for it |
| [aipass-bridge/chat.mjs](aipass-bridge/chat.mjs) | terminal chat client |
| [aipass-bridge/vscode/](aipass-bridge/vscode/) | VS Code extension |
| [aipass-bridge/rust/](aipass-bridge/rust/) | the same bridge in Rust, as a tray app |
| [aipass-bridge/test/](aipass-bridge/test/) | 90 tests |
| [app/](app/) | the Next.js app this repo was scaffolded from — untouched |

---

## Tests

```bash
npm test
```

90 tests, no dependencies, about two seconds.
[test/harness.mjs](aipass-bridge/test/harness.mjs) runs the real bridge as a
subprocess alongside a scriptable stand-in for the extension, and
[test/vscode-stub.mjs](aipass-bridge/test/vscode-stub.mjs) does the same for the
VS Code API — so tests drive the actual HTTP surface, the real CLIs and the real
extension rather than mocks of them.

They cover the failures this thing actually hit: only the newest user message
being forwarded; conversation rotation past a locked one; a job surviving the
extension disconnecting mid-stream; loopback substitution round-tripping;
splitting a rejected turn; dropping an unsendable line; a premature `DONE`;
refusing paths outside the root; dry run leaving disk untouched; an editor edit
staying staged until applied; and the packaged `.vsix` layout loading at all.

---

## Known limits

- **A de.aipass.net tab must stay open.** Close it and everything stops.
- **Every message appears in the account's chat history.** This is the real
  product.
- **Long sessions burn credits.** Only `gemini-3.1-flash-lite` is free-credit;
  `npm run models` marks it.
- **No system prompt, no transcript.** See
  [the constraint](#the-constraint-everything-is-built-around).
- **The VS Code extension is not Marketplace material** — it does nothing
  without the bridge and a browser tab.
- **Chrome only.** The extension is MV3 and the whole credential story depends
  on it.
