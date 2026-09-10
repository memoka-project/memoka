//! The iroh IP transport automatically probes peer-advertised NAT candidates.
//! This UDP transport exposes only manually supplied destinations and replies
//! to recently received packets. No IP/relay transport is installed beside it.
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    net::SocketAddr,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};

use iroh::endpoint::transports::{
    CustomEndpoint, CustomSender, CustomTransport, RecvInfo, Transmit,
};
use iroh_base::CustomAddr;
use tokio::{io::ReadBuf, net::UdpSocket};

const ADDRESS_KIND: u64 = 0x6d65_6d6f_6b61_0001;
const REPLY_WINDOW: Duration = Duration::from_secs(60);
const MAX_REPLY_ADDRESSES: usize = 256;

pub(super) fn address(value: SocketAddr) -> CustomAddr {
    CustomAddr::from_parts(ADDRESS_KIND, value.to_string().as_bytes())
}
fn socket_address(value: &CustomAddr) -> Option<SocketAddr> {
    if value.id() != ADDRESS_KIND {
        return None;
    }
    std::str::from_utf8(value.data()).ok()?.parse().ok()
}

#[derive(Debug, Default)]
pub(super) struct Destinations {
    manual: RwLock<BTreeSet<SocketAddr>>,
    replies: Mutex<BTreeMap<SocketAddr, Instant>>,
}
impl Destinations {
    pub fn set_manual(&self, addresses: impl IntoIterator<Item = SocketAddr>) {
        *self.manual.write().unwrap_or_else(|e| e.into_inner()) = addresses.into_iter().collect();
    }
    fn allow(&self, addr: SocketAddr) -> bool {
        self.manual
            .read()
            .is_ok_and(|addresses| addresses.contains(&addr))
            || self.replies.lock().is_ok_and(|addresses| {
                addresses
                    .get(&addr)
                    .is_some_and(|at| at.elapsed() < REPLY_WINDOW)
            })
    }
    fn received(&self, addr: SocketAddr) {
        if let Ok(mut replies) = self.replies.lock() {
            replies.retain(|_, at| at.elapsed() < REPLY_WINDOW);
            if replies.len() >= MAX_REPLY_ADDRESSES
                && !replies.contains_key(&addr)
                && let Some(oldest) = replies
                    .iter()
                    .min_by_key(|(_, at)| **at)
                    .map(|(addr, _)| *addr)
            {
                replies.remove(&oldest);
            }
            replies.insert(addr, Instant::now());
        }
    }
}

#[derive(Debug)]
pub(super) struct ManualUdp {
    pub bind: SocketAddr,
    pub destinations: Arc<Destinations>,
    pub bound: Arc<Mutex<Option<SocketAddr>>>,
    pub socket: Arc<SocketLifetime>,
}

/// A stopped Workspace releases its UDP port immediately, even when a QUIC
/// connection handle is retained briefly by a cancelled task or the UI.
#[derive(Debug, Default)]
pub(super) struct SocketLifetime {
    socket: Mutex<Option<UdpSocket>>,
    closed: AtomicBool,
}
impl SocketLifetime {
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut socket) = self.socket.lock() {
            socket.take();
        }
    }
}
fn closed() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "Direct UDP transport is closed",
    )
}
impl CustomTransport for ManualUdp {
    fn bind(&self) -> io::Result<Box<dyn CustomEndpoint>> {
        let mut active = self.socket.socket.lock().map_err(|_| closed())?;
        if self.socket.closed.load(Ordering::Acquire) {
            return Err(closed());
        }
        let socket = std::net::UdpSocket::bind(self.bind)?;
        socket.set_nonblocking(true)?;
        let local = socket.local_addr()?;
        *self
            .bound
            .lock()
            .map_err(|_| io::Error::other("UDP state poisoned"))? = Some(local);
        *active = Some(UdpSocket::from_std(socket)?);
        Ok(Box::new(BoundUdp {
            socket: self.socket.clone(),
            local,
            addresses: n0_watcher::Watchable::new(vec![address(local)]),
            destinations: self.destinations.clone(),
        }))
    }
}

#[derive(Debug)]
struct BoundUdp {
    socket: Arc<SocketLifetime>,
    local: SocketAddr,
    addresses: n0_watcher::Watchable<Vec<CustomAddr>>,
    destinations: Arc<Destinations>,
}
impl CustomEndpoint for BoundUdp {
    fn watch_local_addrs(&self) -> n0_watcher::Direct<Vec<CustomAddr>> {
        self.addresses.watch()
    }
    fn create_sender(&self) -> Arc<dyn CustomSender> {
        Arc::new(Sender {
            socket: self.socket.clone(),
            destinations: self.destinations.clone(),
            ipv4: self.local.is_ipv4(),
        })
    }
    fn poll_recv(
        &mut self,
        cx: &mut Context,
        bufs: &mut [io::IoSliceMut<'_>],
        metas: &mut [noq_udp::RecvMeta],
        infos: &mut [RecvInfo],
    ) -> Poll<io::Result<usize>> {
        if bufs.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let mut buffer = ReadBuf::new(&mut bufs[0]);
        let active = self.socket.socket.lock().map_err(|_| closed())?;
        let socket = active.as_ref().ok_or_else(closed)?;
        let remote = match socket.poll_recv_from(cx, &mut buffer) {
            Poll::Ready(Ok(remote)) => remote,
            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            Poll::Pending => return Poll::Pending,
        };
        self.destinations.received(remote);
        let length = buffer.filled().len();
        metas[0] = noq_udp::RecvMeta::default();
        metas[0].addr = remote;
        metas[0].len = length;
        metas[0].stride = length.max(1);
        metas[0].dst_ip = Some(self.local.ip());
        infos[0] = RecvInfo::new(address(remote), Some(address(self.local)));
        Poll::Ready(Ok(1))
    }
}

#[derive(Debug)]
struct Sender {
    socket: Arc<SocketLifetime>,
    destinations: Arc<Destinations>,
    ipv4: bool,
}
impl CustomSender for Sender {
    fn is_valid_send_addr(&self, addr: &CustomAddr) -> bool {
        socket_address(addr).is_some_and(|addr| addr.is_ipv4() == self.ipv4)
    }
    fn poll_send(
        &self,
        cx: &mut Context,
        dst: &CustomAddr,
        _src: Option<&CustomAddr>,
        transmit: &Transmit<'_>,
    ) -> Poll<io::Result<()>> {
        let Some(dst) = socket_address(dst) else {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid direct address",
            )));
        };
        if !self.destinations.allow(dst) {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Destination was not manually configured",
            )));
        }
        // max_transmit_segments defaults to one, so no partially sent batch can
        // be replayed after Poll::Pending. QUIC remains responsible for retries.
        if transmit
            .segment_size
            .is_some_and(|size| size < transmit.contents.len())
        {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "UDP segmentation is disabled",
            )));
        }
        let active = self.socket.socket.lock().map_err(|_| closed())?;
        let socket = active.as_ref().ok_or_else(closed)?;
        match socket.poll_send_to(cx, transmit.contents, dst) {
            Poll::Ready(Ok(length)) if length == transmit.contents.len() => Poll::Ready(Ok(())),
            Poll::Ready(Ok(_)) => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "Partial UDP datagram",
            ))),
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destinations_are_manual_or_bounded_replies_and_addresses_round_trip() {
        let destinations = Destinations::default();
        let first = "127.0.0.1:4000".parse().unwrap();
        let second = "[::1]:4001".parse().unwrap();
        assert_eq!(socket_address(&address(first)), Some(first));
        assert_eq!(socket_address(&address(second)), Some(second));
        assert!(socket_address(&CustomAddr::from_parts(42, b"127.0.0.1:4000")).is_none());
        assert!(!destinations.allow(first));
        destinations.set_manual([first]);
        assert!(destinations.allow(first));
        assert!(!destinations.allow(second));
        destinations.received(second);
        assert!(destinations.allow(second));
        destinations
            .replies
            .lock()
            .unwrap()
            .insert(second, Instant::now() - REPLY_WINDOW);
        assert!(!destinations.allow(second));
        for port in 1..=300 {
            destinations.received(SocketAddr::from(([127, 0, 0, 1], port)));
        }
        assert_eq!(
            destinations.replies.lock().unwrap().len(),
            MAX_REPLY_ADDRESSES
        );
    }
}
