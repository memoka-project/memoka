//! Direct QUIC transport. Construction is explicit; neither Default nor a
//! Workspace open binds sockets. Content remains independent of this envelope.
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use ed25519_dalek::SigningKey;
use iroh::{
    Endpoint, EndpointAddr, NetReportConfig, PublicKey, RelayMode, SecretKey, TransportAddr,
    endpoint::{Connection, QuicTransportConfig, RecvStream, SendStream, VarInt, presets::Minimal},
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::{
    authorization::MAX_AUTH_BYTES,
    direct_udp::{self, Destinations, ManualUdp},
    invitation::validate_addresses,
    protocol::*,
};
use crate::document_model::ReadError;

const ALPN: &[u8] = b"memoka/sync/1";
const MAX_HEADER_BYTES: usize = 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const FRAME_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FrameKind {
    Hello,
    HelloReply,
    Join,
    JoinStatus,
    Authority,
    Frontier,
    ChangesRequest,
    CheckpointRequest,
    Batch,
    Checkpoint,
    AttachmentRequest,
    AttachmentChunk,
    Error,
}
impl FrameKind {
    fn accepts_reply(self, reply: Self) -> bool {
        if reply == Self::Error {
            return true;
        }
        match self {
            Self::Hello => reply == Self::HelloReply,
            Self::Join => reply == Self::JoinStatus,
            Self::ChangesRequest => matches!(reply, Self::Batch | Self::Frontier | Self::Authority),
            Self::CheckpointRequest => {
                matches!(reply, Self::Checkpoint | Self::Frontier | Self::Authority)
            }
            Self::AttachmentRequest => reply == Self::AttachmentChunk,
            Self::Batch | Self::Checkpoint | Self::Frontier | Self::Authority => {
                reply == Self::Frontier
            }
            _ => false,
        }
    }
    pub fn limit(self) -> usize {
        match self {
            Self::Hello | Self::HelloReply | Self::Authority => MAX_AUTH_BYTES * 2,
            Self::Batch => MAX_BATCH_BYTES,
            Self::Checkpoint => MAX_CHECKPOINT_BYTES,
            Self::AttachmentChunk => super::attachments::ATTACHMENT_CHUNK_BYTES,
            _ => 64 * 1024,
        }
    }
    fn priority(self) -> i32 {
        match self {
            Self::Checkpoint | Self::AttachmentChunk => -10,
            Self::Batch => 0,
            _ => 10,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryEnvelope {
    pub version: u32,
    pub group_id: String,
    pub workspace_id: String,
    pub kind: FrameKind,
    pub length: u64,
    pub signature: Option<String>,
}
impl DeliveryEnvelope {
    pub fn new(
        group: &str,
        workspace: &str,
        kind: FrameKind,
        content: &[u8],
        signature: Option<String>,
    ) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            group_id: group.into(),
            workspace_id: workspace.into(),
            kind,
            length: content.len() as u64,
            signature,
        }
    }
    fn validate(&self) -> Result<(), ReadError> {
        if self.version != PROTOCOL_VERSION {
            return Err(error("SYNC_SCHEMA", "Unsupported direct protocol"));
        }
        id(&self.group_id)?;
        id(&self.workspace_id)?;
        if self.length > self.kind.limit() as u64 {
            return Err(error("SYNC_LIMIT", "Direct message exceeds its limit"));
        }
        if let Some(signature) = &self.signature {
            unhex::<64>(signature)?;
        }
        Ok(())
    }
}

pub struct DirectEndpoint {
    endpoint: Endpoint,
    destinations: Arc<Destinations>,
    bound: SocketAddr,
    socket: Arc<direct_udp::SocketLifetime>,
}
impl DirectEndpoint {
    pub async fn bind(
        key: &SigningKey,
        bind: SocketAddr,
        manual: &[SocketAddr],
    ) -> Result<Self, ReadError> {
        if manual.len() > MAX_MEMBERS * 16 {
            return Err(error("SYNC_LIMIT", "Too many direct addresses"));
        }
        for chunk in manual.chunks(16) {
            validate_addresses(chunk)?;
        }
        let destinations = Arc::new(Destinations::default());
        destinations.set_manual(manual.iter().copied());
        let bound = Arc::new(Mutex::new(None));
        let socket = Arc::new(direct_udp::SocketLifetime::default());
        let secret = Zeroizing::new(key.to_bytes());
        let transport = QuicTransportConfig::builder()
            .max_concurrent_bidi_streams(VarInt::from_u32(8))
            .max_concurrent_uni_streams(VarInt::from_u32(0))
            .stream_receive_window(VarInt::from_u32(1024 * 1024))
            .receive_window(VarInt::from_u32(4 * 1024 * 1024))
            .send_window(4 * 1024 * 1024)
            .send_fairness(true)
            .send_observed_address_reports(false)
            .receive_observed_address_reports(false)
            .build();
        let endpoint = Endpoint::builder(Minimal)
            .secret_key(SecretKey::from_bytes(&secret))
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Disabled)
            .clear_relay_transports()
            .clear_ip_transports()
            .clear_address_lookup()
            .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled)
            .net_report_config(NetReportConfig::minimal())
            .transport_config(transport)
            .add_custom_transport(Arc::new(ManualUdp {
                bind,
                destinations: destinations.clone(),
                bound: bound.clone(),
                socket: socket.clone(),
            }))
            .bind()
            .await
            .map_err(|_| {
                error(
                    "SYNC_LISTEN",
                    "Cannot bind the configured direct UDP address",
                )
            })?;
        let bound = bound
            .lock()
            .map_err(|_| error("SYNC_LISTEN", "Direct UDP state is unavailable"))?
            .ok_or_else(|| error("SYNC_LISTEN", "Direct UDP socket was not created"))?;
        Ok(Self {
            endpoint,
            destinations,
            bound,
            socket,
        })
    }
    pub fn bound_address(&self) -> SocketAddr {
        self.bound
    }
    pub fn public_key(&self) -> String {
        hex(self.endpoint.id().as_bytes())
    }
    pub fn set_addresses(&self, addresses: &[SocketAddr]) -> Result<(), ReadError> {
        // A group can have multiple peers, each with up to sixteen addresses.
        if addresses.len() > MAX_MEMBERS * 16 {
            return Err(error("SYNC_LIMIT", "Too many direct addresses"));
        }
        for chunk in addresses.chunks(16) {
            validate_addresses(chunk)?;
        }
        self.destinations.set_manual(addresses.iter().copied());
        Ok(())
    }
    pub async fn connect(
        &self,
        public_key: &str,
        addresses: &[SocketAddr],
    ) -> Result<DirectConnection, ReadError> {
        validate_addresses(addresses)?;
        let key = PublicKey::from_bytes(&unhex::<32>(public_key)?)
            .map_err(|_| error("SYNC_KEY", "Invalid direct public key"))?;
        let addr = EndpointAddr::from_parts(
            key,
            addresses
                .iter()
                .copied()
                .map(direct_udp::address)
                .map(TransportAddr::Custom),
        );
        let connection = tokio::time::timeout(CONNECT_TIMEOUT, self.endpoint.connect(addr, ALPN))
            .await
            .map_err(|_| error("SYNC_TIMEOUT", "Direct connection timed out"))?
            .map_err(|_| {
                error(
                    "SYNC_CONNECT",
                    "Cannot authenticate a connection at the configured addresses",
                )
            })?;
        if connection.remote_id() != key {
            connection.close(VarInt::from_u32(1), b"identity mismatch");
            return Err(error(
                "SYNC_KEY",
                "Connected key differs from the registered key",
            ));
        }
        Ok(DirectConnection(connection))
    }
    pub async fn accept(&self) -> Result<Option<DirectConnection>, ReadError> {
        let Some(incoming) = self.endpoint.accept().await else {
            return Ok(None);
        };
        let connection = tokio::time::timeout(CONNECT_TIMEOUT, incoming)
            .await
            .map_err(|_| error("SYNC_TIMEOUT", "Direct handshake timed out"))?
            .map_err(|_| error("SYNC_CONNECT", "Direct handshake failed"))?;
        Ok(Some(DirectConnection(connection)))
    }
    pub async fn close(&self) {
        // Bound transport teardown independently of document delivery. Always
        // release the port before a following start tries to reuse it.
        let _ = tokio::time::timeout(Duration::from_secs(2), self.endpoint.close()).await;
        self.socket.close();
    }
}
impl Drop for DirectEndpoint {
    fn drop(&mut self) {
        self.socket.close();
    }
}

#[derive(Clone)]
pub struct DirectConnection(Connection);
impl DirectConnection {
    #[cfg(test)]
    pub(super) fn raw_for_test(&self) -> &Connection {
        &self.0
    }

    pub fn public_key(&self) -> String {
        hex(self.0.remote_id().as_bytes())
    }
    pub fn close(&self) {
        self.0.close(VarInt::from_u32(0), b"closed");
    }
    pub async fn request(
        &self,
        header: &DeliveryEnvelope,
        content: &[u8],
    ) -> Result<(DeliveryEnvelope, Vec<u8>), ReadError> {
        tokio::time::timeout(FRAME_TIMEOUT, async {
            let (mut send, mut recv) = self.0.open_bi().await.map_err(|_| disconnected())?;
            write_frame(&mut send, header, content).await?;
            let reply = read_header(&mut recv).await?;
            if reply.group_id != header.group_id
                || reply.workspace_id != header.workspace_id
                || !header.kind.accepts_reply(reply.kind)
            {
                return Err(error("SYNC_PROTOCOL", "Unexpected response group or kind"));
            }
            let bytes = read_payload(&mut recv, &reply).await?;
            Ok((reply, bytes))
        })
        .await
        .map_err(|_| error("SYNC_TIMEOUT", "Direct request timed out"))?
    }
    /// The owner validates the group, peer and frame kind before allocating or
    /// reading the content. An unregistered connection may only submit Join/Hello.
    pub async fn accept_request(&self) -> Result<IncomingFrame, ReadError> {
        let (send, mut recv) = self.0.accept_bi().await.map_err(|_| disconnected())?;
        let header = tokio::time::timeout(CONNECT_TIMEOUT, read_header(&mut recv))
            .await
            .map_err(|_| error("SYNC_TIMEOUT", "Direct request header timed out"))??;
        Ok(IncomingFrame { header, send, recv })
    }
}

pub struct IncomingFrame {
    pub header: DeliveryEnvelope,
    send: SendStream,
    recv: RecvStream,
}
impl IncomingFrame {
    pub async fn content(&mut self) -> Result<Vec<u8>, ReadError> {
        tokio::time::timeout(FRAME_TIMEOUT, read_payload(&mut self.recv, &self.header))
            .await
            .map_err(|_| error("SYNC_TIMEOUT", "Direct content timed out"))?
    }
    pub async fn reply(
        mut self,
        header: &DeliveryEnvelope,
        content: &[u8],
    ) -> Result<(), ReadError> {
        tokio::time::timeout(FRAME_TIMEOUT, async {
            write_frame(&mut self.send, header, content).await?;
            self.send.stopped().await.map_err(|_| disconnected())?;
            Ok(())
        })
        .await
        .map_err(|_| error("SYNC_TIMEOUT", "Direct reply timed out"))?
    }
}
async fn write_frame(
    send: &mut SendStream,
    header: &DeliveryEnvelope,
    content: &[u8],
) -> Result<(), ReadError> {
    header.validate()?;
    if header.length != content.len() as u64 {
        return Err(error("SYNC_FRAME", "Envelope length differs from content"));
    }
    let bytes = serde_json::to_vec(header)?;
    if bytes.len() > MAX_HEADER_BYTES {
        return Err(error("SYNC_LIMIT", "Direct header is too large"));
    }
    send.set_priority(header.kind.priority())
        .map_err(|_| disconnected())?;
    send.write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .map_err(|_| disconnected())?;
    send.write_all(&bytes).await.map_err(|_| disconnected())?;
    send.write_all(content).await.map_err(|_| disconnected())?;
    send.finish().map_err(|_| disconnected())?;
    Ok(())
}
async fn read_header(recv: &mut RecvStream) -> Result<DeliveryEnvelope, ReadError> {
    let mut length = [0; 4];
    recv.read_exact(&mut length)
        .await
        .map_err(|_| disconnected())?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_HEADER_BYTES {
        return Err(error("SYNC_LIMIT", "Invalid direct header length"));
    }
    let mut bytes = vec![0; length];
    recv.read_exact(&mut bytes)
        .await
        .map_err(|_| disconnected())?;
    let header: DeliveryEnvelope = decode(&bytes, MAX_HEADER_BYTES)?;
    header.validate()?;
    Ok(header)
}
async fn read_payload(
    recv: &mut RecvStream,
    header: &DeliveryEnvelope,
) -> Result<Vec<u8>, ReadError> {
    let bytes = recv
        .read_to_end(header.length as usize)
        .await
        .map_err(|_| {
            error(
                "SYNC_FRAME",
                "Direct content exceeds its declared length or was interrupted",
            )
        })?;
    if bytes.len() as u64 != header.length {
        return Err(error("SYNC_FRAME", "Incomplete direct content"));
    }
    Ok(bytes)
}
fn disconnected() -> ReadError {
    error("SYNC_DISCONNECTED", "Direct connection was interrupted")
}

#[cfg(test)]
#[path = "direct_tests.rs"]
mod tests;
