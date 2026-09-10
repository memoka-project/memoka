//! Durable replication. Transport only delivers signed content to this inbox;
//! document publication is performed separately by the Workspace owner.
mod apply;
mod attachments;
pub mod authorization;
pub mod bridge;
mod checkpoint;
pub mod controller;
pub mod direct;
mod direct_udp;
pub mod exchange;
pub(crate) mod identity;
mod inbox;
pub mod invitation;
pub mod join;
mod journal;
pub mod owner;
pub mod protocol;
mod publication;
pub mod rpc;
mod settings;
mod signing;

pub use apply::{AppliedBatch, PreparedApplication};
pub use attachments::AttachmentTransfer;
pub use checkpoint::{PreparedCheckpoint, PreparedCheckpointExport};
pub use journal::{ReplicaConfig, ReplicaMember, ReplicationEngine, SyncStatus};

pub(crate) use journal::clear_group_state;
pub(crate) use journal::{ensure_schema, journal_local_attachments, journal_local_commit};

#[cfg(test)]
mod tests;
