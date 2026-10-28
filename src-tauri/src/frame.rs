//! Window frame styles (ADR-0013). The style is fixed when the main window is
//! created; the page learns it from the `frame` query parameter.

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
    pub fn decorations(self) -> bool {
        self == Self::Native
    }

    pub fn query(self) -> String {
        format!("frame={}", self.name())
    }
}

/// Unknown or missing values fall back to the default.
fn style_from(value: Option<&str>) -> FrameStyle {
    value.and_then(FrameStyle::parse).unwrap_or(DEFAULT_STYLE)
}

pub fn chosen() -> FrameStyle {
    style_from(std::env::var(STYLE_VARIABLE).ok().as_deref())
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
    fn the_query_names_the_style() {
        assert_eq!(FrameStyle::Native.query(), "frame=native");
        assert_eq!(FrameStyle::Liurium.query(), "frame=liurium");
        assert_eq!(FrameStyle::Hidden.query(), "frame=hidden");
    }
}
