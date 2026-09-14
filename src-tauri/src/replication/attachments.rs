use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{journal::*, protocol::*};
use crate::{document_model::ReadError, persistence::CommitFault};

pub const ATTACHMENT_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentTransfer {
    pub sha256: String,
    pub size: u64,
    pub received: u64,
    pub complete: bool,
    pub error: Option<String>,
}

fn part_path(root: &Path, hash: &str) -> PathBuf {
    root.join("attachments/sync-staging")
        .join(format!("{hash}.part"))
}
fn object_path(root: &Path, hash: &str) -> PathBuf {
    root.join("attachments/objects")
        .join(&hash[..2])
        .join(&hash[2..])
}
fn transfer(
    connection: &rusqlite::Connection,
    hash: &str,
) -> Result<AttachmentTransfer, ReadError> {
    unhex::<32>(hash)?;
    connection
        .query_row(
            "SELECT size,received,complete,error FROM sync_attachment_transfers WHERE sha256=?1",
            [hash],
            |r| {
                Ok(AttachmentTransfer {
                    sha256: hash.into(),
                    size: read_size(r, 0)?,
                    received: read_size(r, 1)?,
                    complete: r.get(2)?,
                    error: r.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| {
            error(
                "SYNC_ATTACHMENT",
                "Attachment was not referenced by a received change",
            )
        })
}
fn open_file(path: &Path) -> Result<File, ReadError> {
    check_ancestors(path)?;
    crate::read_service::plain_file(path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata()?.nlink() != 1 {
            return Err(error(
                "UNSAFE_PATH",
                "Attachment staging must not be hard-linked",
            ));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
            || info.nNumberOfLinks != 1
        {
            return Err(error(
                "UNSAFE_PATH",
                "Attachment staging must be an ordinary file with one link",
            ));
        }
    }
    if !file.metadata()?.is_file() {
        return Err(error(
            "UNSAFE_PATH",
            "Attachment transfer is not a regular file",
        ));
    }
    Ok(file)
}
fn check_ancestors(path: &Path) -> Result<(), ReadError> {
    for parent in path.parent().into_iter().flat_map(Path::ancestors) {
        match fs::symlink_metadata(parent) {
            Ok(_) => crate::read_service::checked_directory(parent)?,
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {}
            Err(failure) => return Err(failure.into()),
        }
    }
    Ok(())
}
fn verify(path: &Path, hash: &str, size: u64) -> Result<(), ReadError> {
    check_ancestors(path)?;
    if crate::read_service::plain_file(path)?.len() != size
        || crate::read_service::hash_file(path)? != hash
    {
        return Err(error(
            "SYNC_ATTACHMENT_HASH",
            "Attachment size or SHA-256 does not match",
        ));
    }
    Ok(())
}

impl ReplicationEngine<'_> {
    pub fn pending_attachments(&self, limit: usize) -> Result<Vec<AttachmentTransfer>, ReadError> {
        if limit == 0 || limit > 64 {
            return Err(error("SYNC_LIMIT", "Invalid attachment queue limit"));
        }
        self.store.connection.prepare("SELECT sha256,size,received,complete,error FROM sync_attachment_transfers WHERE complete=0 ORDER BY error IS NOT NULL,size-received,sha256 LIMIT ?1")?
            .query_map([limit as i64], |r| Ok(AttachmentTransfer { sha256: r.get(0)?,size: read_size(r,1)?,received: read_size(r,2)?,complete: r.get(3)?,error: r.get(4)? }))?.collect::<Result<Vec<_>,_>>().map_err(Into::into)
    }

    pub fn begin_attachment(&mut self, hash: &str) -> Result<AttachmentTransfer, ReadError> {
        let config = required_config(&self.store.connection)?;
        if config.paused {
            return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
        }
        let mut current = transfer(&self.store.connection, hash)?;
        let object = object_path(&self.store.root, hash);
        if fs::symlink_metadata(&object).is_ok() {
            verify(&object, hash, current.size)?;
            self.store.connection.execute("UPDATE sync_attachment_transfers SET complete=1,received=size,error=NULL,active=0 WHERE sha256=?1", [hash])?;
            let part = part_path(&self.store.root, hash);
            if fs::symlink_metadata(&part).is_ok() {
                crate::read_service::plain_file(&part)?;
                fs::remove_file(&part)?;
            }
            return transfer(&self.store.connection, hash);
        }
        if current.error.is_some() {
            return Ok(current);
        }
        // A removed CAS object is retrieved again; metadata is never treated as
        // proof that the content is still present on disk.
        if current.complete {
            self.store.connection.execute(
                "UPDATE sync_attachment_transfers SET complete=0,received=0 WHERE sha256=?1",
                [hash],
            )?;
            current.received = 0;
            current.complete = false;
        }
        let reserved: i64 = self.store.connection.query_row("SELECT COALESCE(SUM(size),0) FROM sync_attachment_transfers WHERE active=1 AND complete=0 AND error IS NULL AND sha256<>?1", [hash], |r| r.get(0))?;
        if reserved.saturating_add(current.size as i64) > MAX_INBOX_BYTES as i64 {
            return Err(error("SYNC_LIMIT", "Attachment staging queue is full"));
        }
        let path = part_path(&self.store.root, hash);
        crate::private_files::directory(path.parent().unwrap())?;
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                let file = open_file(&path)?;
                if file.metadata()?.len() < current.received {
                    self.store.connection.execute("UPDATE sync_attachment_transfers SET error='MISSING_BYTES',active=0 WHERE sha256=?1", [hash])?;
                    return Err(error(
                        "SYNC_ATTACHMENT_CORRUPT",
                        "Durably acknowledged attachment bytes are missing",
                    ));
                }
                // A crash after fsync but before the offset commit can leave an
                // unacknowledged tail. Retry from the last durable offset.
                file.set_len(current.received)?;
                file.sync_all()?;
            }
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {
                if current.received != 0 {
                    self.store.connection.execute("UPDATE sync_attachment_transfers SET error='MISSING_BYTES',active=0 WHERE sha256=?1", [hash])?;
                    return Err(error(
                        "SYNC_ATTACHMENT_CORRUPT",
                        "Attachment transfer file is missing",
                    ));
                }
                let file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)?;
                crate::private_files::protect(&path)?;
                file.sync_all()?;
                crate::persistence::sync_directory(path.parent().unwrap())?;
            }
            Err(failure) => return Err(failure.into()),
        }
        self.store.connection.execute(
            "UPDATE sync_attachment_transfers SET active=1 WHERE sha256=?1",
            [hash],
        )?;
        Ok(current)
    }

    pub fn write_attachment_chunk(
        &mut self,
        hash: &str,
        offset: u64,
        bytes: &[u8],
        fault: Option<CommitFault>,
    ) -> Result<AttachmentTransfer, ReadError> {
        let current = transfer(&self.store.connection, hash)?;
        let config = required_config(&self.store.connection)?;
        if config.paused {
            return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
        }
        if bytes.is_empty()
            || bytes.len() > ATTACHMENT_CHUNK_BYTES
            || offset
                .checked_add(bytes.len() as u64)
                .is_none_or(|end| end > current.size)
        {
            return Err(error(
                "SYNC_ATTACHMENT_SIZE",
                "Invalid attachment chunk size or offset",
            ));
        }
        if current.complete || current.error.is_some() {
            return Err(error(
                "SYNC_ATTACHMENT",
                "Attachment transfer is not writable",
            ));
        }
        let mut file = open_file(&part_path(&self.store.root, hash))?;
        if offset < current.received {
            if offset + bytes.len() as u64 > current.received {
                return Err(error(
                    "SYNC_ATTACHMENT_OFFSET",
                    "Retry crosses the durable attachment frontier",
                ));
            }
            let mut previous = vec![0; bytes.len()];
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut previous)?;
            if previous != bytes {
                return Err(error(
                    "SYNC_ATTACHMENT_RETRY",
                    "Retried attachment chunk differs from its saved bytes",
                ));
            }
            return Ok(current);
        }
        if offset != current.received {
            return Err(error(
                "SYNC_ATTACHMENT_OFFSET",
                "Attachment chunks must resume at the durable offset",
            ));
        }
        if fault == Some(CommitFault::BeforeCommit) {
            return Err(error(
                "SYNC_INJECTED",
                "Interrupted before writing an attachment chunk",
            ));
        }
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if fault == Some(CommitFault::BeforeSqlCommit) {
            return Err(error("SYNC_INJECTED", "Interrupted after attachment fsync"));
        }
        self.store.connection.execute(
            "UPDATE sync_attachment_transfers SET received=?2 WHERE sha256=?1",
            params![hash, (offset + bytes.len() as u64) as i64],
        )?;
        if fault == Some(CommitFault::AfterCommitResponse) {
            return Err(error(
                "SYNC_RESPONSE_LOST",
                "Attachment chunk response was lost",
            ));
        }
        transfer(&self.store.connection, hash)
    }

    pub fn prepare_attachment_file(&self, hash: &str) -> Result<AttachmentFile, ReadError> {
        let config = required_config(&self.store.connection)?;
        if config.paused {
            return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
        }
        let current = transfer(&self.store.connection, hash)?;
        Ok(AttachmentFile {
            root: self.store.root.clone(),
            config,
            current,
        })
    }

    pub fn finish_attachment(
        &mut self,
        hash: &str,
        fault: Option<CommitFault>,
    ) -> Result<AttachmentTransfer, ReadError> {
        let prepared = self.prepare_attachment_file(hash)?;
        if prepared.current.complete {
            return self.begin_attachment(hash);
        }
        prepared.publish(fault).commit(self.store, fault)
    }

    pub fn retry_attachment(&mut self, hash: &str) -> Result<AttachmentTransfer, ReadError> {
        let current = transfer(&self.store.connection, hash)?;
        if current.error.is_none() {
            return self.begin_attachment(hash);
        }
        // Quarantined bytes are kept for diagnosis; a new transfer starts at 0.
        self.store.connection.execute(
            "UPDATE sync_attachment_transfers SET complete=0,received=0,error=NULL WHERE sha256=?1",
            [hash],
        )?;
        self.begin_attachment(hash)
    }

    pub fn attachment_chunk(
        &self,
        hash: &str,
        offset: u64,
        limit: usize,
    ) -> Result<Vec<u8>, ReadError> {
        unhex::<32>(hash)?;
        if limit == 0 || limit > ATTACHMENT_CHUNK_BYTES {
            return Err(error(
                "SYNC_LIMIT",
                "Invalid outgoing attachment chunk limit",
            ));
        }
        let size: u64 = self
            .store
            .connection
            .query_row(
                "SELECT size FROM attachments WHERE sha256=?1 LIMIT 1",
                [hash],
                |r| read_size(r, 0),
            )
            .optional()?
            .ok_or_else(|| error("SYNC_ATTACHMENT", "Unknown attachment hash"))?;
        if offset > size {
            return Err(error(
                "SYNC_ATTACHMENT_OFFSET",
                "Attachment request exceeds its size",
            ));
        }
        let path = object_path(&self.store.root, hash);
        check_ancestors(&path)?;
        if crate::read_service::plain_file(&path)?.len() != size {
            return Err(error(
                "SYNC_ATTACHMENT_SIZE",
                "Attachment size does not match its metadata",
            ));
        }
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; limit.min((size - offset) as usize)];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }
}

/// File validation and copying use a background worker. The owner receives
/// only the result and rechecks this copy and its durable transfer position.
pub struct AttachmentFile {
    root: PathBuf,
    config: ReplicaConfig,
    current: AttachmentTransfer,
}
pub struct AttachmentPublication {
    prepared: AttachmentFile,
    result: Result<(), ReadError>,
}
impl AttachmentFile {
    pub fn object_exists(&self) -> bool {
        fs::symlink_metadata(object_path(&self.root, &self.current.sha256)).is_ok()
    }
    pub fn publish(self, fault: Option<CommitFault>) -> AttachmentPublication {
        let result = self.publish_file(fault);
        AttachmentPublication {
            prepared: self,
            result,
        }
    }
    fn publish_file(&self, fault: Option<CommitFault>) -> Result<(), ReadError> {
        let current = &self.current;
        let hash = &current.sha256;
        let target = object_path(&self.root, hash);
        if fs::symlink_metadata(&target).is_ok() {
            verify(&target, hash, current.size)?;
            let part = part_path(&self.root, hash);
            if fs::symlink_metadata(&part).is_ok() {
                crate::read_service::plain_file(&part)?;
                fs::remove_file(&part)?;
            }
            return Ok(());
        }
        if current.error.is_some() || current.received != current.size {
            return Err(error(
                "SYNC_ATTACHMENT_SIZE",
                "Attachment transfer is incomplete",
            ));
        }
        let part = part_path(&self.root, hash);
        let target = object_path(&self.root, hash);
        let mut source = open_file(&part)?;
        if source.metadata()?.len() != current.size {
            return Err(error(
                "SYNC_ATTACHMENT_SIZE",
                "Attachment staging size differs from its declaration",
            ));
        }
        crate::private_files::directory(target.parent().unwrap())?;
        let mut verified = tempfile::NamedTempFile::new_in(target.parent().unwrap())?;
        let mut digest = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        let mut copied = 0_u64;
        loop {
            let length = source.read(&mut buffer)?;
            if length == 0 {
                break;
            }
            copied += length as u64;
            if copied > current.size {
                return Err(error(
                    "SYNC_ATTACHMENT_SIZE",
                    "Attachment exceeded its declared size",
                ));
            }
            digest.update(&buffer[..length]);
            verified.write_all(&buffer[..length])?;
        }
        if copied != current.size || hex(&digest.finalize()) != *hash {
            drop(source);
            let quarantine = self.root.join("attachments/sync-quarantine");
            crate::private_files::directory(&quarantine)?;
            let mut old = fs::read_dir(&quarantine)?
                .map(|item| {
                    let item = item?;
                    let metadata = crate::read_service::plain_file(&item.path())?;
                    Ok((metadata.modified()?, item.path()))
                })
                .collect::<Result<Vec<_>, ReadError>>()?;
            old.sort();
            for (_, path) in old.iter().take(old.len().saturating_sub(3)) {
                fs::remove_file(path)?;
            }
            fs::rename(
                &part,
                quarantine.join(format!("{hash}-{}.part", uuid::Uuid::now_v7())),
            )?;
            crate::persistence::sync_directory(&quarantine)?;
            return Err(error(
                "SYNC_ATTACHMENT_HASH",
                "Attachment failed final SHA-256 verification and was quarantined",
            ));
        }
        verified.as_file().sync_all()?;
        if fault == Some(CommitFault::BeforeCommit) {
            return Err(error(
                "SYNC_INJECTED",
                "Interrupted before publishing verified attachment",
            ));
        }
        match verified.persist_noclobber(&target) {
            Ok(_) => {}
            Err(failure) if failure.error.kind() == std::io::ErrorKind::AlreadyExists => {
                verify(&target, hash, current.size)?
            }
            Err(failure) => return Err(failure.error.into()),
        }
        crate::persistence::sync_directory(target.parent().unwrap())?;
        if fault == Some(CommitFault::BeforeSqlCommit) {
            return Err(error(
                "SYNC_INJECTED",
                "Interrupted after publishing the verified CAS object",
            ));
        }
        drop(source);
        fs::remove_file(&part)?;
        crate::persistence::sync_directory(part.parent().unwrap())?;
        Ok(())
    }
}
impl AttachmentPublication {
    pub fn commit(
        self,
        store: &mut crate::persistence::ProductStore,
        fault: Option<CommitFault>,
    ) -> Result<AttachmentTransfer, ReadError> {
        super::publication::check_config(store, &self.prepared.config)?;
        if store.root != self.prepared.root {
            return Err(error(
                "SYNC_WORKSPACE_CHANGED",
                "Attachment belongs to another Workspace",
            ));
        }
        let hash = &self.prepared.current.sha256;
        let current = transfer(&store.connection, hash)?;
        if current != self.prepared.current {
            return Err(error(
                "SYNC_ATTACHMENT_CHANGED",
                "Transfer changed during file verification",
            ));
        }
        if let Err(failure) = self.result {
            if failure.code == "SYNC_ATTACHMENT_HASH" {
                store.connection.execute("UPDATE sync_attachment_transfers SET error='SHA256_MISMATCH',active=0 WHERE sha256=?1", [hash])?;
            }
            return Err(failure);
        }
        store.connection.execute("UPDATE sync_attachment_transfers SET complete=1,received=size,error=NULL,active=0 WHERE sha256=?1", [hash])?;
        if fault == Some(CommitFault::AfterCommitResponse) {
            return Err(error(
                "SYNC_RESPONSE_LOST",
                "Attachment completion response was lost",
            ));
        }
        transfer(&store.connection, hash)
    }
}
