#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use super::{
    ExplicitClipboardContent, HTML_CLIPBOARD_MIME, MARKDOWN_CLIPBOARD_MIME, MEMOKA_CLIPBOARD_MIME,
    PLAIN_CLIPBOARD_MIME, PreferredClipboardFormats, RichClipboardFormats,
    UTF8_PLAIN_CLIPBOARD_MIME, validate_clipboard_size,
};
use std::mem::size_of;
use std::path::Path;
use std::ptr::{copy_nonoverlapping, null_mut};
use std::slice;
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, POINT};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows_sys::Win32::System::Ole::{CF_HDROP, CF_UNICODETEXT};
use windows_sys::Win32::UI::Shell::{DROPFILES, DragQueryFileW};

const HTML_FORMAT: &str = "HTML Format";
const PREFERRED_DROP_EFFECT: &str = "Preferred DropEffect";
const DROPEFFECT_COPY: u32 = 1;
const CLIPBOARD_OPEN_ATTEMPTS: usize = 12;

struct ClipboardGuard;

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        // SAFETY: this guard is created only after OpenClipboard succeeds and
        // is unique within the current operation.
        unsafe {
            CloseClipboard();
        }
    }
}

pub(super) fn write_rich_clipboard(formats: RichClipboardFormats) -> Result<(), String> {
    let clipboard = open_clipboard()?;
    empty_clipboard()?;
    if let Err(error) = set_rich_formats(&formats) {
        // Do not expose a partial format set if a later allocation or native
        // publication fails under the same Clipboard ownership.
        let _ = empty_clipboard();
        return Err(error);
    }
    drop(clipboard);
    Ok(())
}

pub(super) fn write_rich_file_clipboard(
    paths: Vec<String>,
    formats: RichClipboardFormats,
) -> Result<(), String> {
    let drop_files = file_drop_payload(&paths)?;
    let clipboard = open_clipboard()?;
    empty_clipboard()?;
    let published = set_rich_formats(&formats)
        .and_then(|()| set_clipboard_bytes(CF_HDROP as u32, &drop_files))
        .and_then(|()| {
            set_clipboard_bytes(
                registered_format(PREFERRED_DROP_EFFECT)?,
                &DROPEFFECT_COPY.to_le_bytes(),
            )
        });
    if let Err(error) = published {
        let _ = empty_clipboard();
        return Err(error);
    }
    drop(clipboard);
    Ok(())
}

pub(super) fn read_preferred_clipboard() -> Result<Option<PreferredClipboardFormats>, String> {
    let internal_format = registered_format(MEMOKA_CLIPBOARD_MIME)?;
    let markdown_format = registered_format(MARKDOWN_CLIPBOARD_MIME)?;
    let html_format = registered_format(HTML_FORMAT)?;
    let clipboard = open_clipboard()?;
    let mut available_types = Vec::new();
    let internal = if format_available(internal_format) {
        available_types.push(MEMOKA_CLIPBOARD_MIME.to_owned());
        Some(read_utf8_format(internal_format, MEMOKA_CLIPBOARD_MIME)?)
    } else {
        None
    };
    let markdown = if format_available(markdown_format) {
        available_types.push(MARKDOWN_CLIPBOARD_MIME.to_owned());
        Some(read_utf8_format(markdown_format, MARKDOWN_CLIPBOARD_MIME)?)
    } else {
        None
    };
    if format_available(html_format) {
        available_types.push(HTML_CLIPBOARD_MIME.to_owned());
    }
    let file_paths = if format_available(CF_HDROP as u32) {
        available_types.push("CF_HDROP".to_owned());
        read_file_drop_paths()?
    } else {
        Vec::new()
    };
    let plain_available = format_available(CF_UNICODETEXT as u32);
    if plain_available {
        available_types.push(PLAIN_CLIPBOARD_MIME.to_owned());
        available_types.push(UTF8_PLAIN_CLIPBOARD_MIME.to_owned());
    }
    available_types.sort();
    let plain =
        if internal.is_none() && markdown.is_none() && file_paths.is_empty() && plain_available {
            Some(read_unicode_text()?)
        } else {
            None
        };
    drop(clipboard);

    if internal.is_none() && markdown.is_none() && plain.is_none() && file_paths.is_empty() {
        return Ok(None);
    }
    Ok(Some(PreferredClipboardFormats {
        available_types,
        internal,
        markdown,
        plain,
        file_paths,
    }))
}

pub(super) fn read_explicit_clipboard(
    format: &str,
) -> Result<Option<ExplicitClipboardContent>, String> {
    let requested = match format {
        "markdown" => (
            registered_format(MARKDOWN_CLIPBOARD_MIME)?,
            MARKDOWN_CLIPBOARD_MIME,
        ),
        "html" => (registered_format(HTML_FORMAT)?, HTML_CLIPBOARD_MIME),
        _ => return Err(format!("unsupported explicit Clipboard format: {format}")),
    };
    let clipboard = open_clipboard()?;
    let mut available_types = Vec::new();
    if format_available(registered_format(MEMOKA_CLIPBOARD_MIME)?) {
        available_types.push(MEMOKA_CLIPBOARD_MIME.to_owned());
    }
    if format_available(registered_format(MARKDOWN_CLIPBOARD_MIME)?) {
        available_types.push(MARKDOWN_CLIPBOARD_MIME.to_owned());
    }
    if format_available(registered_format(HTML_FORMAT)?) {
        available_types.push(HTML_CLIPBOARD_MIME.to_owned());
    }
    if format_available(CF_UNICODETEXT as u32) {
        available_types.push(PLAIN_CLIPBOARD_MIME.to_owned());
    }
    available_types.sort();

    let result = if format_available(requested.0) {
        let bytes = read_global_bytes(requested.0, requested.1)?;
        let content = if format == "html" {
            extract_cf_html_fragment(&bytes)?
        } else {
            decode_utf8_without_nul(bytes, requested.1)?
        };
        Some(ExplicitClipboardContent {
            available_types,
            source_mime: requested.1.to_owned(),
            content,
        })
    } else if format_available(CF_UNICODETEXT as u32) {
        Some(ExplicitClipboardContent {
            available_types,
            source_mime: PLAIN_CLIPBOARD_MIME.to_owned(),
            content: read_unicode_text()?,
        })
    } else {
        None
    };
    drop(clipboard);
    Ok(result)
}

fn set_rich_formats(formats: &RichClipboardFormats) -> Result<(), String> {
    set_clipboard_utf8(registered_format(MEMOKA_CLIPBOARD_MIME)?, &formats.internal)?;
    set_clipboard_utf8(
        registered_format(MARKDOWN_CLIPBOARD_MIME)?,
        &formats.markdown,
    )?;
    set_clipboard_utf8(registered_format(HTML_CLIPBOARD_MIME)?, &formats.html)?;
    let cf_html = build_cf_html(&formats.html)?;
    set_clipboard_bytes(registered_format(HTML_FORMAT)?, &cf_html)?;
    set_clipboard_unicode_text(&formats.plain)
}

fn open_clipboard() -> Result<ClipboardGuard, String> {
    for attempt in 0..CLIPBOARD_OPEN_ATTEMPTS {
        // SAFETY: a null owner is allowed and the process closes the clipboard
        // through ClipboardGuard before returning.
        if unsafe { OpenClipboard(null_mut()) } != 0 {
            return Ok(ClipboardGuard);
        }
        if attempt + 1 < CLIPBOARD_OPEN_ATTEMPTS {
            thread::sleep(Duration::from_millis(8));
        }
    }
    Err(format!(
        "Windows Clipboard is busy: {}",
        std::io::Error::last_os_error()
    ))
}

fn empty_clipboard() -> Result<(), String> {
    // SAFETY: caller owns the open Clipboard through ClipboardGuard.
    if unsafe { EmptyClipboard() } == 0 {
        Err(format!(
            "cannot empty Windows Clipboard: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn registered_format(name: &str) -> Result<u32, String> {
    let name = wide_nul(name)?;
    // SAFETY: name is NUL-terminated and remains alive for the call.
    let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
    if format == 0 {
        Err(format!(
            "cannot register Windows Clipboard format: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(format)
    }
}

fn format_available(format: u32) -> bool {
    // SAFETY: querying a registered or standard format has no ownership
    // requirement beyond an open clipboard.
    unsafe { IsClipboardFormatAvailable(format) != 0 }
}

fn set_clipboard_utf8(format: u32, value: &str) -> Result<(), String> {
    let mut bytes = value.as_bytes().to_vec();
    bytes.push(0);
    set_clipboard_bytes(format, &bytes)
}

fn set_clipboard_unicode_text(value: &str) -> Result<(), String> {
    let mut wide = value.encode_utf16().collect::<Vec<_>>();
    wide.push(0);
    let bytes =
        unsafe { slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * size_of::<u16>()) };
    set_clipboard_bytes(CF_UNICODETEXT as u32, bytes)
}

fn set_clipboard_bytes(format: u32, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Windows Clipboard payload cannot be empty".to_owned());
    }
    // SAFETY: GlobalAlloc returns a movable HGLOBAL suitable for
    // SetClipboardData. Ownership is transferred only after SetClipboardData
    // succeeds; all error paths free the allocation.
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) };
    if memory.is_null() {
        return Err("cannot allocate Windows Clipboard memory".to_owned());
    }
    let destination = unsafe { GlobalLock(memory) }.cast::<u8>();
    if destination.is_null() {
        unsafe {
            GlobalFree(memory);
        }
        return Err("cannot lock Windows Clipboard memory".to_owned());
    }
    unsafe {
        copy_nonoverlapping(bytes.as_ptr(), destination, bytes.len());
        GlobalUnlock(memory);
    }
    let result = unsafe { SetClipboardData(format, memory as HANDLE) };
    if result.is_null() {
        unsafe {
            GlobalFree(memory);
        }
        return Err(format!(
            "cannot publish Windows Clipboard format {format}: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn read_utf8_format(format: u32, mime_type: &str) -> Result<String, String> {
    decode_utf8_without_nul(read_global_bytes(format, mime_type)?, mime_type)
}

fn read_global_bytes(format: u32, mime_type: &str) -> Result<Vec<u8>, String> {
    let handle = unsafe { GetClipboardData(format) };
    if handle.is_null() {
        return Err(format!(
            "Windows Clipboard format {mime_type} is unavailable"
        ));
    }
    let size = unsafe { GlobalSize(handle) };
    validate_clipboard_size(mime_type, size)?;
    let source = unsafe { GlobalLock(handle) }.cast::<u8>();
    if source.is_null() {
        return Err(format!("cannot lock Windows Clipboard format {mime_type}"));
    }
    let bytes = unsafe { slice::from_raw_parts(source, size) }.to_vec();
    unsafe {
        GlobalUnlock(handle);
    }
    Ok(bytes)
}

fn decode_utf8_without_nul(mut bytes: Vec<u8>, mime_type: &str) -> Result<String, String> {
    while bytes.last() == Some(&0) {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map_err(|error| format!("Windows Clipboard MIME {mime_type} is not UTF-8: {error}"))
}

fn read_unicode_text() -> Result<String, String> {
    let bytes = read_global_bytes(CF_UNICODETEXT as u32, PLAIN_CLIPBOARD_MIME)?;
    if bytes.len() % 2 != 0 {
        return Err("Windows Unicode Clipboard has an odd byte length".to_owned());
    }
    let wide = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .take_while(|value| *value != 0)
        .collect::<Vec<_>>();
    String::from_utf16(&wide)
        .map_err(|error| format!("Windows Unicode Clipboard is invalid: {error}"))
}

fn file_drop_payload(paths: &[String]) -> Result<Vec<u8>, String> {
    if paths.is_empty() {
        return Err("file Clipboard requires at least one path".to_owned());
    }
    let mut names = Vec::<u16>::new();
    for path in paths {
        if path.contains('\0') || !Path::new(path).is_absolute() {
            return Err("file Clipboard path must be an absolute local path".to_owned());
        }
        names.extend(path.encode_utf16());
        names.push(0);
    }
    names.push(0);
    let header = DROPFILES {
        pFiles: size_of::<DROPFILES>() as u32,
        pt: POINT { x: 0, y: 0 },
        fNC: 0,
        fWide: 1,
    };
    let mut bytes = vec![0u8; size_of::<DROPFILES>() + names.len() * size_of::<u16>()];
    unsafe {
        std::ptr::write_unaligned(bytes.as_mut_ptr().cast::<DROPFILES>(), header);
        copy_nonoverlapping(
            names.as_ptr().cast::<u8>(),
            bytes.as_mut_ptr().add(size_of::<DROPFILES>()),
            names.len() * size_of::<u16>(),
        );
    }
    Ok(bytes)
}

fn read_file_drop_paths() -> Result<Vec<String>, String> {
    let handle = unsafe { GetClipboardData(CF_HDROP as u32) };
    if handle.is_null() {
        return Ok(Vec::new());
    }
    let count = unsafe { DragQueryFileW(handle, u32::MAX, null_mut(), 0) };
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let length = unsafe { DragQueryFileW(handle, index, null_mut(), 0) };
        let mut buffer = vec![0u16; length as usize + 1];
        let copied =
            unsafe { DragQueryFileW(handle, index, buffer.as_mut_ptr(), buffer.len() as u32) };
        if copied != length {
            return Err("Windows file Clipboard changed while reading".to_owned());
        }
        paths.push(
            String::from_utf16(&buffer[..length as usize]).map_err(|error| {
                format!("Windows file Clipboard path is not valid UTF-16: {error}")
            })?,
        );
    }
    Ok(paths)
}

fn build_cf_html(fragment: &str) -> Result<Vec<u8>, String> {
    const PREFIX: &str = "<html><body><!--StartFragment-->";
    const SUFFIX: &str = "<!--EndFragment--></body></html>";
    const HEADER_TEMPLATE: &str = concat!(
        "Version:0.9\r\n",
        "StartHTML:0000000000\r\n",
        "EndHTML:0000000000\r\n",
        "StartFragment:0000000000\r\n",
        "EndFragment:0000000000\r\n"
    );
    let start_html = HEADER_TEMPLATE.len();
    let start_fragment = start_html + PREFIX.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + SUFFIX.len();
    let header = format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n"
    );
    if header.len() != HEADER_TEMPLATE.len() {
        return Err("CF_HTML payload exceeds ten-digit offsets".to_owned());
    }
    let mut payload = format!("{header}{PREFIX}{fragment}{SUFFIX}").into_bytes();
    validate_clipboard_size(HTML_CLIPBOARD_MIME, payload.len())?;
    payload.push(0);
    Ok(payload)
}

fn extract_cf_html_fragment(bytes: &[u8]) -> Result<String, String> {
    let bytes = bytes.strip_suffix(&[0]).unwrap_or(bytes);
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("Windows CF_HTML is not UTF-8: {error}"))?;
    let start = cf_html_offset(text, "StartFragment:")?;
    let end = cf_html_offset(text, "EndFragment:")?;
    if start > end || end > bytes.len() {
        return Err("Windows CF_HTML fragment offsets are invalid".to_owned());
    }
    String::from_utf8(bytes[start..end].to_vec())
        .map_err(|error| format!("Windows CF_HTML fragment is not UTF-8: {error}"))
}

fn cf_html_offset(text: &str, name: &str) -> Result<usize, String> {
    let line = text
        .lines()
        .find(|line| line.starts_with(name))
        .ok_or_else(|| format!("Windows CF_HTML is missing {name}"))?;
    line[name.len()..]
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("Windows CF_HTML has an invalid {name} offset"))
}

fn wide_nul(value: &str) -> Result<Vec<u16>, String> {
    if value.contains('\0') {
        return Err("Windows string contains NUL".to_owned());
    }
    Ok(value.encode_utf16().chain([0]).collect())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::file_drop_payload;
    use super::{build_cf_html, extract_cf_html_fragment};

    #[test]
    fn cf_html_round_trips_a_unicode_fragment() {
        let payload = build_cf_html("<p>日本語</p>").unwrap();
        assert_eq!(extract_cf_html_fragment(&payload).unwrap(), "<p>日本語</p>");
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn file_drop_requires_absolute_paths_and_a_double_terminator() {
        assert!(file_drop_payload(&["relative.txt".to_owned()]).is_err());
        let payload = file_drop_payload(&[r"C:\notes\日本語.txt".to_owned()]).unwrap();
        assert_eq!(&payload[payload.len() - 4..], &[0, 0, 0, 0]);
    }
}
