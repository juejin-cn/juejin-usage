//! Deep-link association (P5) — the `juejin-usage://` URL → local-api config
//! pipeline.
//!
//! Port of Electron's `main/deep-link.ts`. The pure, testable halves —
//! `parse_deep_link` and `find_deep_link_in_argv` — are copied in spirit from
//! the original. `deeplink_apply` writes the association through the sidecar
//! local-api (`PUT /functions/tud-config`) and reports the result to the
//! renderer via `app:juejin-link-result` — the same event-based
//! `notifyJuejinLinkResult` contract the Electron app uses (no settings modal;
//! the renderer hides 「关联掘金」 on the link-changed event and toasts
//! success/failure).
//!
//! **What this module does NOT do (release-time):** the OS-level "receive an
//! incoming `juejin-usage://` URL" hook — Electron's `app.on('open-url')` on
//! macOS and `second-instance` on Windows. That needs a native OS
//! scheme-registration (via `tauri-plugin-deep-link` / a single-instance
//! lock, neither cached in this offline build) plus a single-instance lock.
//! Those are wired at release time, mirroring how the updater feed endpoint +
//! pubkey are release-time config. The whole parse/apply/report pipeline here
//! is what that hook (or any manual trigger) invokes via `deeplink_apply`.

use serde::Serialize;
use tauri::{Emitter, Manager, State, AppHandle};

use crate::sidecar::SidecarState;

/// The custom URL scheme (mirrors `PROTOCOL_SCHEME`).
pub const PROTOCOL_SCHEME: &str = "juejin-usage";

/// Renderer event for the association result (`{ ok, message? }`).
const JUEJIN_LINK_RESULT: &str = "app:juejin-link-result";

/// Opaque `jau.` tokens are longer than plain Juejin business ids.
const TOKEN_MAX_LEN: usize = 512;
const ORIGIN_USER_ID_MAX_LEN: usize = 64;

/// Parsed `juejin-usage://link?...` payload (mirrors `DeepLinkPayload`).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkPayload {
    /// Encrypted upload identity (`jau.…`), written to `juejin.token`.
    pub user_id: String,
    /// The upload token (falls back to `user_id` when `token` is omitted).
    pub token: String,
    /// Plain Juejin id for Settings display only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_large: Option<String>,
}

/// The association result delivered to the renderer (mirrors
/// `notifyJuejinLinkResult`'s detail).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeeplinkResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn has_whitespace(value: &str) -> bool {
    value
        .bytes()
        .any(|b| b == b' ' || b == b'\t' || b == b'\n' || b == b'\r')
}

fn is_valid_token(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= TOKEN_MAX_LEN && !has_whitespace(value)
}

fn is_valid_origin_user_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= ORIGIN_USER_ID_MAX_LEN
        && !has_whitespace(value)
}

/// Strip a surrounding matched pair of single/double quotes, then trim.
/// Mirrors the inline `stripQuotes` in the original.
fn strip_quotes(value: &str) -> String {
    let trimmed = value.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() >= 2 {
        let first = chars[0];
        let last = chars[chars.len() - 1];
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return trimmed[1..trimmed.len() - 1].trim().to_string();
        }
    }
    trimmed.to_string()
}

/// Query-param lookup (first value, `""` when absent) — mirrors the original's
/// `url.searchParams.get(key)`; reads fresh `query_pairs` each call.
fn query_param(url: &url::Url, key: &str) -> String {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}

/// Pull the first `juejin-usage://…` URL out of an argv (Windows second-instance
/// / cold-start). Port of `findDeepLinkInArgv`.
pub fn find_deep_link_in_argv(argv: &[String]) -> Option<String> {
    let prefix = format!("{PROTOCOL_SCHEME}://");
    argv.iter().find(|a| a.starts_with(&prefix)).cloned()
}

/// Parse `juejin-usage://link?user_id=…&token=…&origin_user_id=…&user_name=…&avatar_large=…`.
/// When `token` is omitted, `user_id` (encrypted) is used as the upload token.
/// Port of `parseDeepLink`.
pub fn parse_deep_link(raw: &str) -> Option<DeepLinkPayload> {
    let url = url::Url::parse(raw).ok()?;

    if url.scheme() != PROTOCOL_SCHEME {
        return None;
    }

    // Host (e.g. `juejin-usage://link`) or path (e.g. `juejin-usage:link`).
    let host_or_path = url
        .host_str()
        .map(|h| h.to_ascii_lowercase())
        .or_else(|| {
            let p = url.path().trim_start_matches('/');
            (!p.is_empty()).then(|| p.to_ascii_lowercase())
        })?;
    if host_or_path != "link" {
        return None;
    }

    let user_id = strip_quotes(&query_param(&url, "user_id"));
    if !is_valid_token(&user_id) {
        return None;
    }

    let token_raw = strip_quotes(&query_param(&url, "token"));
    let token = if token_raw.is_empty() { user_id.clone() } else { token_raw };
    if !is_valid_token(&token) {
        return None;
    }

    let origin_user_id = strip_quotes(&query_param(&url, "origin_user_id"));
    let user_name = query_param(&url, "user_name").trim().to_string();
    let avatar_large = query_param(&url, "avatar_large").trim().to_string();

    Some(DeepLinkPayload {
        user_id,
        token,
        origin_user_id: if !origin_user_id.is_empty() && is_valid_origin_user_id(&origin_user_id) {
            Some(origin_user_id)
        } else {
            None
        },
        user_name: if user_name.is_empty() { None } else { Some(user_name) },
        avatar_large: if avatar_large.is_empty() { None } else { Some(avatar_large) },
    })
}

/// Build the `PUT /functions/tud-config` body for a payload. Matches the shape
/// `applyDeepLinkConfig` posts in Electron (`juejin.{enabled,token,originUserId,userName,avatarLarge}`),
/// omitting empty fields via `Option` (serde drops `None`).
fn config_body(payload: &DeepLinkPayload) -> String {
    let body = serde_json::json!({
        "juejin": {
            "enabled": true,
            "token": payload.token,
            "originUserId": payload.origin_user_id.clone(),
            "userName": payload.user_name.clone(),
            "avatarLarge": payload.avatar_large.clone(),
        }
    });
    serde_json::to_string(&body).unwrap_or_default()
}

/// Fire `PUT <sidecar>/functions/tud-config` with the association payload and
/// return the parsed result. Raw loopback TCP (no HTTP-client crate) so the
/// offline build stays dependency-free, matching `sidecar.rs::trigger_sync`.
fn apply_via_sidecar(port: u16, body: &str) -> DeeplinkResult {
    use std::io::{Read, Write};

    let addr = std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), port);
    let mut stream = match std::net::TcpStream::connect_timeout(
        &addr,
        std::time::Duration::from_secs(3),
    ) {
        Ok(s) => s,
        Err(_) => {
            return DeeplinkResult {
                ok: false,
                message: Some("本地服务未就绪，无法完成关联".to_string()),
            }
        }
    };

    let req = format!(
        "PUT /functions/tud-config HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n\
         {body}",
        body.len()
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return DeeplinkResult { ok: false, message: Some("关联失败".to_string()) };
    }

    // Read the whole (short) response, then split status line and body.
    let mut resp = Vec::new();
    let _ = stream.read_to_end(&mut resp);
    let text = String::from_utf8_lossy(&resp).into_owned();

    let status: u16 = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body_part = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");

    if !(200..300).contains(&status) {
        let message = serde_json::from_str::<serde_json::Value>(body_part)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return DeeplinkResult { ok: false, message: Some(message) };
    }

    DeeplinkResult { ok: true, message: None }
}

// ---- Tauri command surface --------------------------------------------------

/// Core apply path shared by the command and the cold-start drain: parse the
/// link, write the association through the sidecar local-api (waiting for the
/// port if it's not up yet), and report on `app:juejin-link-result`.
fn apply(app: &AppHandle, sidecar: &SidecarState, raw_url: &str) -> DeeplinkResult {
    // Invalid links never reach the sidecar.
    let Some(payload) = parse_deep_link(raw_url) else {
        let result = DeeplinkResult {
            ok: false,
            message: Some("无效的关联链接".to_string()),
        };
        let _ = app.emit(JUEJIN_LINK_RESULT, &result);
        return result;
    };
    let body = config_body(&payload);

    let port = sidecar.port.lock().unwrap().clone();
    match port {
        Some(p) => {
            let result = apply_via_sidecar(p, &body);
            let _ = app.emit(JUEJIN_LINK_RESULT, &result);
            result
        }
        None => {
            // Sidecar not ready yet: wait (bounded) for its port, then apply.
            let wait = sidecar.port.clone();
            let app_clone = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let mut port: Option<u16> = None;
                for _ in 0..30 {
                    let bound = *wait.lock().unwrap();
                    if bound.is_some() {
                        port = bound;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                let result = match port {
                    Some(p) => apply_via_sidecar(p, &body),
                    None => DeeplinkResult {
                        ok: false,
                        message: Some("本地服务未就绪，无法完成关联".to_string()),
                    },
                };
                let _ = app_clone.emit(JUEJIN_LINK_RESULT, &result);
            });
            // Acknowledge the request; the definitive result arrives on the event.
            DeeplinkResult { ok: true, message: None }
        }
    }
}

/// Apply a `juejin-usage://` deep link (invoked by a release-time OS hook, or
/// manually). Thin Tauri-command wrapper over [`apply`].
#[tauri::command]
pub fn deeplink_apply(
    app: AppHandle,
    sidecar: State<'_, SidecarState>,
    raw_url: String,
) -> DeeplinkResult {
    apply(&app, &sidecar, &raw_url)
}

/// Called from `setup`: apply any cold-start `juejin-usage://` process arg
/// (Windows parity with Electron's `findDeepLinkInArgv(process.argv)`). The
/// bounded sidecar wait in [`apply`] subsumes Electron's `pendingDeepLinkUrl`
/// queue: if the sidecar isn't up yet, the result is delivered to the renderer
/// once it reports its port.
pub fn create(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    let Some(raw) = find_deep_link_in_argv(&args) else {
        return;
    };
    eprintln!("[tud-desktop] cold-start deep link: {raw}");
    let sidecar = app.state::<SidecarState>();
    apply(app, &sidecar, &raw);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_full_link() {
        let p = parse_deep_link("juejin-usage://link?user_id=jau_abc&token=jau_tok&origin_user_id=123&user_name=Alice&avatar_large=https%3A%2F%2Fx%2F1.png").unwrap();
        assert_eq!(p.user_id, "jau_abc");
        assert_eq!(p.token, "jau_tok");
        assert_eq!(p.origin_user_id.as_deref(), Some("123"));
        assert_eq!(p.user_name.as_deref(), Some("Alice"));
        assert_eq!(p.avatar_large.as_deref(), Some("https://x/1.png"));
    }

    #[test]
    fn token_falls_back_to_user_id() {
        let p = parse_deep_link("juejin-usage://link?user_id=jau_abc").unwrap();
        assert_eq!(p.token, "jau_abc");
    }

    #[test]
    fn bad_host_rejected() {
        assert!(parse_deep_link("juejin-usage://nope?user_id=x&token=y").is_none());
        assert!(parse_deep_link("https://link?user_id=x&token=y").is_none());
    }

    #[test]
    fn whitespace_token_rejected() {
        assert!(parse_deep_link("juejin-usage://link?user_id=a%20b&token=c").is_none());
    }

    #[test]
    fn argv_scan() {
        let argv = vec![
            "app".to_string(),
            "juejin-usage://link?user_id=x&token=y".to_string(),
        ];
        assert_eq!(
            find_deep_link_in_argv(&argv).unwrap(),
            "juejin-usage://link?user_id=x&token=y"
        );
        assert!(find_deep_link_in_argv(&["app".to_string()]).is_none());
    }
}
