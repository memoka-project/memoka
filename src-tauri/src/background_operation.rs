//! A cancellation token belongs to one complete operation, not to a phase.
use crate::{
    document_model::ReadError,
    restic::{self, Cancellation},
};
use std::{
    collections::BTreeMap,
    sync::{Mutex, atomic::Ordering},
};

#[derive(Default)]
pub struct Operations(Mutex<State>);
#[derive(Default)]
struct State {
    paused: bool,
    next: u64,
    active: BTreeMap<u64, Cancellation>,
}
pub struct Operation<'a> {
    owner: &'a Operations,
    id: u64,
    pub cancel: Cancellation,
}
fn busy() -> ReadError {
    ReadError::new(
        "BACKUP_BUSY",
        "Background operations are stopping; retry after cancellation completes",
    )
}
impl Operations {
    pub fn begin(&self) -> Result<Operation<'_>, ReadError> {
        let mut state = self.0.lock().map_err(|_| busy())?;
        if state.paused {
            return Err(ReadError::new(
                "CANCELLED",
                "Background operations are paused",
            ));
        }
        let id = state.next;
        state.next = state.next.wrapping_add(1);
        let cancel = restic::cancellation();
        state.active.insert(id, cancel.clone());
        Ok(Operation {
            owner: self,
            id,
            cancel,
        })
    }
    pub fn cancel(&self) -> Result<(), ReadError> {
        let mut state = self.0.lock().map_err(|_| busy())?;
        state.paused = true;
        for cancel in state.active.values() {
            cancel.store(true, Ordering::Release);
        }
        Ok(())
    }
    pub fn resume(&self) -> Result<(), ReadError> {
        let mut state = self.0.lock().map_err(|_| busy())?;
        if state.paused && !state.active.is_empty() {
            return Err(busy());
        }
        state.paused = false;
        Ok(())
    }
    pub fn running(&self) -> bool {
        self.0.lock().map_or(true, |state| !state.active.is_empty())
    }
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.owner.0.lock() {
            state.active.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_survives_phase_changes_and_rejects_late_requests() {
        let operations = Operations::default();
        let capture = operations.begin().unwrap();
        let preview = operations.begin().unwrap();
        operations.cancel().unwrap();
        assert!(capture.cancel.load(Ordering::Acquire));
        assert!(preview.cancel.load(Ordering::Acquire));
        assert!(operations.begin().is_err());
        assert!(operations.resume().is_err());
        drop(preview);
        assert!(operations.running());
        let old_token = capture.cancel.clone();
        drop(capture);
        assert!(!operations.running());
        assert!(operations.begin().is_err());
        operations.resume().unwrap();
        let retry = operations.begin().unwrap();
        assert!(!retry.cancel.load(Ordering::Acquire));
        assert!(old_token.load(Ordering::Acquire));
    }
}
