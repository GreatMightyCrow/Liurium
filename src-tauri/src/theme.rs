//! Color themes (ADR-0015): an accent plus a base, in dark or light mode, chosen in
//! the settings (M2-007). The page learns accent and base from the `accent` and `base`
//! query parameters at start and swaps them itself after a change. The mode follows
//! the window's theme.

use serde::{Deserialize, Serialize};
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

/// The themes a user can choose: each accent with its own base or with graphite. Only
/// these combinations have their contrast checked by `tokens.test.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "ThemeChoice.ts"))]
pub enum ThemeChoice {
    #[default]
    Orange,
    OrangeGraphite,
    Mint,
    MintGraphite,
}

impl ThemeChoice {
    pub fn theme(self) -> Theme {
        let (accent, base) = match self {
            Self::Orange => (Accent::Orange, Base::Warm),
            Self::OrangeGraphite => (Accent::Orange, Base::Graphite),
            Self::Mint => (Accent::Mint, Base::Cool),
            Self::MintGraphite => (Accent::Mint, Base::Graphite),
        };
        Theme { accent, base }
    }
}

/// Windows shows these in the window and the taskbar. The orange one is also the
/// icon inside the exe; it is needed here to switch back from mint while running.
const ORANGE_ICON: Image<'static> = include_image!("icons/icon.ico");
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

/// Dark or light, chosen in the settings (M2-007).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "Mode.ts"))]
pub enum Mode {
    /// Follows the Windows setting, also when it changes while Liurium runs.
    #[default]
    System,
    Light,
    Dark,
}

impl Mode {
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

impl Theme {
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

    pub fn window_icon(self) -> Image<'static> {
        match self.accent {
            Accent::Orange => ORANGE_ICON,
            Accent::Mint => MINT_ICON,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHOICES: [ThemeChoice; 4] = [
        ThemeChoice::Orange,
        ThemeChoice::OrangeGraphite,
        ThemeChoice::Mint,
        ThemeChoice::MintGraphite,
    ];

    #[test]
    fn each_choice_has_its_name_and_theme() {
        let expected = [
            ("\"orange\"", Accent::Orange, Base::Warm),
            ("\"orange-graphite\"", Accent::Orange, Base::Graphite),
            ("\"mint\"", Accent::Mint, Base::Cool),
            ("\"mint-graphite\"", Accent::Mint, Base::Graphite),
        ];
        for (choice, (name, accent, base)) in CHOICES.into_iter().zip(expected) {
            assert_eq!(serde_json::to_string(&choice).unwrap(), name);
            assert_eq!(serde_json::from_str::<ThemeChoice>(name).unwrap(), choice);
            assert_eq!(choice.theme(), Theme { accent, base }, "{name}");
        }
        assert_eq!(ThemeChoice::default(), ThemeChoice::Orange);
    }

    #[test]
    fn unknown_theme_names_are_rejected() {
        // Orange on cool and mint on warm are not allowed combinations.
        for name in ["\"\"", "\"Mint\"", "\"violet\"", "\"mint-warm\"", "1"] {
            assert!(serde_json::from_str::<ThemeChoice>(name).is_err(), "{name}");
        }
    }

    #[test]
    fn the_query_names_accent_and_base() {
        assert_eq!(
            ThemeChoice::Orange.theme().query(),
            "accent=orange&base=warm"
        );
        assert_eq!(
            ThemeChoice::MintGraphite.theme().query(),
            "accent=mint&base=graphite"
        );
    }

    #[test]
    fn the_start_script_sets_the_theme_attributes() {
        let script = ThemeChoice::Mint.theme().start_script();
        assert!(
            script.contains("root.dataset.accent = \"mint\""),
            "{script}"
        );
        assert!(script.contains("root.dataset.base = \"cool\""), "{script}");
        assert!(script.contains("MutationObserver"), "{script}");
    }

    #[test]
    fn each_accent_has_its_window_icon() {
        for choice in CHOICES {
            let theme = choice.theme();
            let expected = match theme.accent {
                Accent::Orange => ORANGE_ICON,
                Accent::Mint => MINT_ICON,
            };
            assert_eq!(theme.window_icon().rgba(), expected.rgba(), "{choice:?}");
        }
        assert_ne!(ORANGE_ICON.rgba(), MINT_ICON.rgba());
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
    fn modes_have_their_names_and_follow_windows_by_default() {
        for (mode, name) in [
            (Mode::System, "\"system\""),
            (Mode::Light, "\"light\""),
            (Mode::Dark, "\"dark\""),
        ] {
            assert_eq!(serde_json::to_string(&mode).unwrap(), name);
            assert_eq!(serde_json::from_str::<Mode>(name).unwrap(), mode);
        }
        for name in ["\"\"", "\"Light\"", "\"auto\""] {
            assert!(serde_json::from_str::<Mode>(name).is_err(), "{name}");
        }
        assert_eq!(Mode::default(), Mode::System);
    }

    #[test]
    fn only_a_fixed_mode_forces_the_window_theme() {
        assert_eq!(Mode::System.window_theme(), None);
        assert_eq!(Mode::Light.window_theme(), Some(WindowTheme::Light));
        assert_eq!(Mode::Dark.window_theme(), Some(WindowTheme::Dark));
    }

    #[test]
    fn the_start_script_reads_the_mode_from_the_window() {
        let script = ThemeChoice::default().theme().start_script();
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
                    // Each block also names `[data-preview]` after a comma (M3-009).
                    (WindowTheme::Light, Base::Warm) => {
                        Some(":root[data-mode=\"light\"],".to_string())
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
