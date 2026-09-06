//! One OS credential boundary shared by repository passwords and cloud keys.
use crate::document_model::ReadError;
pub(crate) trait Credentials: Send + Sync {
    fn get(&self, id: &str) -> Result<String, ReadError>;
    fn set(&self, id: &str, secret: &str) -> Result<(), ReadError>;
    fn remove(&self, id: &str);
}
pub(crate) struct OsCredentials;
fn entry(id: &str) -> Result<keyring::Entry, ReadError> {
    keyring::Entry::new("dev.memoka.desktop.backup", id).map_err(|_| credentials_error())
}
pub(crate) fn credentials_error() -> ReadError {
    ReadError::new(
        "CREDENTIALS_UNAVAILABLE",
        "The OS credential store is unavailable or locked",
    )
}
impl Credentials for OsCredentials {
    fn get(&self, id: &str) -> Result<String, ReadError> {
        entry(id)?.get_password().map_err(|_| credentials_error())
    }
    fn set(&self, id: &str, secret: &str) -> Result<(), ReadError> {
        entry(id)?
            .set_password(secret)
            .map_err(|_| credentials_error())
    }
    fn remove(&self, id: &str) {
        if let Ok(value) = entry(id) {
            let _ = value.delete_credential();
        }
    }
}
