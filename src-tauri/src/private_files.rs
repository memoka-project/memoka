//! Private per-user state, never in the captured Workspace. Reject links and
//! reparse points before reading/rewriting configs and their side files.
use crate::{
    document_model::ReadError,
    read_service::{checked_directory, plain_file},
};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) fn directory(path: &Path) -> Result<(), ReadError> {
    if !path.is_absolute() {
        return Err(unsafe_path());
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => checked_directory(ancestor)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    protect(path)?;
    Ok(())
}
pub(crate) fn protect(path: &Path) -> Result<(), ReadError> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        checked_directory(path)?;
    } else {
        plain_file(path)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(unsafe_path());
        }
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if meta.is_dir() { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertStringSecurityDescriptorToSecurityDescriptorW, SE_FILE_OBJECT,
                    SetNamedSecurityInfoW,
                },
                DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl,
                PROTECTED_DACL_SECURITY_INFORMATION,
            },
        };
        // OWNER RIGHTS grants the object's owner and SYSTEM only, with no
        // inherited Everyone/Users ACEs. Tokens enter only after this succeeds.
        let sddl: Vec<u16> = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)\0"
            .encode_utf16()
            .collect();
        let mut descriptor = std::ptr::null_mut();
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(unsafe_path());
            }
            let mut present = 0;
            let mut defaulted = 0;
            let mut acl = std::ptr::null_mut();
            let read =
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted);
            let mut path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let result = if read != 0 && present != 0 {
                SetNamedSecurityInfoW(
                    path.as_mut_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    acl,
                    std::ptr::null_mut(),
                )
            } else {
                1
            };
            LocalFree(descriptor);
            if result != 0 {
                return Err(unsafe_path());
            }
        }
    }
    Ok(())
}
fn unsafe_path() -> ReadError {
    ReadError::new(
        "UNSAFE_PATH",
        "Private cloud state is not a safe owner-only file/directory",
    )
}
pub(crate) fn inspect(path: &Path) -> Result<(), ReadError> {
    checked_directory(path)?;
    for item in fs::read_dir(path)? {
        let item = item?;
        if item.file_type()?.is_dir() {
            inspect(&item.path())?;
        } else {
            plain_file(&item.path())?;
        }
        protect(&item.path())?;
    }
    Ok(())
}
pub(crate) fn atomic_json(path: &Path, value: &impl serde::Serialize) -> Result<(), ReadError> {
    let parent = path.parent().ok_or_else(unsafe_path)?;
    directory(parent)?;
    if path.exists() {
        plain_file(path)?;
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    protect(temp.path())?;
    serde_json::to_writer(temp.as_file_mut(), value)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    temp.persist(path)
        .map_err(|_| ReadError::new("CLOUD_STATE_IO", "Cannot persist cloud operation state"))?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}
#[derive(Debug)]
pub(crate) struct Lease {
    _file: File,
}
impl Drop for Lease {
    fn drop(&mut self) {
        // A concurrently spawned process can briefly inherit the open-file
        // description. Unlock explicitly so its lifetime cannot extend ours.
        let _ = fs2::FileExt::unlock(&self._file);
    }
}
impl Lease {
    pub fn acquire(path: PathBuf) -> Result<Self, ReadError> {
        directory(path.parent().ok_or_else(unsafe_path)?)?;
        if path.exists() {
            plain_file(&path)?;
        }
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(&path)?;
        protect(&path)?;
        fs2::FileExt::try_lock_exclusive(&file).map_err(|_| {
            ReadError::new(
                "BACKUP_BUSY",
                "Another process is using this cloud connection/repository",
            )
        })?;
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lease_child_probe() {
        let Some(path) = std::env::var_os("MEMOKA_TEST_CLOUD_LEASE") else {
            return;
        };
        assert_eq!(
            Lease::acquire(PathBuf::from(path)).unwrap_err().code,
            "BACKUP_BUSY"
        );
    }
    #[test]
    fn lease_excludes_other_processes_and_releases_after_drop() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("leases/test.lock");
        let lease = Lease::acquire(path.clone()).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "private_files::tests::lease_child_probe"])
            .env("MEMOKA_TEST_CLOUD_LEASE", &path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "child process could bypass the lease"
        );
        assert!(Lease::acquire(path.clone()).is_err());
        drop(lease);
        assert!(Lease::acquire(path).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn dropping_lease_unlocks_a_file_description_inherited_during_process_spawn() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("leases/spawn.lock");
        let lease = Lease::acquire(path.clone()).unwrap();
        // fork shares the open-file description until exec closes CLOEXEC
        // descriptors; dup models that interval without forking the test runner.
        let inherited = lease._file.try_clone().unwrap();
        drop(lease);
        assert!(Lease::acquire(path).is_ok());
        drop(inherited);
    }
    #[cfg(unix)]
    #[test]
    fn private_state_and_side_files_reject_links_and_are_owner_only() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("connection");
        directory(&state).unwrap();
        atomic_json(
            &state.join("metadata.json"),
            &serde_json::json!({"id":"nonsecret"}),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(state.join("metadata.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let victim = temp.path().join("victim");
        fs::write(&victim, "unchanged").unwrap();
        symlink(&victim, state.join("config.old")).unwrap();
        assert!(inspect(&state).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "unchanged");
        symlink(&state, temp.path().join("alias")).unwrap();
        assert!(directory(&temp.path().join("alias/child")).is_err());
    }
}
