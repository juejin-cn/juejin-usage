//! Share-card "copy image" (P2). Port of Electron's `registerShareCardIpc` in
//! `apps/desktop/src/main/index.ts`.
//!
//! The renderer's `copyImageToClipboard(dataUrl)` resolves to a `bool`. On
//! success the PNG image is placed on the OS clipboard (via `arboard`, which
//! bridges to `NSPasteboard` on macOS / the clipboard API on Windows) so the
//! user can paste it into another app; on any guard or write failure we
//! return `false` and let the UI degrade gracefully, mirroring Electron's
//! `if (image.isEmpty()) return false`.

use std::borrow::Cow;

use arboard::ImageData;
use base64::Engine;

/// The exact prefix the renderer's share-card renderer emits
/// (`data:image/png;base64,…`); anything else is rejected up front.
const PNG_DATA_PREFIX: &str = "data:image/png;base64,";
/// Matches Electron's 20 MB cap on the raw data URL.
const MAX_DATA_URL_LEN: usize = 20_000_000;

/// Decode `data:image/png;base64,…` into an RGBA image and put it on the OS
/// clipboard.
///
/// Validates the prefix + size, base64-decodes, decodes the PNG into RGBA, and
/// hands it to `arboard`. Returns `true` only when the write succeeds.
pub fn write_png_to_clipboard(data_url: &str) -> bool {
    if !data_url.starts_with(PNG_DATA_PREFIX) || data_url.len() > MAX_DATA_URL_LEN {
        return false;
    }

    // Strip the prefix; the remainder is the base64 payload.
    let b64 = &data_url[PNG_DATA_PREFIX.len()..];
    let Ok(png_bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
        return false;
    };

    // Decode PNG → RGBA. `into_rgba8` normalizes any PNG color type to RGBA.
    let Ok(reader) =
        image::ImageReader::new(std::io::Cursor::new(png_bytes)).with_guessed_format()
    else {
        return false;
    };
    let Ok(img) = reader.decode() else {
        return false;
    };
    let img = img.into_rgba8();
    if img.as_raw().is_empty() {
        return false;
    }

    let rgba = ImageData {
        width: img.width() as usize,
        height: img.height() as usize,
        bytes: Cow::Owned(img.into_raw()),
    };

    match arboard::Clipboard::new() {
        Ok(mut clipboard) => clipboard.set_image(rgba).is_ok(),
        Err(_) => false,
    }
}

/// `#[tauri::command]`: the renderer sends `{ dataUrl }`; we forward it to
/// [`write_png_to_clipboard`].
#[tauri::command]
pub fn copy_image_to_clipboard(data_url: String) -> bool {
    write_png_to_clipboard(&data_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_prefix() {
        assert!(!write_png_to_clipboard("data:image/jpeg;base64,AAAA"));
        assert!(!write_png_to_clipboard("https://x/y.png"));
        assert!(!write_png_to_clipboard(""));
    }

    #[test]
    fn rejects_bad_base64() {
        // Valid prefix, but the base64 is not a decodable PNG.
        assert!(!write_png_to_clipboard("data:image/png;base64,!!notbase64!!"));
    }
}
