use super::*;

fn page() -> Vec<u8> {
    b"<!doctype html><html lang=\"en\" data-diagram-frame></html>".to_vec()
}

const SCRIPT: &[u8] = b"import x from './y.js';";
const APP_PAGE: &[u8] = b"<!doctype html><html lang=\"en\"><body></body></html>";

fn get(path: &str, file: &[u8]) -> Response<Vec<u8>> {
    let file = file.to_vec();
    response(&Method::GET, path, move |_| Some(file))
}

fn header_of(answer: &Response<Vec<u8>>, name: header::HeaderName) -> Option<&str> {
    answer
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

#[test]
fn only_the_frame_page_and_plain_script_names_are_served() {
    assert_eq!(served("/diagram-frame.html"), Some(Served::Page));
    assert_eq!(served("/assets/frame-Ab_1.c.js"), Some(Served::Script));
    for path in [
        "/",
        "",
        "/index.html",
        "/assets/",
        "/assets/.js",
        "/assets/.hidden.js",
        "/assets/x.css",
        "/assets/x.js.map",
        "/assets/../index.js",
        "/assets/..%2Findex.js",
        "/assets/a/b.js",
        "/assets/a\\b.js",
        "/assets/%2e%2e/secret.js",
        "/diagram-frame.html/",
        "//assets/x.js",
        "/DIAGRAM-FRAME.HTML",
    ] {
        assert_eq!(served(path), None, "{path}");
    }
}

#[test]
fn the_page_carries_the_frames_policy_and_is_sandboxed() {
    let answer = response(&Method::GET, PAGE, |_| Some(page()));
    assert_eq!(answer.status(), StatusCode::OK);
    let csp = header_of(&answer, header::CONTENT_SECURITY_POLICY).unwrap();
    assert!(csp.contains("default-src 'none'"));
    assert!(csp.contains("script-src 'self'"));
    assert!(csp.ends_with("sandbox allow-scripts"));
    // It must not gain the origin back, reach outside, or run inline scripts.
    assert!(!csp.contains("allow-same-origin"));
    assert!(!csp.contains("connect-src"));
    assert!(!csp.contains("script-src 'self' 'unsafe"));
    assert_eq!(
        header_of(&answer, header::X_CONTENT_TYPE_OPTIONS),
        Some("nosniff")
    );
    assert_eq!(
        header_of(&answer, header::ACCESS_CONTROL_ALLOW_ORIGIN),
        None
    );
}

#[test]
fn a_script_can_be_loaded_by_a_frame_without_an_origin() {
    let answer = get("/assets/frame-1.js", SCRIPT);
    assert_eq!(answer.status(), StatusCode::OK);
    assert_eq!(answer.body(), SCRIPT);
    assert_eq!(
        header_of(&answer, header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some("*")
    );
    assert_eq!(
        header_of(&answer, header::CONTENT_TYPE),
        Some("text/javascript; charset=utf-8")
    );
}

#[test]
fn the_app_page_from_tauris_fallback_is_never_served() {
    for path in [PAGE, "/assets/gone.js"] {
        let answer = get(path, APP_PAGE);
        assert_eq!(answer.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(answer.body().is_empty(), "{path}");
    }
}

#[test]
fn what_is_refused_is_not_even_read() {
    let read = |_: &str| -> Option<Vec<u8>> { panic!("must not be read") };
    assert_eq!(
        response(&Method::GET, "/index.html", read).status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        response(&Method::POST, PAGE, read).status(),
        StatusCode::NOT_FOUND
    );
}

#[test]
fn a_file_not_there_is_a_plain_404() {
    let answer = response(&Method::GET, PAGE, |_| None);
    assert_eq!(answer.status(), StatusCode::NOT_FOUND);
    assert!(answer.body().is_empty());
}
