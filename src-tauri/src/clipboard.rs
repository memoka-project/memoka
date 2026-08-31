use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const MEMOKA_CLIPBOARD_MIME: &str = "application/x-memoka-structured-blocks+json";
const MARKDOWN_CLIPBOARD_MIME: &str = "text/markdown";
const HTML_CLIPBOARD_MIME: &str = "text/html";
const TSV_CLIPBOARD_MIME: &str = "text/tab-separated-values";
const PLAIN_CLIPBOARD_MIME: &str = "text/plain";
const UTF8_PLAIN_CLIPBOARD_MIME: &str = "text/plain;charset=utf-8";
#[cfg(target_os = "linux")]
const URI_LIST_CLIPBOARD_MIME: &str = "text/uri-list";
#[cfg(target_os = "linux")]
const GNOME_FILES_CLIPBOARD_MIME: &str = "x-special/gnome-copied-files";
#[cfg(target_os = "linux")]
const PORTAL_FILE_TRANSFER_CLIPBOARD_MIME: &str = "application/vnd.portal.filetransfer";
#[cfg(target_os = "linux")]
const PORTAL_FILES_CLIPBOARD_MIME: &str = "application/vnd.portal.files";
#[cfg(target_os = "linux")]
const URI_CLIPBOARD_MIME_CANDIDATES: [&str; 3] = [
    URI_LIST_CLIPBOARD_MIME,
    PORTAL_FILE_TRANSFER_CLIPBOARD_MIME,
    PORTAL_FILES_CLIPBOARD_MIME,
];
#[cfg(any(
    target_os = "linux",
    target_os = "windows",
    all(test, feature = "windows-clipboard-contract")
))]
const MAX_PREFERRED_CLIPBOARD_BYTES: u64 = 32 * 1024 * 1024;

#[cfg(any(
    target_os = "windows",
    all(test, feature = "windows-clipboard-contract")
))]
#[path = "clipboard_windows.rs"]
mod windows_clipboard;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreferredClipboardFormats {
    available_types: Vec<String>,
    internal: Option<String>,
    markdown: Option<String>,
    html: Option<String>,
    tsv: Option<String>,
    plain: Option<String>,
    file_paths: Vec<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExplicitClipboardContent {
    available_types: Vec<String>,
    source_mime: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RichClipboardFormats {
    internal: String,
    html: String,
    markdown: String,
    plain: String,
    tsv: Option<String>,
}

#[cfg(target_os = "linux")]
struct RichFileClipboardPayloads {
    strings: Vec<(String, String)>,
    uris: Vec<String>,
}

#[tauri::command]
pub(crate) async fn clipboard_write_rich(
    app: AppHandle,
    formats: RichClipboardFormats,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        validate_rich_clipboard_formats(&formats)?;
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        app.run_on_main_thread(move || {
            let _ = sender.try_send(write_linux_rich_clipboard(formats));
        })
        .map_err(|error| format!("cannot schedule GTK Clipboard write: {error}"))?;
        return receiver
            .recv()
            .await
            .ok_or_else(|| "GTK Clipboard write ended without a result".to_owned())?;
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        validate_rich_clipboard_formats(&formats)?;
        return tauri::async_runtime::spawn_blocking(move || {
            windows_clipboard::write_rich_clipboard(formats)
        })
        .await
        .map_err(|error| format!("Windows Clipboard write task failed: {error}"))?;
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (app, formats);
        Err("native rich Clipboard write is not implemented on this platform".to_owned())
    }
}

#[tauri::command]
pub(crate) async fn clipboard_read_preferred(
    app: AppHandle,
) -> Result<Option<PreferredClipboardFormats>, String> {
    #[cfg(target_os = "linux")]
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        app.run_on_main_thread(move || {
            let _ = sender.try_send(read_linux_preferred_clipboard());
        })
        .map_err(|error| format!("cannot schedule GTK Clipboard read: {error}"))?;
        return receiver
            .recv()
            .await
            .ok_or_else(|| "GTK Clipboard read ended without a result".to_owned())?;
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return tauri::async_runtime::spawn_blocking(windows_clipboard::read_preferred_clipboard)
            .await
            .map_err(|error| format!("Windows Clipboard read task failed: {error}"))?;
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = app;
        Ok(None)
    }
}

#[tauri::command]
pub(crate) async fn clipboard_read_explicit(
    app: AppHandle,
    format: String,
) -> Result<Option<ExplicitClipboardContent>, String> {
    explicit_requested_mime(&format)?;
    #[cfg(target_os = "linux")]
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        app.run_on_main_thread(move || {
            let _ = sender.try_send(read_linux_explicit_clipboard(&format));
        })
        .map_err(|error| format!("cannot schedule GTK Clipboard read: {error}"))?;
        return receiver
            .recv()
            .await
            .ok_or_else(|| "GTK Clipboard read ended without a result".to_owned())?;
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return tauri::async_runtime::spawn_blocking(move || {
            windows_clipboard::read_explicit_clipboard(&format)
        })
        .await
        .map_err(|error| format!("Windows Clipboard read task failed: {error}"))?;
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (app, format);
        Ok(None)
    }
}

#[cfg(any(
    target_os = "linux",
    target_os = "windows",
    all(test, feature = "windows-clipboard-contract")
))]
fn validate_rich_clipboard_formats(formats: &RichClipboardFormats) -> Result<(), String> {
    for (mime_type, content) in [
        (MEMOKA_CLIPBOARD_MIME, formats.internal.as_str()),
        (HTML_CLIPBOARD_MIME, formats.html.as_str()),
        (MARKDOWN_CLIPBOARD_MIME, formats.markdown.as_str()),
        (PLAIN_CLIPBOARD_MIME, formats.plain.as_str()),
    ] {
        validate_clipboard_size(mime_type, content.len())?;
    }
    if let Some(tsv) = &formats.tsv {
        validate_clipboard_size(TSV_CLIPBOARD_MIME, tsv.len())?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn write_linux_rich_clipboard(formats: RichClipboardFormats) -> Result<(), String> {
    let payloads = rich_clipboard_targets(&formats)
        .into_iter()
        .map(|(mime_type, content)| (mime_type.to_owned(), content.to_owned()))
        .collect::<Vec<_>>();
    write_linux_clipboard_payloads(payloads, None, "rich")
}

#[cfg(target_os = "linux")]
fn write_linux_clipboard_payloads(
    payloads: Vec<(String, String)>,
    uri_payload: Option<Vec<String>>,
    ownership_kind: &str,
) -> Result<(), String> {
    let mut targets = payloads
        .iter()
        .enumerate()
        .map(|(index, (mime_type, _))| {
            gtk::TargetEntry::new(mime_type, gtk::TargetFlags::empty(), index as u32)
        })
        .collect::<Vec<_>>();
    let uri_info = uri_payload.as_ref().map(|_| payloads.len() as u32);
    if let Some(uri_info) = uri_info {
        targets.extend(linux_uri_target_entries(uri_info));
    }
    let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    let wrote = clipboard.set_with_data(&targets, move |_clipboard, selection, index| {
        if uri_info == Some(index) {
            if let Some(uris) = &uri_payload {
                let uris = uris.iter().map(String::as_str).collect::<Vec<_>>();
                let _ = selection.set_uris(&uris);
            }
            return;
        }
        if let Some((mime_type, content)) = payloads.get(index as usize) {
            selection.set(&gdk::Atom::intern(mime_type), 8, content.as_bytes());
        }
    });
    if !wrote {
        return Err(format!(
            "GTK Clipboard refused {ownership_kind} target ownership"
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_uri_target_entries(info: u32) -> Vec<gtk::TargetEntry> {
    // GTK conditionally adds both current and legacy FileTransfer Portal
    // targets when the session portal is available. Using this target list is
    // important: manually advertising only text/uri-list bypasses GTK's
    // StartTransfer/AddFiles implementation and some Wayland file managers
    // consequently reject the paste.
    let supported = gtk::TargetList::new(&[]);
    supported.add_uri_targets(info);
    URI_CLIPBOARD_MIME_CANDIDATES
        .into_iter()
        .filter(|mime_type| supported.find(&gdk::Atom::intern(mime_type)).is_some())
        .map(|mime_type| gtk::TargetEntry::new(mime_type, gtk::TargetFlags::empty(), info))
        .collect()
}

#[cfg(target_os = "linux")]
fn rich_clipboard_targets(formats: &RichClipboardFormats) -> Vec<(&'static str, &str)> {
    let mut targets = vec![
        (MEMOKA_CLIPBOARD_MIME, formats.internal.as_str()),
        ("text/html", formats.html.as_str()),
        (MARKDOWN_CLIPBOARD_MIME, formats.markdown.as_str()),
        ("text/plain", formats.plain.as_str()),
        ("text/plain;charset=utf-8", formats.plain.as_str()),
    ];
    if let Some(tsv) = &formats.tsv {
        targets.push((TSV_CLIPBOARD_MIME, tsv.as_str()));
    }
    targets
}

#[cfg(target_os = "linux")]
fn read_linux_preferred_clipboard() -> Result<Option<PreferredClipboardFormats>, String> {
    let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    let mut available_types: Vec<_> = clipboard
        .wait_for_targets()
        .ok_or_else(|| "GTK Clipboard did not expose target MIME types".to_owned())?
        .into_iter()
        .map(|target| target.name().to_string())
        .collect();
    available_types.sort();

    let preferred = preferred_mime_types(&available_types);
    let file_mime = preferred_file_mime(&available_types);
    let plain_mime = preferred_plain_fallback_mime(&available_types);
    if preferred.is_empty() && file_mime.is_none() && plain_mime.is_none() {
        return Ok(None);
    }

    let internal = preferred
        .contains(&MEMOKA_CLIPBOARD_MIME)
        .then(|| read_linux_clipboard_mime(&clipboard, MEMOKA_CLIPBOARD_MIME))
        .transpose()?;
    let markdown = preferred
        .contains(&MARKDOWN_CLIPBOARD_MIME)
        .then(|| read_linux_clipboard_mime(&clipboard, MARKDOWN_CLIPBOARD_MIME))
        .transpose()?;
    let html = preferred
        .contains(&HTML_CLIPBOARD_MIME)
        .then(|| read_linux_clipboard_mime(&clipboard, HTML_CLIPBOARD_MIME))
        .transpose()?;
    let tsv = preferred
        .contains(&TSV_CLIPBOARD_MIME)
        .then(|| read_linux_clipboard_mime(&clipboard, TSV_CLIPBOARD_MIME))
        .transpose()?;
    let plain = plain_mime
        .map(|mime_type| read_linux_clipboard_mime(&clipboard, mime_type))
        .transpose()?;
    let file_paths = file_mime
        .map(|mime_type| {
            read_linux_clipboard_mime(&clipboard, mime_type)
                .and_then(|content| parse_linux_file_clipboard(mime_type, &content))
        })
        .transpose()?
        .unwrap_or_default();

    Ok(Some(PreferredClipboardFormats {
        available_types,
        internal,
        markdown,
        html,
        tsv,
        plain,
        file_paths,
    }))
}

#[cfg(target_os = "linux")]
pub(crate) async fn write_rich_file_paths(
    app: AppHandle,
    paths: Vec<String>,
    formats: RichClipboardFormats,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.try_send(write_linux_rich_file_clipboard(paths, formats));
    })
    .map_err(|error| format!("cannot schedule GTK rich file Clipboard write: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "GTK rich file Clipboard write ended without a result".to_owned())?
}

#[cfg(not(target_os = "linux"))]
pub(crate) async fn write_rich_file_paths(
    app: AppHandle,
    paths: Vec<String>,
    formats: RichClipboardFormats,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        validate_rich_clipboard_formats(&formats)?;
        return tauri::async_runtime::spawn_blocking(move || {
            windows_clipboard::write_rich_file_clipboard(paths, formats)
        })
        .await
        .map_err(|error| format!("Windows file Clipboard write task failed: {error}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, paths, formats);
        Err("native file Clipboard is not implemented on this platform".to_owned())
    }
}

#[cfg(target_os = "linux")]
fn write_linux_rich_file_clipboard(
    paths: Vec<String>,
    formats: RichClipboardFormats,
) -> Result<(), String> {
    let payloads = rich_file_clipboard_payloads(paths, &formats)?;
    write_linux_clipboard_payloads(payloads.strings, Some(payloads.uris), "rich file")
}

#[cfg(target_os = "linux")]
fn rich_file_clipboard_payloads(
    paths: Vec<String>,
    formats: &RichClipboardFormats,
) -> Result<RichFileClipboardPayloads, String> {
    validate_rich_clipboard_formats(formats)?;
    let mut payloads = rich_clipboard_targets(formats)
        .into_iter()
        .map(|(mime_type, content)| (mime_type.to_owned(), content.to_owned()))
        .collect::<Vec<_>>();
    let (uris, gnome) = file_clipboard_payloads(paths)?;
    payloads.push((GNOME_FILES_CLIPBOARD_MIME.to_owned(), gnome));
    Ok(RichFileClipboardPayloads {
        strings: payloads,
        uris,
    })
}

#[cfg(target_os = "linux")]
fn file_clipboard_payloads(paths: Vec<String>) -> Result<(Vec<String>, String), String> {
    if paths.is_empty() {
        return Err("file Clipboard requires at least one path".to_owned());
    }
    let uris = paths
        .iter()
        .map(|path| file_uri_from_path(path))
        .collect::<Result<Vec<_>, _>>()?;
    let uri_list = format!("{}\r\n", uris.join("\r\n"));
    // Nautilus rejects empty URI lines when deserializing this private
    // format. In particular, a trailing newline becomes an empty final line,
    // so match Nautilus' own serializer and omit it.
    let gnome = format!("copy\n{}", uris.join("\n"));
    validate_clipboard_size(URI_LIST_CLIPBOARD_MIME, uri_list.len())?;
    validate_clipboard_size(GNOME_FILES_CLIPBOARD_MIME, gnome.len())?;
    Ok((uris, gnome))
}

#[cfg(target_os = "linux")]
fn preferred_file_mime(available_types: &[String]) -> Option<&'static str> {
    [GNOME_FILES_CLIPBOARD_MIME, URI_LIST_CLIPBOARD_MIME]
        .into_iter()
        .find(|mime_type| available_types.iter().any(|value| value == mime_type))
}

#[cfg(target_os = "linux")]
fn parse_linux_file_clipboard(mime_type: &str, content: &str) -> Result<Vec<String>, String> {
    let lines = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let lines: Vec<_> = if mime_type == GNOME_FILES_CLIPBOARD_MIME {
        lines.skip(1).collect()
    } else {
        lines.filter(|line| !line.starts_with('#')).collect()
    };
    lines.into_iter().map(local_path_from_file_uri).collect()
}

#[cfg(target_os = "linux")]
fn file_uri_from_path(path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("file Clipboard path must be an absolute local path".to_owned());
    }
    let mut encoded = String::from("file://");
    for byte in path.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(encoded)
}

#[cfg(target_os = "linux")]
fn local_path_from_file_uri(uri: &str) -> Result<String, String> {
    let encoded = uri
        .strip_prefix("file://")
        .ok_or_else(|| "file Clipboard contains a non-file URI".to_owned())?;
    if !encoded.starts_with('/') {
        return Err("remote file Clipboard URIs are not supported".to_owned());
    }
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("file Clipboard URI has invalid percent encoding".to_owned());
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let path = String::from_utf8(decoded)
        .map_err(|_| "file Clipboard path is not valid UTF-8".to_owned())?;
    if path.contains('\0') {
        return Err("file Clipboard path contains NUL".to_owned());
    }
    Ok(path)
}

#[cfg(target_os = "linux")]
fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("file Clipboard URI has invalid percent encoding".to_owned()),
    }
}

#[cfg(target_os = "linux")]
fn read_linux_explicit_clipboard(format: &str) -> Result<Option<ExplicitClipboardContent>, String> {
    let requested_mime = explicit_requested_mime(format)?;
    let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    let mut available_types: Vec<_> = clipboard
        .wait_for_targets()
        .ok_or_else(|| "GTK Clipboard did not expose target MIME types".to_owned())?
        .into_iter()
        .map(|target| target.name().to_string())
        .collect();
    available_types.sort();

    if available_types
        .iter()
        .any(|available| available == requested_mime)
    {
        let content = read_linux_clipboard_mime(&clipboard, requested_mime)?;
        return Ok(Some(ExplicitClipboardContent {
            available_types,
            source_mime: requested_mime.to_owned(),
            content,
        }));
    }

    if let Some(plain_mime) = explicit_plain_mime(&available_types) {
        let content = read_linux_clipboard_mime(&clipboard, plain_mime)?;
        return Ok(Some(ExplicitClipboardContent {
            available_types,
            source_mime: plain_mime.to_owned(),
            content,
        }));
    }

    let Some(text) = clipboard.wait_for_text() else {
        return Ok(None);
    };
    validate_clipboard_size(PLAIN_CLIPBOARD_MIME, text.len())?;
    Ok(Some(ExplicitClipboardContent {
        available_types,
        source_mime: PLAIN_CLIPBOARD_MIME.to_owned(),
        content: text.to_string(),
    }))
}

fn explicit_requested_mime(format: &str) -> Result<&'static str, String> {
    match format {
        "markdown" => Ok(MARKDOWN_CLIPBOARD_MIME),
        "html" => Ok(HTML_CLIPBOARD_MIME),
        _ => Err(format!("unsupported explicit Clipboard format: {format}")),
    }
}

#[cfg(target_os = "linux")]
fn explicit_plain_mime(available_types: &[String]) -> Option<&'static str> {
    [PLAIN_CLIPBOARD_MIME, UTF8_PLAIN_CLIPBOARD_MIME]
        .into_iter()
        .find(|mime_type| {
            available_types
                .iter()
                .any(|available| available == mime_type)
        })
}

#[cfg(target_os = "linux")]
fn read_linux_clipboard_mime(
    clipboard: &gtk::Clipboard,
    mime_type: &str,
) -> Result<String, String> {
    let target = gdk::Atom::intern(mime_type);
    let bytes = clipboard
        .wait_for_contents(&target)
        .ok_or_else(|| format!("GTK Clipboard MIME {mime_type} has no readable contents"))?
        .data();
    decode_clipboard_bytes(mime_type, bytes)
}

#[cfg(any(
    target_os = "linux",
    target_os = "windows",
    all(test, feature = "windows-clipboard-contract")
))]
fn validate_clipboard_size(mime_type: &str, size: usize) -> Result<(), String> {
    if size as u64 > MAX_PREFERRED_CLIPBOARD_BYTES {
        return Err(format!(
            "Clipboard MIME {mime_type} exceeds the {} byte limit",
            MAX_PREFERRED_CLIPBOARD_BYTES
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn decode_clipboard_bytes(mime_type: &str, bytes: Vec<u8>) -> Result<String, String> {
    validate_clipboard_size(mime_type, bytes.len())?;
    String::from_utf8(bytes)
        .map_err(|error| format!("GTK Clipboard MIME {mime_type} is not UTF-8: {error}"))
}

#[cfg(target_os = "linux")]
fn preferred_mime_types(available_types: &[String]) -> Vec<&'static str> {
    [
        MEMOKA_CLIPBOARD_MIME,
        HTML_CLIPBOARD_MIME,
        TSV_CLIPBOARD_MIME,
        MARKDOWN_CLIPBOARD_MIME,
    ]
    .into_iter()
    .filter(|mime_type| {
        available_types
            .iter()
            .any(|available| available == mime_type)
    })
    .collect()
}

#[cfg(target_os = "linux")]
fn preferred_plain_fallback_mime(available_types: &[String]) -> Option<&'static str> {
    if !preferred_mime_types(available_types).is_empty()
        || preferred_file_mime(available_types).is_some()
    {
        return None;
    }
    explicit_plain_mime(available_types)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{
        GNOME_FILES_CLIPBOARD_MIME, HTML_CLIPBOARD_MIME, MARKDOWN_CLIPBOARD_MIME,
        MAX_PREFERRED_CLIPBOARD_BYTES, MEMOKA_CLIPBOARD_MIME, PLAIN_CLIPBOARD_MIME,
        PORTAL_FILE_TRANSFER_CLIPBOARD_MIME, PORTAL_FILES_CLIPBOARD_MIME, RichClipboardFormats,
        TSV_CLIPBOARD_MIME, URI_CLIPBOARD_MIME_CANDIDATES, URI_LIST_CLIPBOARD_MIME,
        UTF8_PLAIN_CLIPBOARD_MIME, decode_clipboard_bytes, explicit_plain_mime,
        explicit_requested_mime, file_uri_from_path, local_path_from_file_uri,
        parse_linux_file_clipboard, preferred_mime_types, preferred_plain_fallback_mime,
        rich_clipboard_targets, rich_file_clipboard_payloads, validate_clipboard_size,
    };

    #[test]
    fn selects_rich_table_interchange_formats_in_priority_order() {
        let available = vec![
            "text/plain;charset=utf-8".to_owned(),
            MARKDOWN_CLIPBOARD_MIME.to_owned(),
            "text/html".to_owned(),
            TSV_CLIPBOARD_MIME.to_owned(),
            MEMOKA_CLIPBOARD_MIME.to_owned(),
        ];

        assert_eq!(
            preferred_mime_types(&available),
            vec![
                MEMOKA_CLIPBOARD_MIME,
                HTML_CLIPBOARD_MIME,
                TSV_CLIPBOARD_MIME,
                MARKDOWN_CLIPBOARD_MIME,
            ]
        );
    }

    #[test]
    fn does_not_infer_markdown_from_plain_text() {
        assert!(preferred_mime_types(&["text/plain".to_owned()]).is_empty());
    }

    #[test]
    fn reads_native_plain_text_only_when_no_richer_or_file_format_exists() {
        assert_eq!(
            preferred_plain_fallback_mime(&[UTF8_PLAIN_CLIPBOARD_MIME.to_owned()]),
            Some(UTF8_PLAIN_CLIPBOARD_MIME)
        );
        assert_eq!(
            preferred_plain_fallback_mime(&[
                MARKDOWN_CLIPBOARD_MIME.to_owned(),
                PLAIN_CLIPBOARD_MIME.to_owned(),
            ]),
            None
        );
        assert_eq!(
            preferred_plain_fallback_mime(&[
                URI_LIST_CLIPBOARD_MIME.to_owned(),
                PLAIN_CLIPBOARD_MIME.to_owned(),
            ]),
            None
        );
    }

    #[test]
    fn selects_an_explicit_format_then_plain_text_fallback() {
        assert_eq!(
            explicit_requested_mime("markdown"),
            Ok(MARKDOWN_CLIPBOARD_MIME)
        );
        assert_eq!(explicit_requested_mime("html"), Ok(HTML_CLIPBOARD_MIME));
        assert!(
            explicit_requested_mime("plain")
                .unwrap_err()
                .contains("unsupported")
        );
        assert_eq!(
            explicit_plain_mime(&[
                UTF8_PLAIN_CLIPBOARD_MIME.to_owned(),
                PLAIN_CLIPBOARD_MIME.to_owned(),
            ]),
            Some(PLAIN_CLIPBOARD_MIME)
        );
        assert_eq!(
            explicit_plain_mime(&[UTF8_PLAIN_CLIPBOARD_MIME.to_owned()]),
            Some(UTF8_PLAIN_CLIPBOARD_MIME)
        );
    }

    #[test]
    fn exposes_utf8_plain_text_without_escaping_it() {
        let formats = RichClipboardFormats {
            internal: "{}".to_owned(),
            html: "<p>日本語</p>".to_owned(),
            markdown: "日本語".to_owned(),
            plain: "日本語".to_owned(),
            tsv: Some("見出し\t値".to_owned()),
        };

        let targets = rich_clipboard_targets(&formats);
        assert_eq!(
            targets
                .iter()
                .find(|(mime_type, _)| *mime_type == "text/plain")
                .map(|(_, content)| *content),
            Some("日本語")
        );
        assert_eq!(
            targets
                .iter()
                .find(|(mime_type, _)| *mime_type == TSV_CLIPBOARD_MIME)
                .map(|(_, content)| *content),
            Some("見出し\t値")
        );
        assert_eq!(
            targets
                .iter()
                .find(|(mime_type, _)| *mime_type == "text/plain;charset=utf-8")
                .map(|(_, content)| *content),
            Some("日本語")
        );
    }

    #[test]
    fn prepares_rich_and_file_targets_under_one_clipboard_owner() {
        let formats = RichClipboardFormats {
            internal: "{}".to_owned(),
            html: "<p>file</p>".to_owned(),
            markdown: "[file](attachment:id)".to_owned(),
            plain: "[file](attachment:id)".to_owned(),
            tsv: None,
        };

        let payloads = rich_file_clipboard_payloads(vec!["/tmp/file.pdf".to_owned()], &formats)
            .expect("combined Clipboard payload");
        let mime_types = payloads
            .strings
            .iter()
            .map(|(mime_type, _)| mime_type.as_str())
            .collect::<Vec<_>>();
        assert_eq!(mime_types.len(), 6);
        assert!(mime_types.contains(&MEMOKA_CLIPBOARD_MIME));
        assert!(mime_types.contains(&MARKDOWN_CLIPBOARD_MIME));
        assert!(mime_types.contains(&PLAIN_CLIPBOARD_MIME));
        assert!(mime_types.contains(&GNOME_FILES_CLIPBOARD_MIME));
        assert_eq!(payloads.uris, vec!["file:///tmp/file.pdf"]);
        assert_eq!(
            payloads
                .strings
                .iter()
                .find(|(mime_type, _)| mime_type == GNOME_FILES_CLIPBOARD_MIME)
                .map(|(_, content)| content.as_str()),
            Some("copy\nfile:///tmp/file.pdf")
        );
        assert_eq!(
            URI_CLIPBOARD_MIME_CANDIDATES,
            [
                URI_LIST_CLIPBOARD_MIME,
                PORTAL_FILE_TRANSFER_CLIPBOARD_MIME,
                PORTAL_FILES_CLIPBOARD_MIME,
            ]
        );
    }

    #[test]
    fn rejects_oversized_or_non_utf8_clipboard_payloads() {
        assert!(
            validate_clipboard_size(
                MEMOKA_CLIPBOARD_MIME,
                MAX_PREFERRED_CLIPBOARD_BYTES as usize + 1
            )
            .unwrap_err()
            .contains("exceeds")
        );
        assert!(
            decode_clipboard_bytes(MARKDOWN_CLIPBOARD_MIME, vec![0xff])
                .unwrap_err()
                .contains("not UTF-8")
        );
    }

    #[test]
    fn round_trips_local_file_uris_and_rejects_remote_uris() {
        let path = "/tmp/日本語 note.pdf";
        let uri = file_uri_from_path(path).unwrap();
        assert_eq!(uri, "file:///tmp/%E6%97%A5%E6%9C%AC%E8%AA%9E%20note.pdf");
        assert_eq!(local_path_from_file_uri(&uri).unwrap(), path);
        assert!(local_path_from_file_uri("https://example.com/a").is_err());
        assert!(local_path_from_file_uri("file://server/share/a").is_err());
    }

    #[test]
    fn parses_gnome_and_uri_list_file_clipboards() {
        assert_eq!(
            parse_linux_file_clipboard(
                GNOME_FILES_CLIPBOARD_MIME,
                "copy\nfile:///tmp/one.txt\nfile:///tmp/two.txt\n",
            )
            .unwrap(),
            vec!["/tmp/one.txt", "/tmp/two.txt"]
        );
        assert_eq!(
            parse_linux_file_clipboard(
                URI_LIST_CLIPBOARD_MIME,
                "# local files\r\nfile:///tmp/one.txt\r\n",
            )
            .unwrap(),
            vec!["/tmp/one.txt"]
        );
    }
}
