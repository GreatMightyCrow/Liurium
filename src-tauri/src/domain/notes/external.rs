//! Links that leave Liurium (M3-012, ADR-0020): only `http:`, `https:`, and `mailto:`.
//! Addresses in notes are untrusted. This decides what may be opened and what the page
//! is told; nothing here starts a program.

use url::{Host, Url};

/// Longer addresses are not opened; browsers themselves cut them off around here.
const MAX_ADDRESS: usize = 2048;

/// The address as it may be opened, or `None`. Normalized by the parser: host in
/// punycode, spaces and quotes escaped, so what opens is what the tooltip shows.
pub fn checked_address(raw: &str) -> Option<String> {
    if raw.len() > MAX_ADDRESS || raw.chars().any(char::is_control) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let allowed = match url.scheme() {
        "http" | "https" => {
            // `https://www.bank.example@evil.example` shows one host and opens another.
            url.host().is_some() && url.username().is_empty() && url.password().is_none()
        }
        // Some mail programs attach what these name, which could send local files.
        "mailto" => {
            !url.path().is_empty()
                && !url.query_pairs().any(|(name, _)| {
                    name.eq_ignore_ascii_case("attach") || name.eq_ignore_ascii_case("attachment")
                })
        }
        _ => false,
    };
    (allowed && url.as_str().len() <= MAX_ADDRESS).then(|| url.as_str().to_owned())
}

/// The host in a word of the visible text, if the word looks like a web address.
fn host_in(word: &str, alone: bool) -> Option<String> {
    let word = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '/');
    let lower = word.to_lowercase();
    let written = if lower.starts_with("http://") || lower.starts_with("https://") {
        word.to_owned()
    } else if lower.starts_with("www.") || (alone && looks_like_domain(&lower)) {
        format!("https://{word}")
    } else {
        return None;
    };
    match Url::parse(&written).ok()?.host()? {
        Host::Domain(domain) => Some(domain.to_owned()),
        Host::Ipv4(ip) => Some(ip.to_string()),
        Host::Ipv6(ip) => Some(ip.to_string()),
    }
}

/// `bank.example` or `bank.example/login`: dotted names ending in letters.
fn looks_like_domain(word: &str) -> bool {
    let host = word.split('/').next().unwrap_or(word);
    let mut labels = host.split('.');
    let Some(last) = labels.next_back() else {
        return false;
    };
    last.len() >= 2
        && last.chars().all(char::is_alphabetic)
        && labels.clone().next().is_some()
        && labels.all(|label| {
            !label.is_empty() && label.chars().all(|c| c.is_alphanumeric() || c == '-')
        })
}

fn without_www(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

/// What the visible text claims when that is another address than the link's (owner
/// decision Q1), so the page can ask first. A subdomain of the claimed host is fine:
/// `example.org` leading to `docs.example.org` deceives nobody.
pub fn claimed_other_address(visible: &str, address: &str) -> Option<String> {
    let visible = visible.trim();
    let target = Url::parse(address).ok()?;
    let words: Vec<&str> = visible.split_whitespace().collect();
    let alone = words.len() == 1;
    if target.scheme() == "mailto" {
        let to = target.path();
        let differs = |word: &&&str| {
            let word = word.trim_matches(|c: char| !c.is_alphanumeric());
            (word.contains('@') && !word.eq_ignore_ascii_case(to)) || host_in(word, alone).is_some()
        };
        return words.iter().find(differs).map(|_| visible.to_owned());
    }
    let host = target.host_str()?.to_lowercase();
    let host = without_www(&host);
    let differs = words.iter().any(|word| {
        host_in(word, alone).is_some_and(|claimed| {
            let claimed = without_www(&claimed).to_lowercase();
            host != claimed && !host.ends_with(&format!(".{claimed}"))
        })
    });
    differs.then(|| visible.to_owned())
}

/// A bare address starting at `at` in the note's text, read from the text itself
/// because the parser cuts plain text at characters such as `_`. Returns its end.
pub fn bare_address_end(text: &str, at: usize) -> usize {
    let rest = &text[at..];
    let stop = rest
        .find(|c: char| {
            c.is_whitespace()
                || c.is_control()
                || matches!(
                    c,
                    '<' | '>' | '"' | '`' | '[' | ']' | '\\' | '|' | '{' | '}'
                )
        })
        .unwrap_or(rest.len());
    let mut address = &rest[..stop];
    // As on GitHub: closing punctuation belongs to the sentence, and a `)` only to the
    // address if it opened one.
    loop {
        let trimmed = address.trim_end_matches(['?', '!', '.', ',', ':', ';', '*', '_', '~', '\'']);
        let opened = trimmed.matches('(').count();
        let closed = trimmed.matches(')').count();
        let trimmed = if trimmed.ends_with(')') && closed > opened {
            &trimmed[..trimmed.len() - 1]
        } else {
            trimmed
        };
        if trimmed.len() == address.len() {
            break;
        }
        address = trimmed;
    }
    at + address.len()
}

/// Where a bare address starts in a piece of plain text, from `from` on. `before` is
/// the character before the piece, so `xhttps://` does not count.
pub fn bare_address_start(piece: &str, from: usize, before: Option<char>) -> Option<usize> {
    let lower = piece.to_ascii_lowercase();
    let mut search = from;
    loop {
        let found = lower.get(search..)?.find("http")? + search;
        let scheme = lower.get(found..)?;
        let previous = piece[..found].chars().next_back().or(before);
        let word_start = previous.is_none_or(|c| !c.is_alphanumeric());
        if word_start && (scheme.starts_with("http://") || scheme.starts_with("https://")) {
            return Some(found);
        }
        search = found + "http".len();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_and_mail_addresses_pass_and_are_normalized() {
        for (raw, expected) in [
            ("https://example.org", "https://example.org/"),
            ("HTTP://Example.ORG/a b", "http://example.org/a%20b"),
            (
                "https://bücher.example/x",
                "https://xn--bcher-kva.example/x",
            ),
            (
                "https://example.org/\"><x",
                "https://example.org/%22%3E%3Cx",
            ),
            ("mailto:a@example.org", "mailto:a@example.org"),
            (
                "mailto:a@example.org?subject=Hi",
                "mailto:a@example.org?subject=Hi",
            ),
        ] {
            assert_eq!(checked_address(raw).as_deref(), Some(expected), "{raw}");
        }
    }

    #[test]
    fn everything_else_is_refused() {
        let long = format!("https://example.org/{}", "a".repeat(MAX_ADDRESS));
        for raw in [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "data:text/html,x",
            "file:///C:/Windows/system32/calc.exe",
            "C:\\Windows\\system32\\calc.exe",
            "\\\\server\\share",
            "ms-settings:",
            "vbscript:x",
            "ftp://example.org",
            "Plan.md",
            "",
            "https://",
            "https://user@example.org",
            "https://user:pw@example.org",
            "https://www.bank.example@evil.example",
            "https://example.org/\u{0}x",
            "https://example.org/\nx",
            "https://example.org/\u{7f}",
            "mailto:",
            "mailto:a@example.org?attach=C:/secret.txt",
            "mailto:a@example.org?ATTACHMENT=C:/secret.txt",
            long.as_str(),
        ] {
            assert_eq!(checked_address(raw), None, "{raw}");
        }
    }

    #[test]
    fn text_claiming_another_address_is_noticed() {
        for (visible, address) in [
            ("www.meinebank.de", "https://boese-seite.example/"),
            ("https://meinebank.de/login", "https://boese-seite.example/"),
            ("meinebank.de", "https://boese-seite.example/"),
            ("Go to www.meinebank.de now", "https://boese-seite.example/"),
            ("example.org", "https://example.org.evil.example/"),
            ("chef@firma.example", "mailto:boese@evil.example"),
            ("www.firma.example", "mailto:boese@evil.example"),
        ] {
            assert_eq!(
                claimed_other_address(visible, address).as_deref(),
                Some(visible),
                "{visible} {address}"
            );
        }
    }

    #[test]
    fn honest_text_is_left_alone() {
        for (visible, address) in [
            ("the docs", "https://example.org/"),
            ("example.org", "https://example.org/"),
            ("www.example.org", "https://example.org/"),
            ("EXAMPLE.org", "https://www.example.org/"),
            ("example.org", "https://docs.example.org/"),
            ("https://example.org/a", "https://example.org/b"),
            ("Version 1.2", "https://example.org/"),
            ("Read README.md first", "https://example.org/"),
            ("write me", "mailto:a@example.org"),
            ("a@example.org", "mailto:a@example.org"),
        ] {
            assert_eq!(
                claimed_other_address(visible, address),
                None,
                "{visible} {address}"
            );
        }
    }

    fn bare(text: &str) -> Option<&str> {
        let at = bare_address_start(text, 0, None)?;
        Some(&text[at..bare_address_end(text, at)])
    }

    #[test]
    fn a_bare_address_ends_where_a_reader_would_end_it() {
        for (text, expected) in [
            ("see https://example.org.", Some("https://example.org")),
            ("(https://example.org)", Some("https://example.org")),
            (
                "https://example.org/a_(b)",
                Some("https://example.org/a_(b)"),
            ),
            (
                "https://example.org/a_b_c, then",
                Some("https://example.org/a_b_c"),
            ),
            ("*https://example.org*", Some("https://example.org")),
            ("<https://example.org>", Some("https://example.org")),
            (
                "HTTPS://example.org/?a=1&b=2!",
                Some("HTTPS://example.org/?a=1&b=2"),
            ),
            ("xhttps://example.org", None),
            ("http is a word", None),
            ("https:// nothing", Some("https://")),
        ] {
            assert_eq!(bare(text), expected, "{text}");
        }
    }

    #[test]
    fn the_character_before_a_piece_counts() {
        assert_eq!(bare_address_start("https://a.example", 0, Some('x')), None);
        assert_eq!(
            bare_address_start("https://a.example", 0, Some(' ')),
            Some(0)
        );
    }
}
