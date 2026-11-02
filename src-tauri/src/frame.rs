//! Window frame styles (ADR-0013), chosen in the settings (M2-007). The style is fixed
//! when the main window is created; a change applies after a restart. The page learns
//! it from the `frame` query parameter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "FrameStyle.ts"))]
pub enum FrameStyle {
    /// The Windows title bar, in the window's mode.
    Native,
    /// Liurium's own title row with title and window buttons.
    #[default]
    Liurium,
    /// No extra row; window buttons sit in the top edge of the app.
    Hidden,
}

impl FrameStyle {
    fn name(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Liurium => "liurium",
            Self::Hidden => "hidden",
        }
    }

    /// Only the native style keeps the Windows title bar and borders.
    pub fn decorations(self) -> bool {
        self == Self::Native
    }

    pub fn query(self) -> String {
        format!("frame={}", self.name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [FrameStyle; 3] = [FrameStyle::Native, FrameStyle::Liurium, FrameStyle::Hidden];

    #[test]
    fn styles_are_stored_by_their_names() {
        for style in ALL {
            let name = format!("\"{}\"", style.name());
            assert_eq!(serde_json::to_string(&style).unwrap(), name);
            assert_eq!(serde_json::from_str::<FrameStyle>(&name).unwrap(), style);
        }
        for name in ["\"\"", "\"Hidden\"", "\"frameless\""] {
            assert!(serde_json::from_str::<FrameStyle>(name).is_err(), "{name}");
        }
    }

    #[test]
    fn the_liurium_frame_is_the_default() {
        assert_eq!(FrameStyle::default(), FrameStyle::Liurium);
    }

    #[test]
    fn only_the_native_style_keeps_window_decorations() {
        assert!(FrameStyle::Native.decorations());
        assert!(!FrameStyle::Liurium.decorations());
        assert!(!FrameStyle::Hidden.decorations());
    }

    #[test]
    fn the_query_names_the_style() {
        assert_eq!(FrameStyle::Native.query(), "frame=native");
        assert_eq!(FrameStyle::Liurium.query(), "frame=liurium");
        assert_eq!(FrameStyle::Hidden.query(), "frame=hidden");
    }
}
