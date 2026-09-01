//! aipass bridge, as a tray app.
//!
//! Same four hops as ever — terminal or editor, this bridge, the Chrome
//! extension, a de.aipass.net tab — with the bridge living in the taskbar
//! instead of a terminal window you have to keep open.
//!
//! No credential ever reaches this process. The real request runs as ordinary
//! page JavaScript inside the tab, so Chrome attaches the session cookie
//! itself, and nothing is stored on disk.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod bridge;
mod http;
mod models;
mod state;
mod turbo;

#[cfg(windows)]
mod tray;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use state::{AppState, Config, Shared};
use std::net::SocketAddr;
use tokio::net::TcpListener;

/// `--headless` runs the server with no tray, which is what the test harness
/// and anyone on a machine without a desktop wants.
fn headless() -> bool {
    std::env::args().any(|a| a == "--headless") || std::env::var("AIPASS_HEADLESS").is_ok()
}

/// A release build is a GUI subsystem binary, so it gets no console and every
/// log line goes nowhere. Reattach to the terminal that launched it when there
/// is one, which is what makes `--headless` usable and a bad start debuggable.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_console() {}

fn main() {
    attach_console();
    let config = Config::from_env();
    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .expect("AIPASS_HOST/AIPASS_PORT do not form an address");
    let state = AppState::new(config);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("could not start the async runtime");

    // The listener is bound on the runtime but before the tray takes over the
    // thread, so a failure to bind is reported rather than swallowed.
    let listener = runtime
        .block_on(TcpListener::bind(addr))
        .unwrap_or_else(|e| panic!("could not bind {addr}: {e}"));

    banner(&state, &addr);

    let serve_state = state.clone();
    runtime.spawn(async move { serve(listener, serve_state).await });

    #[cfg(windows)]
    if !headless() {
        // Owns the thread from here: the tray needs the Windows message loop.
        tray::run(state, addr);
        return;
    }

    // Headless, or a platform without the tray: park on the runtime.
    runtime.block_on(async {
        tokio::signal::ctrl_c().await.ok();
    });
}

fn banner(state: &Shared, addr: &SocketAddr) {
    bridge::log(format!("aipass bridge on http://{addr}"));
    bridge::log(format!("  default model : {}", state.default_model()));
    bridge::log(format!(
        "  conversation  : {}",
        state
            .current_conversation()
            .unwrap_or_else(|| "most recent on the account".into())
    ));
    bridge::log("  waiting for the Chrome extension…");
}

async fn serve(listener: TcpListener, state: Shared) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let io = TokioIo::new(stream);
        let conn_state = state.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| http::route(conn_state.clone(), req));
            // Long-lived SSE connections are the normal case here, so no
            // header-read timeout and keep-alive left on.
            let _ = http1::Builder::new()
                .keep_alive(true)
                .serve_connection(io, service)
                .await;
        });
    }
}
