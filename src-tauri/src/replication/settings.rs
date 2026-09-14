//! Only explicit local UI actions create a group or a device credential.
use rusqlite::OptionalExtension;

use super::{
    ReplicaConfig, ReplicaMember, ReplicationEngine, authorization, identity, journal, protocol::*,
};
use crate::{credentials::Credentials, document_model::ReadError};

impl ReplicationEngine<'_> {
    pub fn configuration(&self) -> Result<Option<ReplicaConfig>, ReadError> {
        journal::config(&self.store.connection)
    }

    pub(crate) fn enable(
        &mut self,
        name: &str,
        credentials: &dyn Credentials,
    ) -> Result<ReplicaConfig, ReadError> {
        if self.configuration()?.is_some() {
            return Err(error(
                "SYNC_GROUP",
                "Workspace synchronization is already enabled",
            ));
        }
        let workspace: String = self.store.connection.query_row(
            "SELECT document_id FROM documents WHERE kind='workspace'",
            [],
            |r| r.get(0),
        )?;
        let replica: Option<String> = self
            .store
            .connection
            .query_row(
                "SELECT value FROM settings WHERE key='replica_id'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let replica = replica.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let group = uuid::Uuid::now_v7().to_string();
        let member = identity::create(credentials, &group, &replica, name)?;
        let credential = identity::credential_id(&group, &member)?;
        let config = ReplicaConfig {
            workspace_id: workspace,
            group_id: group,
            origin: member.origin.clone(),
            public_key: member.public_key.clone(),
            paused: false,
        };
        let result = (|| {
            let key = identity::load(credentials, &config.group_id, &member)?;
            let signed = authorization::genesis(&config, &member, &key)?;
            self.initialize_authenticated(&config, &digest(&signed.content), &[signed])?;
            Ok(config)
        })();
        if result.is_err() {
            credentials.remove(&credential);
        }
        result
    }

    pub fn registered_devices(&self) -> Result<Vec<ReplicaMember>, ReadError> {
        if self.configuration()?.is_none() {
            return Ok(vec![]);
        }
        self.store.connection.prepare("SELECT device_id,replica_id,public_key,name,revoked FROM sync_members ORDER BY name,device_id")?
            .query_map([], |r| Ok(ReplicaMember {
                origin: Origin { device_id: r.get(0)?, replica_id: r.get(1)? }, public_key: r.get(2)?, name: r.get(3)?, revoked: r.get(4)?,
            }))?.collect::<Result<Vec<_>,_>>().map_err(Into::into)
    }
}
