//! The main window, created from its entry in `tauri.conf.json` (`create: false`)
//! with the frame style (ADR-0013), the theme, and the mode (ADR-0015) chosen at start.

use crate::frame::FrameStyle;
use crate::theme::Theme;
use crate::{frame, theme};
use std::error::Error;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub fn create_main_window(app: &AppHandle) -> Result<(), Box<dyn Error>> {
    let style = frame::chosen();
    let theme = theme::chosen();
    let mode = theme::chosen_mode();
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("tauri.conf.json defines no window")?;
    config.decorations = style.decorations();
    config.theme = mode.window_theme();
    // With the system mode the theme is known only once the window exists, so the
    // window stays hidden until its background matches.
    config.visible = false;
    config.url = page(style, theme);
    let mut builder = WebviewWindowBuilder::from_config(app, &config)?
        .initialization_script(theme.start_script());
    if let Some(icon) = theme.window_icon() {
        builder = builder.icon(icon)?;
    }
    let window = builder.build()?;
    // The background only prevents a flash; the window must appear even if setting it
    // fails, so these errors do not stop the start.
    if let Ok(shown) = window.theme() {
        let _ = window.set_background_color(Some(theme.background(shown)));
    }
    let follower = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::ThemeChanged(shown) = event {
            let _ = follower.set_background_color(Some(theme.background(*shown)));
        }
    });
    window.show()?;
    Ok(())
}

fn page(style: FrameStyle, theme: Theme) -> WebviewUrl {
    WebviewUrl::App(format!("index.html?{}&{}", style.query(), theme.query()).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::DEFAULT_STYLE;
    use crate::theme::DEFAULT_THEME;

    #[test]
    fn the_page_url_names_frame_and_theme() {
        let WebviewUrl::App(path) = page(DEFAULT_STYLE, DEFAULT_THEME) else {
            panic!("the main window must load the bundled page");
        };
        assert_eq!(
            path.to_str(),
            Some("index.html?frame=liurium&accent=orange&base=warm")
        );
    }
}
