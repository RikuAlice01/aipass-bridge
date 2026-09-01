//! Compile the project icon into the executable as a Windows resource.
//!
//! It lands as ordinal 1, which is both what Explorer and the taskbar show for
//! the .exe and what `Icon::from_resource(1, ..)` hands the tray — so the file
//! and the tray icon cannot drift apart, and there is no asset to ship beside
//! the binary.
fn main() {
    #[cfg(windows)]
    {
        // ../../icon.ico from this crate: one icon for the whole project, also
        // the source the extension's PNGs are generated from.
        let icon = std::path::Path::new("../../icon.ico");
        println!("cargo:rerun-if-changed=../../icon.ico");

        if !icon.exists() {
            println!("cargo:warning=icon.ico not found; the exe will use the default icon");
            return;
        }
        let mut res = winresource::WindowsResource::new();
        res.set_icon(icon.to_str().expect("icon path is not valid UTF-8"));
        if let Err(e) = res.compile() {
            // A machine without the Windows SDK can still build and run; it
            // just gets the stock icon.
            println!("cargo:warning=could not embed the icon ({e}); using the default");
        }
    }
}
