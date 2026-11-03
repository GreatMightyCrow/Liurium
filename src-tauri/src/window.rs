//! The main window, created from its entry in `tauri.conf.json` (`create: false`)
//! with the stored frame style (ADR-0013), theme, and mode (ADR-0015, M2-007).

use crate::commands::Preferences;
use crate::domain::settings::Settings;
use crate::frame::FrameStyle;
use crate::theme::Theme;
use std::error::Error;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// The label of the main window in `tauri.conf.json`.
const MAIN: &str = "main";

pub fn create_main_window(app: &AppHandle, settings: Settings) -> Result<(), Box<dyn Error>> {
    let theme = settings.theme.theme();
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("tauri.conf.json defines no window")?;
    config.decorations = settings.frame.decorations();
    config.theme = settings.mode.window_theme();
    // With the system mode the theme is known only once the window exists, so the
    // window stays hidden until its background matches.
    config.visible = false;
    config.url = page(settings.frame, theme);
    let builder = WebviewWindowBuilder::from_config(app, &config)?
        .initialization_script(theme.start_script())
        .icon(theme.window_icon())?;
    // The end-to-end build keeps WebView2's own data in the test's folder too.
    #[cfg(feature = "e2e")]
    let builder = match crate::e2e::data_dir() {
        Some(dir) => builder.data_directory(dir.join("EBWebView")),
        None => builder,
    };
    let window = builder.build()?;
    paint(&window, theme);
    // Windows' mode can change while Liurium runs; the background follows with the
    // theme chosen by then.
    let follower = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::ThemeChanged(shown) = event {
            let theme = follower.state::<Preferences>().settings().theme.theme();
            let _ = follower.set_background_color(Some(theme.background(*shown)));
        }
    });
    window.show()?;
    Ok(())
}

/// Brings the main window to the front for a second start (M2-010). A window still
/// hidden is starting up and shows itself once its background matches.
pub fn focus(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        // A failure leaves the window where it is; the second start ends either way.
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// A changed theme and mode take effect at once; the frame style needs a restart.
pub fn apply(window: &WebviewWindow, settings: &Settings) {
    let theme = settings.theme.theme();
    // Icon and background are looks only; a failure keeps the old ones, the saved
    // settings stay and apply at the next start.
    let _ = window.set_icon(theme.window_icon());
    let _ = window.set_theme(settings.mode.window_theme());
    paint(window, theme);
}

/// The background only prevents a flash; the window must work even if setting it
/// fails, so the error is ignored.
fn paint(window: &WebviewWindow, theme: Theme) {
    if let Ok(shown) = window.theme() {
        let _ = window.set_background_color(Some(theme.background(shown)));
    }
}

fn page(style: FrameStyle, theme: Theme) -> WebviewUrl {
    WebviewUrl::App(format!("index.html?{}&{}", style.query(), theme.query()).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ThemeChoice;

    #[test]
    fn the_page_url_names_frame_and_theme() {
        let WebviewUrl::App(path) = page(FrameStyle::default(), ThemeChoice::default().theme())
        else {
            panic!("the main window must load the bundled page");
        };
        assert_eq!(
            path.to_str(),
            Some("index.html?frame=liurium&accent=orange&base=warm")
        );
    }
}
