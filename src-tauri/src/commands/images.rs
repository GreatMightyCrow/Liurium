//! The protocol that gives the page a note's images (M3-013, ADR-0020). It is reachable
//! from the page without a permission, so it checks as a command would: only the open
//! project, only a path the walk listed as an image, only bytes that are one. A refusal
//! is an empty 404 that says nothing about what exists.
//!
//! An SVG can hold scripts, and it is served unchanged: the page shows it only in an
//! image element, where a browser runs nothing and loads nothing from outside, and its
//! response forbids everything if it were ever opened as a page (M3-019).

use tauri::{
    Manager, Runtime, UriSchemeContext, UriSchemeResponder,
    http::{Method, Request, Response, StatusCode, header},
};

use super::Workspace;
use crate::domain::notes::links::percent_decode;
use crate::storage::fs::RelPath;

pub const SCHEME: &str = "liurium-image";

/// A larger file is not read at all.
pub const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

/// A larger SVG is not read at all. It is text the page's own thread has to parse, which
/// took about 1.2 s for 10 MB, so the limit for pictures would freeze the window.
pub const MAX_SVG_BYTES: u64 = 10 * 1024 * 1024;

/// The type the first bytes show, or `None` for anything that is no image Liurium
/// shows. This decides, not the file's name: a note or database renamed to `.png` fails.
/// An SVG has no such bytes; see [`is_svg`].
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.starts_with(PNG) {
        Some("image/png")
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if is_bmp(bytes) {
        Some("image/bmp")
    } else if is_avif(bytes) {
        Some("image/avif")
    } else {
        None
    }
}

/// `BM` alone is short, so the size of the header after it must fit too.
fn is_bmp(bytes: &[u8]) -> bool {
    bytes.starts_with(b"BM")
        && bytes
            .get(14..18)
            .and_then(|size| <[u8; 4]>::try_from(size).ok())
            .is_some_and(|size| matches!(u32::from_le_bytes(size), 12 | 40 | 52 | 56 | 108 | 124))
}

/// An ISO file box `ftyp` that names AVIF among its brands.
fn is_avif(bytes: &[u8]) -> bool {
    if bytes.get(4..8) != Some(b"ftyp") {
        return false;
    }
    let Some(size) = bytes
        .get(..4)
        .and_then(|size| <[u8; 4]>::try_from(size).ok())
        .map(u32::from_be_bytes)
        .and_then(|size| usize::try_from(size).ok())
    else {
        return false;
    };
    bytes.get(8..size.min(bytes.len())).is_some_and(|brands| {
        brands
            .as_chunks::<4>()
            .0
            .iter()
            .any(|brand| brand == b"avif" || brand == b"avis")
    })
}

/// Whether the first element is `<svg`, after what XML allows before it. A note, a
/// database, or a picture renamed to `.svg` fails here. Whether the rest is good XML is
/// for the browser's parser, which refuses a broken file; bytes, as a declared encoding
/// may not be UTF-8, while UTF-16 fails.
pub fn is_svg(bytes: &[u8]) -> bool {
    let mut rest = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    loop {
        rest = rest.trim_ascii_start();
        let next = if rest.starts_with(b"<?") {
            after(rest, b"?>")
        } else if rest.starts_with(b"<!--") {
            after(rest, b"-->")
        } else if rest.starts_with(b"<!DOCTYPE") {
            after_doctype(rest)
        } else {
            break;
        };
        let Some(next) = next else {
            return false;
        };
        rest = next;
    }
    rest.strip_prefix(b"<svg:svg")
        .or_else(|| rest.strip_prefix(b"<svg"))
        .and_then(<[u8]>::first)
        .is_some_and(|next| next.is_ascii_whitespace() || matches!(next, b'>' | b'/'))
}

/// What follows the first `end`.
fn after<'a>(text: &'a [u8], end: &[u8]) -> Option<&'a [u8]> {
    let at = text.windows(end.len()).position(|each| each == end)?;
    text.get(at + end.len()..)
}

/// What follows a doctype, whose `[…]` may hold a `>` in each of its declarations.
fn after_doctype(text: &[u8]) -> Option<&[u8]> {
    let open = text.iter().position(|byte| matches!(byte, b'[' | b'>'))?;
    let mut rest = text.get(open..)?;
    if let Some(end) = rest.strip_prefix(b">") {
        return Some(end);
    }
    loop {
        rest = after(rest, b"]")?;
        if let Some(end) = rest.trim_ascii_start().strip_prefix(b">") {
            return Some(end);
        }
    }
}

impl Workspace {
    /// The bytes and type behind a request's path: `/<project>/<path>`. `None` for
    /// everything that may not be served; the reason stays here on purpose.
    pub fn image_at(&self, uri_path: &str) -> Option<(Vec<u8>, &'static str)> {
        let (project, path) = uri_path.strip_prefix('/')?.split_once('/')?;
        let (id, root) = self.open_root().ok()??;
        if percent_decode(project)? != id {
            return None;
        }
        let path = percent_decode(path)?;
        let images = self.note_index().image_set(&id)?;
        // On the list means found by the walk's rules, with an image's name.
        let known = images.listed(&path)?;
        let rel = RelPath::parse(&known.path).ok()?;
        // Only a file named so is read as one, so SVG bytes named `.png` fail too.
        let svg = known.path.to_lowercase().ends_with(".svg");
        let limit = if svg { MAX_SVG_BYTES } else { MAX_IMAGE_BYTES };
        let (bytes, _) = root.read_unprotected(&rel, limit).ok()?;
        let kind = if svg {
            is_svg(&bytes).then_some("image/svg+xml")?
        } else {
            image_type(&bytes)?
        };
        Some((bytes, kind))
    }

    fn image_response(&self, method: &Method, uri_path: &str) -> Response<Vec<u8>> {
        let found = (method == Method::GET)
            .then(|| self.image_at(uri_path))
            .flatten();
        let builder = Response::builder()
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            // Not copied into WebView2's disk cache; the address changes with the file.
            .header(header::CACHE_CONTROL, "no-store")
            // An image needs none of this; if it were ever opened as a page, it can do nothing.
            .header(
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; sandbox",
            );
        let response = match found {
            Some((bytes, kind)) => builder.header(header::CONTENT_TYPE, kind).body(bytes),
            None => builder.status(StatusCode::NOT_FOUND).body(Vec::new()),
        };
        // Only fixed header values above, so this cannot fail; never a panic here.
        response.unwrap_or_default()
    }
}

/// Answers on a thread of its own: a large file must not hold up the window.
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let Some(workspace) = context
        .app_handle()
        .try_state::<Workspace>()
        .map(|state| state.inner().clone())
    else {
        let mut none = Response::new(Vec::new());
        *none.status_mut() = StatusCode::NOT_FOUND;
        responder.respond(none);
        return;
    };
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(workspace.image_response(&method, &path));
    });
}

#[cfg(test)]
#[path = "images_tests.rs"]
mod tests;
