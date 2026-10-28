//! Color themes (ADR-0015): an accent plus a base, in dark or light mode. Accent and
//! base are fixed when the main window is created; the page learns them from the
//! `accent` and `base` query parameters. The mode follows the window's theme.

use tauri::{Theme as WindowTheme, image::Image, include_image, window::Color};

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
    fn canvas(self, shown: WindowTheme) -> Color {
        match (shown, self) {
            // Every light base has a white canvas.
            (WindowTheme::Light, _) => Color(0xff, 0xff, 0xff, 0xff),
            (_, Self::Warm) => Color(0x13, 0x12, 0x11, 0xff),
            (_, Self::Cool) => Color(0x10, 0x14, 0x13, 0xff),
            (_, Self::Graphite) => Color(0x12, 0x12, 0x12, 0xff),
        }
    }
}

/// Dark or light, chosen with `LIURIUM_MODE` until settings exist (M2-007).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Follows the Windows setting, also when it changes while Liurium runs.
    System,
    Light,
    Dark,
}

pub const DEFAULT_MODE: Mode = Mode::System;

const MODE_VARIABLE: &str = "LIURIUM_MODE";

impl Mode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "system" => Some(Self::System),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }

    /// `None` lets Windows decide. WebView2 reports the window's theme to the page as
    /// `prefers-color-scheme`, so the page needs no mode in its URL.
    pub fn window_theme(self) -> Option<WindowTheme> {
        match self {
            Self::System => None,
            Self::Light => Some(WindowTheme::Light),
            Self::Dark => Some(WindowTheme::Dark),
        }
    }
}

fn mode_from(value: Option<&str>) -> Mode {
    value.and_then(Mode::parse).unwrap_or(DEFAULT_MODE)
}

pub fn chosen_mode() -> Mode {
    mode_from(std::env::var(MODE_VARIABLE).ok().as_deref())
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
    /// `main.tsx` sets the same attributes again and keeps following the mode, which
    /// also covers the dev server in a browser. Only fixed names go in here, never
    /// outside input.
    pub fn start_script(self) -> String {
        format!(
            "(() => {{ \
               const apply = (root) => {{ \
                 root.dataset.accent = \"{}\"; root.dataset.base = \"{}\"; \
                 root.dataset.mode = matchMedia(\"(prefers-color-scheme: light)\").matches ? \"light\" : \"dark\"; \
               }}; \
               if (document.documentElement) {{ apply(document.documentElement); return; }} \
               new MutationObserver((_, observer) => {{ \
                 if (document.documentElement) {{ apply(document.documentElement); observer.disconnect(); }} \
               }}).observe(document, {{ childList: true }}); \
             }})();",
            self.accent.name(),
            self.base.name()
        )
    }

    /// The canvas for the theme Windows actually shows, which `Mode::System` only
    /// knows once the window exists.
    pub fn background(self, shown: WindowTheme) -> Color {
        self.base.canvas(shown)
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
    fn known_modes_select_their_mode() {
        assert_eq!(mode_from(Some("system")), Mode::System);
        assert_eq!(mode_from(Some("light")), Mode::Light);
        assert_eq!(mode_from(Some("dark")), Mode::Dark);
    }

    #[test]
    fn missing_or_unknown_modes_follow_windows() {
        for value in [None, Some(""), Some("Light"), Some("auto")] {
            assert_eq!(mode_from(value), Mode::System, "{value:?}");
        }
        assert_eq!(DEFAULT_MODE, Mode::System);
    }

    #[test]
    fn only_a_fixed_mode_forces_the_window_theme() {
        assert_eq!(Mode::System.window_theme(), None);
        assert_eq!(Mode::Light.window_theme(), Some(WindowTheme::Light));
        assert_eq!(Mode::Dark.window_theme(), Some(WindowTheme::Dark));
    }

    #[test]
    fn the_start_script_reads_the_mode_from_the_window() {
        let script = DEFAULT_THEME.start_script();
        assert!(
            script.contains("matchMedia(\"(prefers-color-scheme: light)\")"),
            "{script}"
        );
        assert!(script.contains("root.dataset.mode"), "{script}");
    }

    #[test]
    fn the_window_background_is_the_canvas_in_tokens_css() {
        let tokens = include_str!("../../src/styles/tokens.css");
        for shown in [WindowTheme::Dark, WindowTheme::Light] {
            for base in [Base::Warm, Base::Cool, Base::Graphite] {
                // The default block comes first; the others are marked by their attributes.
                let marker = match (shown, base) {
                    (WindowTheme::Light, Base::Warm) => {
                        Some(":root[data-mode=\"light\"] {".to_string())
                    }
                    (WindowTheme::Light, _) => Some(format!(
                        ":root[data-mode=\"light\"][data-base=\"{}\"]",
                        base.name()
                    )),
                    (_, Base::Warm) => None,
                    (_, _) => Some(format!(":root[data-base=\"{}\"]", base.name())),
                };
                let block = match marker {
                    None => tokens,
                    Some(marker) => {
                        let start = tokens.find(&marker).expect("theme block in tokens.css");
                        &tokens[start..]
                    }
                };
                let value = block
                    .split("--color-canvas:")
                    .nth(1)
                    .and_then(|rest| rest.trim_start().get(1..7))
                    .expect("--color-canvas as a 6-digit hex color");
                let Color(r, g, b, _) = base.canvas(shown);
                assert_eq!(
                    value,
                    format!("{r:02x}{g:02x}{b:02x}"),
                    "{shown:?} {base:?}"
                );
            }
        }
    }
}
