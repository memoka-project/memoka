use super::*;

async fn endpoints() -> (DirectEndpoint, DirectEndpoint) {
    let server = DirectEndpoint::bind(
        &SigningKey::from_bytes(&[61; 32]),
        "127.0.0.1:0".parse().unwrap(),
        &[],
    )
    .await
    .unwrap();
    let client = DirectEndpoint::bind(
        &SigningKey::from_bytes(&[62; 32]),
        "127.0.0.1:0".parse().unwrap(),
        &[server.bound_address()],
    )
    .await
    .unwrap();
    (client, server)
}
async fn connect(
    client: &DirectEndpoint,
    server: &DirectEndpoint,
) -> (DirectConnection, DirectConnection) {
    let key = server.public_key();
    let addrs = [server.bound_address()];
    let (outgoing, incoming) = tokio::join!(client.connect(&key, &addrs), server.accept());
    (outgoing.unwrap(), incoming.unwrap().unwrap())
}
fn envelope(kind: FrameKind, bytes: &[u8]) -> DeliveryEnvelope {
    DeliveryEnvelope::new(
        "01a30000-0000-7000-8000-000000000001",
        "01a30000-0000-7000-8000-000000000002",
        kind,
        bytes,
        None,
    )
}

#[tokio::test]
async fn closing_an_endpoint_releases_its_port_even_with_live_connection_handles() {
    let (client, server) = endpoints().await;
    let (_outgoing, _incoming) = connect(&client, &server).await;
    let bind = server.bound_address();
    server.close().await;
    let reopened = DirectEndpoint::bind(&SigningKey::from_bytes(&[61; 32]), bind, &[])
        .await
        .unwrap();
    assert_eq!(reopened.bound_address(), bind);
    tokio::join!(client.close(), reopened.close());
}

#[tokio::test]
async fn explicit_direct_endpoints_use_only_manual_udp_and_authenticate_public_keys() {
    let (client, server) = endpoints().await;
    let (outgoing, incoming) = connect(&client, &server).await;
    assert_eq!(outgoing.public_key(), server.public_key());
    assert_eq!(incoming.public_key(), client.public_key());
    for endpoint in [&client, &server] {
        assert!(
            endpoint.endpoint.bound_sockets().is_empty(),
            "built-in IP transport must be absent"
        );
        assert_eq!(endpoint.endpoint.addr().relay_urls().count(), 0);
        assert_eq!(endpoint.endpoint.addr().ip_addrs().count(), 0);
    }
    let body = b"signed application content";
    let header = envelope(FrameKind::Batch, body);
    let reply = envelope(FrameKind::Frontier, b"received,not applied");
    let service = async {
        let mut request = incoming.accept_request().await.unwrap();
        assert_eq!(request.header, header);
        assert_eq!(request.content().await.unwrap(), body);
        request
            .reply(&reply, b"received,not applied")
            .await
            .unwrap();
    };
    let (result, ()) = tokio::join!(outgoing.request(&header, body), service);
    assert_eq!(result.unwrap(), (reply, b"received,not applied".to_vec()));
    tokio::join!(client.close(), server.close());
}

#[tokio::test]
async fn small_control_frames_complete_while_a_bulk_stream_is_backpressured() {
    let (client, server) = endpoints().await;
    let (outgoing, incoming) = connect(&client, &server).await;
    let (large_seen, seen) = tokio::sync::oneshot::channel();
    let (small_done, done) = tokio::sync::oneshot::channel();
    let large = vec![7; 8 * 1024 * 1024];
    let header = envelope(FrameKind::Checkpoint, &large);
    let large_connection = outgoing.clone();
    let bulk =
        tokio::spawn(async move { large_connection.request(&header, &large).await.unwrap() });
    let service_connection = incoming.clone();
    let service = tokio::spawn(async move {
        let mut first = service_connection.accept_request().await.unwrap();
        assert_eq!(first.header.kind, FrameKind::Checkpoint);
        large_seen.send(()).unwrap();
        // Deliberately do not consume the bulk stream's receive window yet.
        let mut second = service_connection.accept_request().await.unwrap();
        assert_eq!(second.header.kind, FrameKind::Frontier);
        assert_eq!(second.content().await.unwrap(), b"small");
        second
            .reply(&envelope(FrameKind::Frontier, b"ack"), b"ack")
            .await
            .unwrap();
        done.await.unwrap();
        assert_eq!(first.content().await.unwrap(), vec![7; 8 * 1024 * 1024]);
        first
            .reply(&envelope(FrameKind::Frontier, b"bulk ack"), b"bulk ack")
            .await
            .unwrap();
    });
    tokio::time::timeout(Duration::from_secs(5), seen)
        .await
        .unwrap()
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        outgoing.request(&envelope(FrameKind::Frontier, b"small"), b"small"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.1, b"ack");
    small_done.send(()).unwrap();
    assert_eq!(bulk.await.unwrap().1, b"bulk ack");
    service.await.unwrap();
    tokio::join!(client.close(), server.close());
}

#[tokio::test]
async fn an_unconfigured_destination_receives_no_packets() {
    let probe = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let endpoint = DirectEndpoint::bind(
        &SigningKey::from_bytes(&[63; 32]),
        "127.0.0.1:0".parse().unwrap(),
        &[],
    )
    .await
    .unwrap();
    let key = hex(&SigningKey::from_bytes(&[64; 32]).verifying_key().to_bytes());
    let addrs = [probe.local_addr().unwrap()];
    let attempt =
        tokio::time::timeout(Duration::from_millis(100), endpoint.connect(&key, &addrs)).await;
    assert!(!matches!(attempt, Ok(Ok(_))));
    let mut bytes = [0; 2048];
    assert!(
        tokio::time::timeout(Duration::from_millis(50), probe.recv_from(&mut bytes))
            .await
            .is_err()
    );
    endpoint.close().await;
}

#[tokio::test]
async fn a_wrong_pinned_key_cannot_establish_a_direct_connection() {
    let (client, server) = endpoints().await;
    let key = hex(&SigningKey::from_bytes(&[65; 32]).verifying_key().to_bytes());
    let addrs = [server.bound_address()];
    let (outgoing, _) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(2), client.connect(&key, &addrs)),
        tokio::time::timeout(Duration::from_secs(2), server.accept())
    );
    assert!(!matches!(outgoing, Ok(Ok(_))));
    tokio::join!(client.close(), server.close());
}

#[tokio::test]
async fn oversized_declarations_and_mismatched_payload_lengths_are_rejected() {
    let (client, server) = endpoints().await;
    let (outgoing, incoming) = connect(&client, &server).await;
    for oversized in [true, false] {
        let mut header = envelope(FrameKind::Batch, b"a");
        if oversized {
            header.length = MAX_BATCH_BYTES as u64 + 1;
        }
        let bytes = serde_json::to_vec(&header).unwrap();
        let writer = async {
            let (mut send, _recv) = outgoing.0.open_bi().await.unwrap();
            send.write_all(&(bytes.len() as u32).to_be_bytes())
                .await
                .unwrap();
            send.write_all(&bytes).await.unwrap();
            send.write_all(b"too long").await.unwrap();
            send.finish().unwrap();
            // Keep the stream alive until the receiver has observed its FIN.
            let _ = send.stopped().await;
        };
        let reader = async {
            let request = incoming.accept_request().await;
            if oversized {
                assert_eq!(request.err().unwrap().code, "SYNC_LIMIT");
            } else {
                assert_eq!(
                    request.unwrap().content().await.unwrap_err().code,
                    "SYNC_FRAME"
                );
            }
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(writer, reader);
        })
        .await
        .unwrap();
    }
    tokio::join!(client.close(), server.close());
}
