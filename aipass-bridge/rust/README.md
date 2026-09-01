# aipass bridge — tray app

The bridge as a single 1.1 MB executable that lives in the Windows taskbar,
instead of a terminal window you have to keep open.

```bash
npm run bridge:build     # -> target/release/aipass-bridge.exe
npm run bridge:tray      # build and run it
npm run test:rust        # the JS test suite, against this binary
```

Double-click the `.exe` and it sits in the tray. Everything else — the CLIs,
the VS Code extension, any OpenAI-compatible client — talks to it exactly as it
talked to the Node bridge, on the same `:8787`.

## The icon

`icon.ico` at the repo root is compiled into the executable by
[build.rs](build.rs) as ordinal 1 — so Explorer, the taskbar and the tray all
show the same image, and there is still no asset to ship beside the binary.
The extension's PNGs are generated from that same file, so the project has one
icon rather than three that drift.

Status lives in the tooltip and the first menu line: **no browser tab
attached**, **ready · n tabs**, or **n job(s) in flight**. The menu also shows
the conversation in use and offers **Copy bridge URL**,
**Open de.aipass.net/chat** and **Quit**.

> Earlier the tray icon was drawn at startup and tinted amber/green/blue, so
> the icon itself was the status. Carrying the project's artwork costs that
> at-a-glance signal; the words are still there, one hover away.

## It is a port, not a rewrite

Same routes, same env vars, same behaviour. What changed is the language and
the fact that it no longer needs Node.

| still true | |
|---|---|
| `POST /v1/chat/completions`, `GET /v1/models` | OpenAI-compatible, streaming and not |
| `/conversations`, `/conversations/new`, `/config`, `/status` | for the CLIs and the popup |
| `/ext/events`, `/ext/chunk`, `/ext/done`, `/ext/error`, `/ext/loader` | the extension channel |
| every `AIPASS_*` variable | read at startup, same defaults |

**No credential reaches this process either.** The real request still runs as
page JavaScript inside a de.aipass.net tab; this is still a fourth hop.

## How the port is held honest

There is no second test suite. `test/harness.mjs` starts whichever bridge
`AIPASS_TEST_BRIDGE` names, so the existing suite — the bridge tests, the real
CLIs, and the VS Code extension — runs unchanged against this binary:

```bash
npm test            # 86 against the Node bridge
npm run test:rust   # the same 76 against this one
```

Both are green. Where a port diverges, these say which behaviour differs rather
than that something is broken. Two divergences were found this way and fixed:

- **A disconnected tab lingered in the pool.** The JS bridge drops a client on
  `req.on('close')`; the first port only noticed when a keep-alive ping failed,
  up to fifteen seconds later, and round-robined jobs onto a dead channel in
  the meantime. Now the disconnect is caught the moment the response body is
  dropped, and `dispatch` retires a client whose send fails and tries the next.
- Everything else that differed was the same bug seen from three angles.

## Notes on the translation

- **Jobs are channels, not callbacks.** The JS bridge threads `onDelta`,
  `onDone` and `onError` through every layer; here a job owns an
  `mpsc::UnboundedSender` and the requester reads until Done or Error.
- **The idle timeout is the read, not a timer.** `tokio::time::timeout` around
  each `recv` resets on every delta, which is what the JS `touch()` did with a
  timer it had to remember to clear.
- **The turbo-stream decoder cannot cheat.** The JS one mutates half-built
  objects so a cycle can point back at its parent. Rust will not do that, so
  [turbo.rs](src/turbo.rs) memoises finished values and yields null into a
  cycle. Loader payloads are DAGs in practice; the guard is there so a cycle
  cannot hang the decoder.
- **A release build is a GUI binary**, so it gets no console and every log line
  would vanish. It calls `AttachConsole(ATTACH_PARENT_PROCESS)` at startup, so
  running it from a terminal still prints — which is what makes `--headless`
  worth having.

## Flags

| | |
|---|---|
| `--headless` | run the server with no tray — what the test harness uses |
| `AIPASS_HEADLESS` | same, as an environment variable |

Everything else is the `AIPASS_*` set documented in the
[root README](../../README.md#configuration).

## Layout

| | |
|---|---|
| [src/main.rs](src/main.rs) | startup, the listener, and handing the thread to the tray |
| [src/tray.rs](src/tray.rs) | the taskbar icon, its menu, and the message pump |
| [src/http.rs](src/http.rs) | every route, including SSE both ways |
| [src/bridge.rs](src/bridge.rs) | models, conversations, and the chat flow with rotation |
| [src/state.rs](src/state.rs) | the job hub and shared state |
| [src/turbo.rs](src/turbo.rs) | the react-router turbo-stream decoder |
| [src/models.rs](src/models.rs) | pulling chat models out of a loader payload |

Windows only for now: the tray and the console reattach are `cfg(windows)`.
The server itself is portable — on another platform it builds and runs
headless.
