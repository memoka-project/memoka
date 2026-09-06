//! One owner per canonical Workspace, shared by GUI and headless CLI. The lock
//! inode is permanent; endpoint lifetime never determines database ownership.
#[cfg(windows)]
mod windows_pipe;
use crate::{
    document_model::ReadError,
    read_service::{AttachmentRecord, ReadRequest, checked_directory, plain_file},
};
use fs2::FileExt;
use interprocess::ConnectWaitMode;
use interprocess::local_socket::{
    GenericNamespaced, ListenerNonblockingMode, ListenerOptions, Stream, prelude::*,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const MAX_REQUEST: usize = 64 * 1024;
const MAX_RESPONSE: usize = 256 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct WorkspaceLease {
    pub workspace: PathBuf,
    _file: Arc<File>,
}
impl WorkspaceLease {
    pub fn acquire(workspace: &Path) -> Result<Self, ReadError> {
        let workspace = fs::canonicalize(workspace)?;
        checked_directory(&workspace)?;
        let internal = workspace.join(".memoka");
        checked_directory(&internal)?;
        plain_file(&internal.join("data-area.json"))?;
        let path = internal.join("workspace.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = options.open(&path)?;
        let metadata = plain_file(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let opened = file.metadata()?;
            if metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o077 != 0
                || metadata.nlink() != 1
                || metadata.ino() != opened.ino()
                || metadata.dev() != opened.dev()
            {
                return Err(ReadError::new(
                    "UNSAFE_PATH",
                    "Workspace lock must be a private file owned by the current user",
                ));
            }
        }
        #[cfg(not(unix))]
        let _ = metadata;
        file.try_lock_exclusive().map_err(|error| {
            // LockFileEx reports ERROR_LOCK_VIOLATION on Windows, whose
            // ErrorKind is not WouldBlock. Use fs2's platform-specific code.
            if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
                ReadError::new(
                    "WORKSPACE_LOCKED",
                    "The Workspace is owned by another Memoka process",
                )
            } else {
                error.into()
            }
        })?;
        Ok(Self {
            workspace,
            _file: Arc::new(file),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Query {
        request: ReadRequest,
    },
    Attachment {
        id: String,
        #[serde(default)]
        include_trash: bool,
        #[serde(default)]
        generation: Option<String>,
    },
    History {
        #[serde(default)]
        id: Option<String>,
    },
    Backup {
        action: BackupAction,
    },
    Activate,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BackupAction {
    Run,
    Status,
    List,
    Copy,
    CloudTick {
        id: Option<String>,
    },
    WaitTransfers {
        #[serde(default)]
        departure_id: Option<String>,
    },
    Departure {
        active: bool,
        id: String,
    },
    IdleMaintain,
    Maintain {
        #[serde(default)]
        dry_run: bool,
    },
    Check {
        #[serde(default)]
        full: bool,
    },
}
impl Request {
    pub fn timeout(&self) -> Duration {
        match self {
            Self::Backup {
                action:
                    BackupAction::Run
                    | BackupAction::WaitTransfers { .. }
                    | BackupAction::Copy
                    | BackupAction::IdleMaintain
                    | BackupAction::Maintain { .. }
                    | BackupAction::Check { .. },
            } => Duration::from_secs(3600),
            _ => IO_TIMEOUT,
        }
    }
    pub fn needs_barrier(&self) -> bool {
        matches!(
            self,
            Self::Query {
                request: ReadRequest {
                    generation: None,
                    ..
                }
            } | Self::Attachment {
                generation: None,
                ..
            } | Self::Backup {
                action: BackupAction::Run
            }
        )
    }
}
pub enum Reply {
    Json(Value),
    Attachment {
        metadata: AttachmentRecord,
        file: File,
    },
}
#[derive(Serialize, Deserialize)]
struct Envelope {
    schema_version: u32,
    result: Option<Value>,
    error: Option<ReadError>,
    attachment: Option<AttachmentRecord>,
}
pub type Handler = Arc<dyn Fn(Request) -> Result<Reply, ReadError> + Send + Sync>;

fn endpoint(workspace: &Path) -> Result<String, ReadError> {
    let workspace = fs::canonicalize(workspace)?;
    let mut hash = Sha256::new();
    hash.update(workspace.as_os_str().as_encoded_bytes());
    hash.update(user_identity()?.as_bytes());
    Ok(format!(
        "memoka-{}",
        crate::read_service::hex(&hash.finalize())
    ))
}
#[cfg(unix)]
fn user_identity() -> Result<String, ReadError> {
    Ok(unsafe { libc::geteuid() }.to_string())
}
#[cfg(windows)]
fn user_identity() -> Result<String, ReadError> {
    windows_user_sid(None)
}

fn authenticate(stream: &Stream) -> Result<(), ReadError> {
    let peer = stream.peer_creds()?;
    #[cfg(unix)]
    let valid = peer.euid() == Some(unsafe { libc::geteuid() });
    #[cfg(windows)]
    let valid = peer
        .pid()
        .map(|pid| windows_user_sid(Some(pid)))
        .transpose()?
        .as_deref()
        == Some(user_identity()?.as_str());
    if !valid {
        return Err(ReadError::new(
            "IPC_ACCESS_DENIED",
            "Workspace IPC requires the same OS user",
        ));
    }
    Ok(())
}

pub struct Server {
    stopped: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}
impl Server {
    pub fn start(lease: WorkspaceLease, handler: Handler) -> Result<Self, ReadError> {
        let name = endpoint(&lease.workspace)?;
        let options = ListenerOptions::new().name(name.to_ns_name::<GenericNamespaced>()?);
        #[cfg(not(windows))]
        let options = options.nonblocking(ListenerNonblockingMode::Both);
        #[cfg(windows)]
        let options = {
            use interprocess::os::windows::{
                local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
            };
            let sddl =
                widestring::U16CString::from_str(format!("D:P(A;;GA;;;{})", user_identity()?))
                    .map_err(|_| {
                        ReadError::new("IPC_ACCESS_DENIED", "Cannot create private IPC permissions")
                    })?;
            options
                .nonblocking(ListenerNonblockingMode::Accept)
                .security_descriptor(SecurityDescriptor::deserialize(&sddl)?)
        };
        let listener = options.create_sync()?;
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let active = Arc::new(AtomicUsize::new(0));
        let listener = thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok(mut stream) => {
                        if let Err(error) = authenticate(&stream) {
                            #[cfg(test)]
                            eprintln!("owner IPC authenticate: {}", error.code);
                            #[cfg(not(test))]
                            let _ = error;
                            continue;
                        }
                        if active.load(Ordering::Acquire) >= 8 {
                            continue;
                        }
                        active.fetch_add(1, Ordering::AcqRel);
                        let active = active.clone();
                        let handler = handler.clone();
                        let lease = lease.clone();
                        thread::spawn(move || {
                            // The reader retains the actual database lease even while a
                            // Workspace switch is retiring the listening endpoint.
                            let _lease = lease;
                            let result = serve(&mut stream, &handler);
                            #[cfg(test)]
                            if let Err(error) = &result {
                                eprintln!("owner IPC serve: {}", error.code);
                            }
                            let _ = result;
                            active.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) => {
                        #[cfg(test)]
                        eprintln!("owner IPC accept: {:?}", error.raw_os_error());
                        #[cfg(not(test))]
                        let _ = error;
                        break;
                    }
                }
            }
        });
        Ok(Self {
            stopped,
            listener: Some(listener),
        })
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(join) = self.listener.take() {
            let _ = join.join();
        }
    }
}

fn serve(stream: &mut Stream, handler: &Handler) -> Result<(), ReadError> {
    let bytes = read_frame(stream, MAX_REQUEST, Instant::now() + IO_TIMEOUT)?;
    let request: Request = serde_json::from_slice(&bytes)?;
    let deadline = Instant::now() + request.timeout();
    let (envelope, attachment) = match handler(request) {
        Ok(Reply::Json(value)) => (
            Envelope {
                schema_version: 1,
                result: Some(value),
                error: None,
                attachment: None,
            },
            None,
        ),
        Ok(Reply::Attachment { metadata, file }) => (
            Envelope {
                schema_version: 1,
                result: None,
                error: None,
                attachment: Some(metadata),
            },
            Some(file),
        ),
        Err(error) => (
            Envelope {
                schema_version: 1,
                result: None,
                error: Some(error),
                attachment: None,
            },
            None,
        ),
    };
    write_frame(
        stream,
        &serde_json::to_vec(&envelope)?,
        MAX_RESPONSE,
        deadline,
    )?;
    if let Some(mut file) = attachment {
        let mut buffer = [0u8; 128 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            write_all(stream, &buffer[..count], deadline)?;
        }
    }
    Ok(())
}

/// No live-DB fallback on IPC errors. A caller may only retry acquire() after
/// another process exits and releases the actual OS file lock.
pub fn request(
    workspace: &Path,
    request: &Request,
    mut output: Option<&mut dyn Write>,
) -> Result<Value, ReadError> {
    let name = endpoint(workspace)?;
    let mut stream = connect_owner(&name).map_err(|_| {
        ReadError::new(
            "OWNER_UNAVAILABLE",
            "Workspace owner is starting, busy or unavailable; retry the command",
        )
    })?;
    authenticate(&stream)?;
    let deadline = Instant::now() + request.timeout();
    write_frame(
        &mut stream,
        &serde_json::to_vec(request)?,
        MAX_REQUEST,
        deadline,
    )?;
    let envelope: Envelope =
        serde_json::from_slice(&read_frame(&mut stream, MAX_RESPONSE, deadline)?)?;
    if envelope.schema_version != 1 {
        return Err(ReadError::new(
            "IPC_PROTOCOL",
            "Unsupported IPC protocol version",
        ));
    }
    if let Some(error) = envelope.error {
        return Err(error);
    }
    if let Some(metadata) = envelope.attachment {
        let writer = output
            .as_mut()
            .ok_or_else(|| ReadError::new("IPC_PROTOCOL", "Unexpected Attachment response"))?;
        let mut hasher = Sha256::new();
        let mut remaining = metadata.size;
        let mut buffer = [0u8; 128 * 1024];
        while remaining > 0 {
            let size = remaining.min(buffer.len() as u64) as usize;
            read_exact(&mut stream, &mut buffer[..size], deadline)?;
            writer.write_all(&buffer[..size])?;
            hasher.update(&buffer[..size]);
            remaining -= size as u64;
        }
        if crate::read_service::hex(&hasher.finalize()) != metadata.sha256 {
            return Err(ReadError::new(
                "ATTACHMENT_CORRUPT",
                "IPC Attachment hash mismatch",
            ));
        }
        return Ok(serde_json::to_value(metadata)?);
    }
    envelope
        .result
        .ok_or_else(|| ReadError::new("IPC_PROTOCOL", "Missing IPC result"))
}
fn connect_owner(name: &str) -> std::io::Result<Stream> {
    #[cfg(windows)]
    {
        use interprocess::os::windows::named_pipe::{
            DuplexPipeStream, local_socket, pipe_mode::Bytes,
        };
        // interprocess 2.4.2's local-socket adapter ignores ConnectOptions'
        // wait_mode on Windows. Its underlying pipe API honors the deadline.
        let pipe = DuplexPipeStream::<Bytes>::connect_by_path_with_wait_mode(
            format!(r"\\.\pipe\{name}"),
            ConnectWaitMode::Timeout(Duration::from_secs(2)),
        )?;
        // Keep PIPE_WAIT: windows_pipe submits overlapped reads/writes with a
        // cancellable deadline, rather than polling PIPE_NOWAIT/PeekNamedPipe.
        Ok(Stream::from(local_socket::Stream::from(pipe)))
    }
    #[cfg(not(windows))]
    interprocess::local_socket::ConnectOptions::new()
        .name(name.to_ns_name::<GenericNamespaced>()?)
        .wait_mode(ConnectWaitMode::Timeout(Duration::from_secs(2)))
        .nonblocking_stream(true)
        .connect_sync()
}

fn pause(deadline: Instant) -> Result<(), ReadError> {
    if Instant::now() >= deadline {
        return Err(ReadError::new(
            "IPC_TIMEOUT",
            "Workspace owner did not respond in time; the live database was not opened",
        ));
    }
    thread::sleep(Duration::from_millis(2));
    Ok(())
}
fn read_exact(
    stream: &mut Stream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), ReadError> {
    while !bytes.is_empty() {
        #[cfg(windows)]
        let result = windows_pipe::read(stream, bytes, deadline);
        #[cfg(not(windows))]
        let result = stream.read(bytes);
        match result {
            Ok(0) => {
                return Err(ReadError::new(
                    "IPC_DISCONNECTED",
                    "Workspace owner disconnected",
                ));
            }
            Ok(count) => {
                bytes = &mut bytes[count..];
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => pause(deadline)?,
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                return Err(ReadError::new(
                    "IPC_TIMEOUT",
                    "Workspace IPC read timed out",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
fn write_all(stream: &mut Stream, mut bytes: &[u8], deadline: Instant) -> Result<(), ReadError> {
    while !bytes.is_empty() {
        #[cfg(windows)]
        let result = windows_pipe::write(stream, bytes, deadline);
        #[cfg(not(windows))]
        let result = stream.write(bytes);
        match result {
            Ok(0) => {
                return Err(ReadError::new(
                    "IPC_DISCONNECTED",
                    "Workspace owner disconnected",
                ));
            }
            Ok(count) => {
                bytes = &bytes[count..];
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => pause(deadline)?,
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                return Err(ReadError::new(
                    "IPC_TIMEOUT",
                    "Workspace IPC write timed out",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
fn read_frame(stream: &mut Stream, max: usize, deadline: Instant) -> Result<Vec<u8>, ReadError> {
    let mut length = [0u8; 4];
    read_exact(stream, &mut length, deadline)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > max {
        return Err(ReadError::new(
            "IPC_TOO_LARGE",
            "IPC message exceeds the size limit",
        ));
    }
    let mut bytes = vec![0; length];
    read_exact(stream, &mut bytes, deadline)?;
    Ok(bytes)
}
fn write_frame(
    stream: &mut Stream,
    bytes: &[u8],
    max: usize,
    deadline: Instant,
) -> Result<(), ReadError> {
    if bytes.len() > max {
        return Err(ReadError::new(
            "IPC_TOO_LARGE",
            "IPC message exceeds the size limit",
        ));
    }
    write_all(stream, &(bytes.len() as u32).to_be_bytes(), deadline)?;
    write_all(stream, bytes, deadline)
}

#[cfg(windows)]
fn windows_user_sid(pid: Option<u32>) -> Result<String, ReadError> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TOKEN_QUERY, TOKEN_USER,
            TokenUser,
        },
        System::Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };
    unsafe {
        let process = if let Some(pid) = pid {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
        } else {
            GetCurrentProcess()
        };
        if process.is_null() {
            return Err(ReadError::new(
                "IPC_ACCESS_DENIED",
                "Cannot identify IPC peer",
            ));
        }
        let mut token = std::ptr::null_mut();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
        if pid.is_some() {
            CloseHandle(process);
        }
        if opened == 0 {
            return Err(ReadError::new(
                "IPC_ACCESS_DENIED",
                "Cannot identify IPC user",
            ));
        }
        let mut length = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut length);
        let mut storage = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        let read = GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr().cast(),
            length,
            &mut length,
        );
        CloseHandle(token);
        if read == 0 {
            return Err(ReadError::new(
                "IPC_ACCESS_DENIED",
                "Cannot read IPC user identity",
            ));
        }
        let user = &*storage.as_ptr().cast::<TOKEN_USER>();
        let mut sid = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
            return Err(ReadError::new(
                "IPC_ACCESS_DENIED",
                "Cannot encode IPC user identity",
            ));
        }
        let mut count = 0;
        while *sid.add(count) != 0 {
            count += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(sid, count));
        LocalFree(sid.cast());
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn idle_pipe_reaches_its_deadline_and_detects_a_real_disconnect() {
        let name = format!("memoka-ipc-test-{}", uuid::Uuid::now_v7());
        let listener = ListenerOptions::new()
            .name(name.as_str().to_ns_name::<GenericNamespaced>().unwrap())
            .nonblocking(ListenerNonblockingMode::Accept)
            .create_sync()
            .unwrap();
        let mut client = connect_owner(&name).unwrap();
        let mut server = listener.accept().unwrap();
        assert_eq!(
            read_frame(&mut client, 100, Instant::now() + Duration::from_millis(30))
                .unwrap_err()
                .code,
            "IPC_TIMEOUT"
        );
        // A timed-out read must be fully cancelled: it cannot consume a later
        // reply using an OVERLAPPED/buffer that already went out of scope.
        write_frame(
            &mut server,
            b"after timeout",
            100,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(
            read_frame(&mut client, 100, Instant::now() + Duration::from_secs(1)).unwrap(),
            b"after timeout"
        );
        drop(server);
        assert_eq!(
            read_frame(&mut client, 100, Instant::now() + Duration::from_secs(1))
                .unwrap_err()
                .code,
            "IPC_DISCONNECTED"
        );
    }
    #[cfg(windows)]
    #[test]
    fn a_full_pipe_write_is_cancelled_at_its_deadline() {
        let name = format!("memoka-ipc-test-{}", uuid::Uuid::now_v7());
        let listener = ListenerOptions::new()
            .name(name.as_str().to_ns_name::<GenericNamespaced>().unwrap())
            .nonblocking(ListenerNonblockingMode::Accept)
            .create_sync()
            .unwrap();
        let client = connect_owner(&name).unwrap();
        let mut server = listener.accept().unwrap();
        let began = Instant::now();
        let error = write_frame(
            &mut server,
            &vec![b'x'; 1024 * 1024],
            MAX_RESPONSE,
            began + Duration::from_millis(30),
        )
        .unwrap_err();
        assert_eq!(error.code, "IPC_TIMEOUT");
        assert!(began.elapsed() < Duration::from_secs(2));
        drop(client);
        drop(server);
    }
    #[test]
    fn lock_and_ipc_are_scoped_to_one_workspace() {
        let temp = tempfile::tempdir().unwrap();
        crate::data_area::prepare_data_area(temp.path()).unwrap();
        let lease = WorkspaceLease::acquire(temp.path()).unwrap();
        assert_eq!(
            WorkspaceLease::acquire(temp.path())
                .err()
                .expect("a second owner must not acquire the Workspace")
                .code,
            "WORKSPACE_LOCKED"
        );
        let server = Server::start(
            lease.clone(),
            Arc::new(|_| {
                // Force an idle-but-connected read and a response larger than
                // the pipe buffer, rather than depending on a scheduling race.
                thread::sleep(Duration::from_millis(30));
                Ok(Reply::Json(serde_json::json!({
                    "same_user":true, "payload":"x".repeat(256 * 1024)
                })))
            }),
        )
        .unwrap();
        let reply = request(temp.path(), &Request::Activate, None).unwrap();
        assert_eq!(reply["same_user"], true);
        assert_eq!(reply["payload"].as_str().unwrap().len(), 256 * 1024);
        drop(server);
        drop(lease);
        // Receiving the reply does not join its worker: that worker owns the
        // lease until its final write/cleanup returns, including on Windows.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match WorkspaceLease::acquire(temp.path()) {
                Ok(_) => break,
                Err(error) if error.code == "WORKSPACE_LOCKED" && Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("Workspace lease was not released: {error:?}"),
            }
        }
    }
    #[test]
    fn rejects_unknown_commands_and_host_paths() {
        assert!(
            serde_json::from_value::<Request>(
                serde_json::json!({"operation":"execute","command":"anything"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<Request>(
                serde_json::json!({"operation":"attachment","id":"x","output":"/tmp/host-file"})
            )
            .is_err()
        );
    }
}
