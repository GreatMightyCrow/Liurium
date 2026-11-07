//! The protocol that gives the diagram frame its page and scripts (M3-011). It is
//! reachable from the page without a permission, so it is reviewed as a command would
//! be: it serves only the app's own embedded files on the list below, never a user's
//! file, and takes no other input.
//!
//! The frame runs Mermaid on a note's text. It needs an address of its own because its
//! CSP must differ from the app's: Mermaid styles through `<style>` and style attributes,
//! which the app's CSP blocks, and what the frame may do is far less in every other way.

use tauri::{
    Runtime, UriSchemeContext, UriSchemeResponder,
    http::{Method, Request, Response, StatusCode, header},
};

pub const SCHEME: &str = "liurium-diagram";

const PAGE: &str = "/diagram-frame.html";

/// Set in the page, so Tauri's fallback to `index.html` is told apart.
const PAGE_MARK: &[u8] = b"data-diagram-frame";

/// What the frame may do. `sandbox` also applies if the page is ever opened by itself.
const FRAME_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Served {
    Page,
    Script,
}

/// Which of the served files a request's path is, by its form alone.
fn served(path: &str) -> Option<Served> {
    if path == PAGE {
        return Some(Served::Page);
    }
    let stem = path.strip_prefix("/assets/")?.strip_suffix(".js")?;
    let plain = !stem.is_empty()
        && !stem.starts_with('.')
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    plain.then_some(Served::Script)
}

/// Tauri answers an unknown path with `index.html`, which must not go out under this
/// protocol: a script never starts with `<`, and only the frame's page has the mark.
fn is_what_it_says(kind: Served, bytes: &[u8]) -> bool {
    match kind {
        Served::Page => bytes.windows(PAGE_MARK.len()).any(|part| part == PAGE_MARK),
        Served::Script => bytes.first().is_some_and(|first| *first != b'<'),
    }
}

/// The answer for a request; `read` gives the embedded file behind a path. A refusal is
/// an empty 404.
fn response(
    method: &Method,
    path: &str,
    read: impl FnOnce(&str) -> Option<Vec<u8>>,
) -> Response<Vec<u8>> {
    let found = (method == Method::GET)
        .then(|| served(path))
        .flatten()
        .and_then(|kind| Some((kind, read(path)?)))
        .filter(|(kind, bytes)| is_what_it_says(*kind, bytes));
    let builder = Response::builder()
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store");
    let answer = match found {
        Some((Served::Page, bytes)) => builder
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, FRAME_CSP)
            .body(bytes),
        // A sandboxed frame has no origin, so its module scripts are cross-origin requests.
        // These are the app's public files, which hold no secret.
        Some((Served::Script, bytes)) => builder
            .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes),
        None => builder.status(StatusCode::NOT_FOUND).body(Vec::new()),
    };
    // Only fixed header values above, so this cannot fail; never a panic here.
    answer.unwrap_or_default()
}

/// Answers on a thread of its own: embedded files are decompressed when read.
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(response(&method, &path, |known| {
            app.asset_resolver()
                .get(known.to_owned())
                .map(|asset| asset.bytes().to_vec())
        }));
    });
}

#[cfg(test)]
#[path = "diagrams_tests.rs"]
mod tests;
