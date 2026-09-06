//! Deadline-aware overlapped I/O for interprocess's Windows pipe handles.
//!
//! Submit the read even before bytes are buffered: a large pending write may
//! require that read to make progress, so PeekNamedPipe is not a readiness API.
//! Interprocess owns the handles, peer authentication and close/flush behavior.
use interprocess::local_socket::Stream;
use std::{
    io,
    os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{ERROR_IO_PENDING, ERROR_PIPE_NOT_CONNECTED, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Storage::FileSystem::{ReadFile, WriteFile},
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Threading::{CreateEventW, WaitForSingleObject},
    },
};

fn transfer(
    stream: &Stream,
    deadline: Instant,
    start: impl FnOnce(HANDLE, *mut OVERLAPPED, *mut u32) -> i32,
) -> io::Result<usize> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
    let timeout = remaining
        .as_nanos()
        .div_ceil(1_000_000)
        .min(u128::from(u32::MAX - 1)) as u32;
    let Stream::NamedPipe(pipe) = stream;
    let handle = pipe.as_handle().as_raw_handle();
    // interprocess 2.4.2 creates both endpoints with FILE_FLAG_OVERLAPPED.
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    let event = unsafe { OwnedHandle::from_raw_handle(event) };
    let mut overlapped = OVERLAPPED {
        hEvent: event.as_raw_handle(),
        ..unsafe { std::mem::zeroed() }
    };
    let mut count = 0;
    if start(handle, &mut overlapped, &mut count) != 0 {
        return Ok(count as usize);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
        return disconnected_or(error);
    }
    match unsafe { WaitForSingleObject(event.as_raw_handle(), timeout) } {
        WAIT_OBJECT_0 => {
            if unsafe { GetOverlappedResult(handle, &overlapped, &mut count, 0) } != 0 {
                Ok(count as usize)
            } else {
                disconnected_or(io::Error::last_os_error())
            }
        }
        result => {
            let error = if result == WAIT_TIMEOUT {
                io::Error::from(io::ErrorKind::TimedOut)
            } else {
                io::Error::last_os_error()
            };
            // Cancellation is asynchronous. Reap this exact operation before
            // its OVERLAPPED, event or borrowed data buffer leaves scope.
            unsafe {
                CancelIoEx(handle, &overlapped);
                GetOverlappedResult(handle, &overlapped, &mut count, 1);
            }
            Err(error)
        }
    }
}

fn disconnected_or(error: io::Error) -> io::Result<usize> {
    if error.kind() == io::ErrorKind::BrokenPipe
        || error.raw_os_error() == Some(ERROR_PIPE_NOT_CONNECTED as i32)
    {
        Ok(0)
    } else {
        Err(error)
    }
}

pub(super) fn read(stream: &Stream, bytes: &mut [u8], deadline: Instant) -> io::Result<usize> {
    transfer(stream, deadline, |handle, overlapped, count| unsafe {
        ReadFile(
            handle,
            bytes.as_mut_ptr(),
            bytes.len().min(u32::MAX as usize) as u32,
            count,
            overlapped,
        )
    })
}

pub(super) fn write(stream: &Stream, bytes: &[u8], deadline: Instant) -> io::Result<usize> {
    let result = transfer(stream, deadline, |handle, overlapped, count| unsafe {
        WriteFile(
            handle,
            bytes.as_ptr(),
            bytes.len().min(u32::MAX as usize) as u32,
            count,
            overlapped,
        )
    });
    if matches!(result, Ok(count) if count > 0) {
        let Stream::NamedPipe(pipe) = stream;
        pipe.inner().mark_dirty();
    }
    result
}
