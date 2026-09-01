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

/// Drawn rather than shipped as a file: one asset the .exe cannot lose, and it
/// keeps the build to `cargo build` with nothing to copy alongside it.
///
/// A rounded square that reads at 16px, tinted by state — the icon *is* the
/// status readout, since that is all a tray icon is ever glanced at for.
fn icon_rgba(r: u8, g: u8, b: u8) -> Icon {
    const SIZE: u32 = 32;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let centre = (SIZE as f32 - 1.0) / 2.0;

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = (x as f32 - centre).abs();
            let dy = (y as f32 - centre).abs();
            // Squircle: |dx|^4 + |dy|^4 <= radius^4 gives a rounded square
            // that stays legible when Windows scales it down.
            let d = dx.powi(4) + dy.powi(4);
            let radius: f32 = 14.0;
            let inside = d <= radius.powi(4);
            let ring = d <= radius.powi(4) && d >= (radius - 3.0).powi(4);

            if ring {
                rgba.extend_from_slice(&[r, g, b, 255]);
            } else if inside {
                // Hollow centre so the tint reads as a ring, not a blob.
                rgba.extend_from_slice(&[r, g, b, 70]);
            } else {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    Icon::from_rgba(rgba, SIZE, SIZE).expect("icon dimensions are constant")
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

/// Green once a tab is attached, amber while nothing is, blue while a job is
/// in flight — so a glance at the taskbar answers "is it working".
fn appearance(clients: usize, jobs: usize) -> ((u8, u8, u8), String) {
    if clients == 0 {
        ((0xC8, 0x7A, 0x1E), "no browser tab attached".into())
    } else if jobs > 0 {
        (
            (0x2F, 0x62, 0xF0),
            format!("{jobs} job(s) in flight · {clients} tab(s)"),
        )
    } else {
        (
            (0x1F, 0x8A, 0x54),
            format!("ready · {clients} tab(s) attached"),
        )
    }
}

pub fn run(state: Shared, addr: SocketAddr) {
    let (menu, items) = build_menu();
    let url = format!("http://{addr}");

    let tray: TrayIcon = match TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip(format!("aipass bridge · {url}"))
        .with_icon(icon_rgba(0xC8, 0x7A, 0x1E))
        .build()
    {
        Ok(t) => t,
        Err(e) => {
            // No tray (a session with no shell, say) is not fatal: the server
            // is already running, so fall back to serving headlessly.
            crate::bridge::log(format!("no system tray available ({e}); serving without one"));
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
            let ((r, g, b), label) = appearance(now.0, now.1);
            let _ = tray.set_icon(Some(icon_rgba(r, g, b)));
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
