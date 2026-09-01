//! The taskbar icon.
//!
//! tray-icon needs a Windows message loop on the thread that created the icon,
//! so this owns the main thread and pumps messages itself rather than pulling
//! in a windowing crate for one hidden window.
use crate::state::Shared;
use std::net::SocketAddr;
use std::time::Duration;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

/// The project icon, compiled into the .exe by build.rs as ordinal 1 — the
/// same resource Explorer and the taskbar show for the file itself.
///
/// The tray icon used to be drawn here and tinted by state, which meant the
/// icon doubled as the status readout. It carries the project's own artwork
/// now, so status lives in the tooltip and the first menu line instead.
fn app_icon() -> Option<Icon> {
    match Icon::from_resource(1, None) {
        Ok(icon) => Some(icon),
        Err(e) => {
            // Silently falling back to the stock icon is how a broken build
            // script goes unnoticed for months.
            crate::bridge::log(format!(
                "could not load the embedded icon ({e}); using the default"
            ));
            None
        }
    }
}

struct Items {
    status: MenuItem,
    conversation: MenuItem,
    copy_url: MenuItem,
    open_chat: MenuItem,
    quit: MenuItem,
}

fn build_menu() -> (Menu, Items) {
    let menu = Menu::new();
    let items = Items {
        // Disabled: these two are a readout, not an action.
        status: MenuItem::new("starting…", false, None),
        conversation: MenuItem::new("conversation: —", false, None),
        copy_url: MenuItem::new("Copy bridge URL", true, None),
        open_chat: MenuItem::new("Open de.aipass.net/chat", true, None),
        quit: MenuItem::new("Quit", true, None),
    };
    let _ = menu.append_items(&[
        &items.status,
        &items.conversation,
        &PredefinedMenuItem::separator(),
        &items.copy_url,
        &items.open_chat,
        &PredefinedMenuItem::separator(),
        &items.quit,
    ]);
    (menu, items)
}

/// One line that answers "is it working" without opening anything.
fn status_line(clients: usize, jobs: usize) -> String {
    if clients == 0 {
        "no browser tab attached".into()
    } else if jobs > 0 {
        format!("{jobs} job(s) in flight · {clients} tab(s)")
    } else {
        format!("ready · {clients} tab(s) attached")
    }
}

pub fn run(state: Shared, addr: SocketAddr) {
    let (menu, items) = build_menu();
    let url = format!("http://{addr}");

    let mut builder = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip(format!("aipass bridge · {url}"));
    if let Some(icon) = app_icon() {
        builder = builder.with_icon(icon);
    }
    let tray: TrayIcon = match builder.build() {
        Ok(t) => t,
        Err(e) => {
            // No tray (a session with no shell, say) is not fatal: the server
            // is already running, so fall back to serving headlessly.
            crate::bridge::log(format!(
                "no system tray available ({e}); serving without one"
            ));
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
    };

    let menu_events = MenuEvent::receiver();
    let mut last = (usize::MAX, usize::MAX);

    loop {
        pump_messages();

        while let Ok(event) = menu_events.try_recv() {
            if event.id == items.quit.id() {
                return;
            } else if event.id == items.copy_url.id() {
                copy_to_clipboard(&url);
            } else if event.id == items.open_chat.id() {
                open_url("https://de.aipass.net/chat");
            }
        }

        let now = (state.client_count(), state.active_jobs());
        if now != last {
            last = now;
            let label = status_line(now.0, now.1);
            let _ = tray.set_tooltip(Some(format!("aipass bridge · {label}")));
            items.status.set_text(&label);
            items.conversation.set_text(format!(
                "conversation: {}",
                state
                    .current_conversation()
                    .unwrap_or_else(|| "resolves on first message".into())
            ));
        }

        std::thread::sleep(Duration::from_millis(120));
    }
}

fn pump_messages() {
    // PeekMessage rather than GetMessage: GetMessage blocks until something
    // arrives, and this loop also polls the bridge for its status.
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn open_url(url: &str) {
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
}

fn copy_to_clipboard(text: &str) {
    // clip.exe rather than a clipboard crate: it ships with Windows and this
    // is the only place the app needs one.
    use std::io::Write;
    use std::process::{Command, Stdio};

    let Ok(mut child) = Command::new("clip").stdin(Stdio::piped()).spawn() else {
        return;
    };
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(text.as_bytes());
    }
    let _ = child.wait();
}
