//! Window frame styles (ADR-0013). The style is fixed when the main window is
//! created; the page learns it from the `frame` query parameter.

use std::error::Error;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameStyle {
    /// The Windows title bar, dark.
    Native,
    /// Liurium's own title row with title and window buttons.
    Liurium,
    /// No extra row; window buttons sit in the top edge of the app.
    Hidden,
}

/// Used until the choice is stored with the app settings (M2-007).
pub const DEFAULT_STYLE: FrameStyle = FrameStyle::Liurium;

/// Temporary switch for trying the other styles until settings exist.
const STYLE_VARIABLE: &str = "LIURIUM_FRAME_STYLE";

impl FrameStyle {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "native" => Some(Self::Native),
            "liurium" => Some(Self::Liurium),
            "hidden" => Some(Self::Hidden),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Liurium => "liurium",
            Self::Hidden => "hidden",
        }
    }

    /// Only the native style keeps the Windows title bar and borders.
    fn decorations(self) -> bool {
        self == Self::Native
    }

    fn page(self) -> WebviewUrl {
        WebviewUrl::App(format!("index.html?frame={}", self.name()).into())
    }
}

/// Unknown or missing values fall back to the default.
fn style_from(value: Option<&str>) -> FrameStyle {
    value.and_then(FrameStyle::parse).unwrap_or(DEFAULT_STYLE)
}

/// Creates the main window from its entry in `tauri.conf.json` (`create: false`).
pub fn create_main_window(app: &AppHandle) -> Result<(), Box<dyn Error>> {
    let style = style_from(std::env::var(STYLE_VARIABLE).ok().as_deref());
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("tauri.conf.json defines no window")?;
    config.decorations = style.decorations();
    config.url = style.page();
    WebviewWindowBuilder::from_config(app, &config)?.build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_names_select_their_style() {
        assert_eq!(style_from(Some("native")), FrameStyle::Native);
        assert_eq!(style_from(Some("liurium")), FrameStyle::Liurium);
        assert_eq!(style_from(Some("hidden")), FrameStyle::Hidden);
    }

    #[test]
    fn missing_or_unknown_values_use_the_default() {
        for value in [None, Some(""), Some("Hidden"), Some("frameless")] {
            assert_eq!(style_from(value), DEFAULT_STYLE, "{value:?}");
        }
    }

    #[test]
    fn only_the_native_style_keeps_window_decorations() {
        assert!(FrameStyle::Native.decorations());
        assert!(!FrameStyle::Liurium.decorations());
        assert!(!FrameStyle::Hidden.decorations());
    }

    #[test]
    fn the_page_url_names_the_style() {
        for style in [FrameStyle::Native, FrameStyle::Liurium, FrameStyle::Hidden] {
            let WebviewUrl::App(path) = style.page() else {
                panic!("{style:?} must load the bundled page");
            };
            assert_eq!(
                path.to_str(),
                Some(format!("index.html?frame={}", style.name()).as_str())
            );
        }
    }
}
