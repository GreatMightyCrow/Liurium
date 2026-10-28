//! Color themes (ADR-0015): an accent plus a base. The theme is fixed when the main
//! window is created; the page learns it from the `accent` and `base` query parameters.

use tauri::{image::Image, include_image, window::Color};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accent {
    Orange,
    Mint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Base {
    /// Warm graphite, made for orange.
    Warm,
    /// Slightly green graphite, made for mint.
    Cool,
    /// Neutral graphite for either accent.
    Graphite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    pub accent: Accent,
    pub base: Base,
}

/// Used until the choice is stored with the app settings (M2-007).
pub const DEFAULT_THEME: Theme = Theme {
    accent: Accent::Orange,
    base: Base::Warm,
};

/// Temporary switch for trying the other themes until settings exist.
const THEME_VARIABLE: &str = "LIURIUM_THEME";

/// Windows shows this in the window and the taskbar. The orange icon needs no copy
/// here: it is the icon inside the exe, which Windows uses by default.
const MINT_ICON: Image<'static> = include_image!("icons/mint/icon.ico");

impl Accent {
    fn name(self) -> &'static str {
        match self {
            Self::Orange => "orange",
            Self::Mint => "mint",
        }
    }
}

impl Base {
    fn name(self) -> &'static str {
        match self {
            Self::Warm => "warm",
            Self::Cool => "cool",
            Self::Graphite => "graphite",
        }
    }

    /// `--color-canvas` of this base in `tokens.css`. Tauri paints the window before
    /// any CSS loads; the same color avoids a flash at startup.
    fn canvas(self) -> Color {
        match self {
            Self::Warm => Color(0x13, 0x12, 0x11, 0xff),
            Self::Cool => Color(0x10, 0x14, 0x13, 0xff),
            Self::Graphite => Color(0x12, 0x12, 0x12, 0xff),
        }
    }
}

impl Theme {
    /// Only the combinations whose contrast `tokens.test.ts` checks.
    fn parse(value: &str) -> Option<Self> {
        let (accent, base) = match value {
            "orange" => (Accent::Orange, Base::Warm),
            "orange-graphite" => (Accent::Orange, Base::Graphite),
            "mint" => (Accent::Mint, Base::Cool),
            "mint-graphite" => (Accent::Mint, Base::Graphite),
            _ => return None,
        };
        Some(Self { accent, base })
    }

    pub fn query(self) -> String {
        format!("accent={}&base={}", self.accent.name(), self.base.name())
    }

    /// Runs when the page's document is created, before its stylesheet or any paint,
    /// so the first frame already has the theme's colors. `<html>` may not exist yet
    /// then; the observer sets the attributes as soon as the parser inserts it.
    /// `main.tsx` sets the same attributes again from the URL, which also covers the
    /// dev server in a browser. Only fixed names go in here, never outside input.
    pub fn start_script(self) -> String {
        format!(
            "(() => {{ \
               const apply = (root) => {{ root.dataset.accent = \"{}\"; root.dataset.base = \"{}\"; }}; \
               if (document.documentElement) {{ apply(document.documentElement); return; }} \
               new MutationObserver((_, observer) => {{ \
                 if (document.documentElement) {{ apply(document.documentElement); observer.disconnect(); }} \
               }}).observe(document, {{ childList: true }}); \
             }})();",
            self.accent.name(),
            self.base.name()
        )
    }

    pub fn background(self) -> Color {
        self.base.canvas()
    }

    /// `None` keeps the exe's own icon.
    pub fn window_icon(self) -> Option<Image<'static>> {
        match self.accent {
            Accent::Orange => None,
            Accent::Mint => Some(MINT_ICON),
        }
    }
}

/// Unknown or missing values fall back to the default.
fn theme_from(value: Option<&str>) -> Theme {
    value.and_then(Theme::parse).unwrap_or(DEFAULT_THEME)
}

pub fn chosen() -> Theme {
    theme_from(std::env::var(THEME_VARIABLE).ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Theme; 4] = [
        DEFAULT_THEME,
        Theme {
            accent: Accent::Orange,
            base: Base::Graphite,
        },
        Theme {
            accent: Accent::Mint,
            base: Base::Cool,
        },
        Theme {
            accent: Accent::Mint,
            base: Base::Graphite,
        },
    ];

    #[test]
    fn known_names_select_their_theme() {
        let names = ["orange", "orange-graphite", "mint", "mint-graphite"];
        for (name, theme) in names.into_iter().zip(ALL) {
            assert_eq!(theme_from(Some(name)), theme, "{name}");
        }
    }

    #[test]
    fn missing_or_unknown_values_use_the_default() {
        // Orange on cool and mint on warm are not allowed combinations.
        for value in [
            None,
            Some(""),
            Some("Mint"),
            Some("violet"),
            Some("mint-warm"),
        ] {
            assert_eq!(theme_from(value), DEFAULT_THEME, "{value:?}");
        }
    }

    #[test]
    fn the_query_names_accent_and_base() {
        assert_eq!(DEFAULT_THEME.query(), "accent=orange&base=warm");
        assert_eq!(ALL[3].query(), "accent=mint&base=graphite");
    }

    #[test]
    fn the_start_script_sets_the_theme_attributes() {
        let script = ALL[2].start_script();
        assert!(
            script.contains("root.dataset.accent = \"mint\""),
            "{script}"
        );
        assert!(script.contains("root.dataset.base = \"cool\""), "{script}");
        assert!(script.contains("MutationObserver"), "{script}");
    }

    #[test]
    fn only_mint_replaces_the_window_icon() {
        for theme in ALL {
            assert_eq!(
                theme.window_icon().is_some(),
                theme.accent == Accent::Mint,
                "{theme:?}"
            );
        }
    }

    // The mint icon is a copy so the page can show it in the title row.
    #[test]
    fn the_title_row_icons_match_the_window_icons() {
        assert_eq!(
            include_bytes!("../../public/favicon.ico"),
            include_bytes!("../icons/icon.ico")
        );
        assert_eq!(
            include_bytes!("../../public/favicon-mint.ico"),
            include_bytes!("../icons/mint/icon.ico")
        );
    }

    #[test]
    fn the_window_background_is_the_canvas_in_tokens_css() {
        let tokens = include_str!("../../src/styles/tokens.css");
        for base in [Base::Warm, Base::Cool, Base::Graphite] {
            // The default block comes first; the others are marked with `data-base`.
            let block = match base {
                Base::Warm => tokens,
                _ => {
                    let marker = format!(":root[data-base=\"{}\"]", base.name());
                    let start = tokens.find(&marker).expect("base block in tokens.css");
                    &tokens[start..]
                }
            };
            let value = block
                .split("--color-canvas:")
                .nth(1)
                .and_then(|rest| rest.trim_start().get(1..7))
                .expect("--color-canvas as a 6-digit hex color");
            let Color(r, g, b, _) = base.canvas();
            assert_eq!(value, format!("{r:02x}{g:02x}{b:02x}"), "{base:?}");
        }
    }
}
