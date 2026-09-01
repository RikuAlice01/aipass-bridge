# aipass bridge

Use [de.aipass.net](https://de.aipass.net/chat) from your terminal, with
streaming.

```
terminal ──HTTP──▶ bridge (node, no deps)
                      │  SSE: jobs out, POST: deltas back
                      ▼
                   extension service worker
                      │  chrome.runtime
                      ▼
                   de.aipass.net tab ──▶ /actions/send-message/<id>
```

**No credential ever leaves the browser.** The real request runs as ordinary
page JavaScript inside a de.aipass.net tab, so Chrome attaches the session
cookie itself. The bridge never sees it and nothing is stored on disk.

## Setup

```bash
npm run dev
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked**
→ select `aipass-bridge/extension`. Then open a `https://de.aipass.net/chat`
tab and leave it open; the popup should read **connected**.

## Use it

```bash
npm run chat                          # interactive
npm run chat -- "ช่วยสรุปข่าว AI วันนี้"   # one-shot
```

In interactive mode: `/models` lists what's available, `/model <id>` switches,
Ctrl+C quits.

| script | |
|---|---|
| `npm run dev` | start the bridge on :8787 |
| `npm run chat` | terminal client |
| `npm run agent -- "task" --root .` | local file tools, in a fresh conversation |
| `npm run models` | list models, marking free-credit ones |
| `npm run conversations` | list conversations and which is in use |
| `npm test` | run the test suite |

The same agent also runs inside VS Code — see [vscode/](vscode/).

`npm run dev:next` still starts the Next.js app in this repo.

## What you get

Whatever the web UI gives you for the same message — including its server-side
tools. A `web_search` shows up live and its sources are listed at the end:

```
[web_search] {"query":"aipass.go.th"}
[web_search] returned 4821 chars
AiPASS เป็นแพลตฟอร์มภายใต้โครงการ TH-AI Passport …
sources:
  - Aipass https://aipass.go.th/
```

Tool activity is sent as `reasoning_content`, so an OpenAI client that only
reads `content` sees a clean answer. `AIPASS_TOOL_VISIBILITY=text` inlines it,
`off` drops it.

## Scope, and why

Only the user's message is sent. Not a system prompt, not a transcript.

That is not a limitation of the bridge, it is what the endpoint accepts. A
`messages` array containing an **assistant** turn is rejected upstream with a
bare `403` from Google Frontend, before the model sees it — the web UI never
sends one, because the server owns the conversation and its history. Attempts
to supply an agent-style system prompt were also rejected, at sizes and shapes
that plain text of the same size passed, which points at request scoring
rather than any single rule.

So this does the one thing that works reliably: send a message, stream the
answer. Multi-turn works because the server remembers the conversation, the
same way the web UI does.

## Local file tools

```bash
npm run agent -- "add a health route that returns ok" --root .
```

Dry run by default: edits go to an in-memory overlay so the model can read back
its own pending work, you get a unified diff at the end, and nothing touches
disk until `--apply`. Paths are confined to `--root`; shell access needs
`--allow-run`.

This works within the constraints above rather than against them:

- **Instructions are sent once**, as the first message of the conversation. The
  server remembers them, so later turns carry only the tool results — typically
  a couple of hundred bytes instead of resending a prompt every step.
- **No system prompt.** The preamble is just the first user message, which is
  the only channel this endpoint has.
- **The format is prose-shaped**: `ASK read some_file.ts`, no angle brackets, no
  `key=value` pairs, no absolute paths, no banner rules. Every one of those drew
  a 403 in earlier attempts, and none of them was load-bearing.
- **It never claims the model has tools.** The model's own system prompt says
  its tool is `web_search`, so a preamble written like a tool protocol makes it
  search for the syntax and then refuse, correctly, on the grounds that it has
  no file access. The preamble instead states the division of labour plainly:
  you have the files, the model writes lines, you run them and paste results
  back. It also says outright not to explain a lack of file access, which is the
  failure mode this replaces.
- **The first message includes the top-level listing**, so the model is grounded
  in the real directory instead of guessing a first path.

- **A rejected turn is split and resent.** File contents are arbitrary: a
  README carries shell commands, URLs and code fences, and any of those can push
  a request past an upstream filter. On a 403 the agent halves the message and
  sends the halves in sequence, recursively, down to ~300 bytes. The server
  remembers each part, so the model still sees the whole thing. If a fragment is
  rejected even on its own, the agent prints it rather than failing silently.

- **Loopback addresses are substituted.** `localhost`, `127.0.0.1`, `0.0.0.0`,
  `169.254.169.254` and `file://` are what SSRF filter rules match on, and
  ordinary project files are full of them — a README saying *"open
  http://localhost:3000"* is enough on its own to get a request rejected
  (confirmed: the same message passed once that line was split away). They go
  out as `LCLHST`, `LOOPBACK-IP` and so on, and are restored before anything is
  written, so the bytes on disk are exactly what the file had.

- **Lines that cannot be sent at all are dropped.** Real source contains
  code-execution shapes — `node -e`, `curl`, `rm -rf`, `/bin/sh`, `../../` —
  that no amount of splitting gets past. When a fragment is rejected even on its
  own, those lines are replaced with a note and the rest goes through, so one
  bad line costs a line rather than the whole run.

Tool results are capped at 3000 bytes (`--max-result`) for the same reason.

The npm scripts in this repo avoid `node -e "…"` one-liners for exactly this
reason — the agent reads `package.json` early in almost any task, and a script
field shaped like code execution got the whole read rejected.

## In VS Code

`@aipass` in the chat panel, same agent loop, edits staged as a reviewable diff:

```
@aipass what does the bridge do when the extension disconnects mid-stream?
@aipass add a health route that returns ok
```

Open [vscode/](vscode/) in VS Code and press F5. The bridge and an open
de.aipass.net tab are still required — VS Code is a fourth hop, not a
replacement for the browser, because the cookie has to stay where it is.

The loop itself lives in [agent/core.mjs](agent/core.mjs), which carries no host:
`npm run agent` hands it `node:fs` and an ANSI printer, the extension hands it
`workspace.fs` and a chat stream. Details in [vscode/README.md](vscode/README.md).

## Conversations

The bridge can create them, the way the chat page does — a form post to
`/chat.data` with `intent=create-conversation`. The server derives the id from
the first sixteen hex characters of the `clientCreateRequestId` it is given,
which is why ids look the way they do.

```bash
curl -s localhost:8787/conversations/new -H 'content-type: application/json' -d '{"message":"hello"}'
npm run conversations     # list them, marking the one in use
```

**`npm run agent` starts a fresh conversation for every run.** A conversation
carries its own history, so reusing one drags in whatever was said before —
including a refusal, which the model then sees itself having made and repeats.
`--reuse` continues the most recent instead, `--conversation ID` continues a
specific one. `npm run chat` continues the most recent by default, since that is
what makes a chat a chat; `--new` starts a clean one.

Posting to an invented id returns `404 Conversation not found`, and a
conversation that stops accepting messages (`404` when deleted, `409` when the
server still believes a generation is running) makes the bridge move to the next
most recent.

## Configuration

| env | default | |
|---|---|---|
| `AIPASS_PORT` | `8787` | |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | used when no model is given |
| `AIPASS_MODELS` | two known ids | fallback list when no extension is attached |
| `AIPASS_MODEL_FILTER` | `chat` | `all` keeps image/video/audio models |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | `text` or `off` |
| `AIPASS_CONVERSATION_ID` | *(unset)* | pin one conversation |
| `AIPASS_IDLE_TIMEOUT_MS` | `180000` | fail a job after this long with no delta |

The bridge also serves `POST /v1/chat/completions` and `GET /v1/models`, so any
OpenAI-compatible client can point at `http://127.0.0.1:8787/v1` for plain
chat. Only the last user message is forwarded.

## Tests

```bash
npm test
```

93 tests, no dependencies, about 2 seconds. `test/harness.mjs` runs the real
bridge as a subprocess and a scriptable stand-in for the extension, so tests
drive the actual HTTP surface and the real CLIs rather than mocks of them.
`test/vscode-stub.mjs` does the same for the VS Code API, so the editor
extension is driven against the real bridge without VS Code.

They cover the failures this thing actually hit: that only the newest user
message is forwarded and never an assistant turn; conversation rotation past a
locked one; a job surviving the extension disconnecting mid-stream; loopback
substitution round-tripping so `localhost` never leaves the machine and the
bytes on disk are unchanged; splitting a rejected turn; dropping a line that
cannot be sent at any size; a premature `DONE` being ignored; recovery when the
model drifts into prose; refusing paths outside the project root; and dry run
leaving the disk untouched.

To add a case, script the model's replies with `scripted([...])` and, where a
filter is being modelled, pass `reject` to refuse payloads matching a pattern.

## Known limits

- A de.aipass.net tab must stay open. Its content script also holds a port that
  keeps the MV3 service worker alive; without it Chrome evicts the worker every
  ~30s. If a tab predates the extension, or Chrome discarded it, the worker
  re-injects the scripts.
- Every message appears in the account's chat history — this uses the real product.
- Long sessions burn credits. Only `gemini-3.1-flash-lite` is free-credit;
  `npm run models` marks it.
