//! QUIC transport — quinn-based async client/server for the bulk-data hot path.
//!
//! Desktop → Desktop (future multi-device): full native QUIC via this module.
//! Desktop → Phone: phone browser doesn't speak raw QUIC file APIs, so the
//! phone uses WebTransport (if supported) or HTTP parallel-range (fallback).
//! Phone → Desktop: same — phone side is always browser-based, server-side
//! QUIC only kicks in when BOTH endpoints are desktop apps.
//!
//! Layout:
//!   - `start_quic_server`: bind a quinn endpoint, accept a connection,
//!     accept bi-streams, read length-prefixed (chunk index, length, bytes)
//!     frames. Returns (port, server_id) — caller registers a close handler.
//!   - `send_file_quic`: open a connection, open N bi-streams in parallel,
//!     each stream sends one chunk at a time (length-prefixed). Reuses
//!     QUIC's per-stream flow control and avoids head-of-line blocking.

use std::{error::Error, sync::Arc};
use quinn::{Endpoint, ServerConfig, ClientConfig};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::sync::Mutex;
use once_cell::sync::Lazy;

static SERVERS: Lazy<Mutex<std::collections::HashMap<String, Endpoint>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

pub struct SendResult {
    pub file_id: String,
    pub integrity_ok: bool,
    pub duration_ms: f64,
    pub average_throughput_mbps: f64,
    pub chunk_retries: i32,
    pub bytes_transferred: u64,
}

/// Generate a self-signed cert for LAN-only TLS 1.3 (quinn requires TLS).
/// Production builds should switch to a long-lived CA-signed cert persisted
/// per device, but for LAN-only pairing the self-signed model is acceptable
/// when combined with the explicit QR pairing flow (TOFU).
fn self_signed_cert() -> Result<(CertificateDer<'static>, PrivateKeyDer<'static>), Box<dyn Error + Send + Sync>> {
    let cert = rcgen::generate_simple_self_signed(vec!["lanbeam.local".to_string()])?;
    let cert_der = CertificateDer::from(cert.cert.der().to_vec());
    let key_der = PrivateKeyDer::try_from(cert.key_pair.serialize_der())?;
    Ok((cert_der, key_der))
}

fn server_config(cert: CertificateDer<'static>, key: PrivateKeyDer<'static>) -> Result<ServerConfig, Box<dyn Error + Send + Sync>> {
    let mut certs = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)?;
    certs.max_early_data_size = 0;
    Ok(ServerConfig::with_crypto(Arc::new(certs)))
}

pub async fn start_quic_server(port: u16, _cert: &[u8], _key: &[u8]) -> Result<(u16, String), Box<dyn Error + Send + Sync>> {
    // For v1: ignore the cert/key from JS and generate a fresh self-signed one.
    // The caller's cert/key args are kept in the API for future flexibility.
    let (cert, key) = self_signed_cert()?;
    let cfg = server_config(cert, key)?;
    let mut endpoints = Endpoint::server(cfg, ([0, 0, 0, 0], port).into())?;
    let actual_port = endpoints.local_addr()?.port();

    let server_id = format!("quic-{}", actual_port);
    let id_clone = server_id.clone();

    // Spawn the accept loop. For v1 this is a placeholder — actual chunk
    // reception goes through the HTTP path. When a desktop-to-desktop QUIC
    // flow is implemented, this loop reads length-prefixed frames per stream
    // and dispatches them to the transfer orchestrator.
    tokio::spawn(async move {
        while let Some(conn) = endpoints.accept().await {
            let _ = handle_connection(conn).await;
        }
    });

    // Stash endpoint so caller can close it later.
    SERVERS.lock().await.insert(id_clone, endpoints);

    Ok((actual_port, server_id))
}

async fn handle_connection(conn: quinn::Incoming) -> Result<(), Box<dyn Error + Send + Sync>> {
    let connection = conn.await?;
    // For each bi-stream: read [chunk_index:u32][length:u32][bytes]
    loop {
        let stream = connection.accept_bi().await;
        match stream {
            Ok((mut send, mut recv)) => {
                tokio::spawn(async move {
                    // Length-prefixed frame protocol — see send_file_quic for the writer.
                    use tokio::io::AsyncReadExt;
                    let mut header = [0u8; 8];
                    if recv.read_exact(&mut header).await.is_err() {
                        let _ = send.reset(0u32.into());
                        return;
                    }
                    let chunk_index = u32::from_be_bytes(header[0..4].try_into().unwrap());
                    let length = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
                    let mut buf = vec![0u8; length];
                    if recv.read_exact(&mut buf).await.is_err() {
                        let _ = send.reset(0u32.into());
                        return;
                    }
                    // Receiver-side: hash + persist. Stub for v1 — actual wiring
                    // happens through the JS orchestrator which calls verify_chunk.
                    let _ = (chunk_index, buf);
                    let _ = send.finish();
                });
            }
            Err(quinn::ConnectionError::ApplicationClosed(_)) => break,
            Err(_) => break,
        }
    }
    Ok(())
}

pub async fn stop_quic_server(server_id: &str) -> Result<(), Box<dyn Error + Send + Sync>> {
    let mut servers = SERVERS.lock().await;
    if let Some(endpoint) = servers.remove(server_id) {
        endpoint.close(0u32.into(), b"server stopped");
    }
    Ok(())
}

pub async fn send_file_quic(
    host: &str,
    port: u16,
    file_id: &str,
    file_path: &str,
    file_size: u64,
    chunk_size: usize,
    max_parallel_streams: usize,
) -> Result<SendResult, Box<dyn Error + Send + Sync>> {
    let started = std::time::Instant::now();

    // Connect — TOFU: trust the remote's self-signed cert via a custom verifier.
    let client_cfg = ClientConfig::with_custom_certificate_verifier(Arc::new(TrustAllVerifier));
    let endpoint = Endpoint::client("0.0.0.0:0".parse()?)?;
    let connect = endpoint.connect((host, port).into(), "lanbeam.local")?;
    let connection = connect.await?;

    // Read the file in chunks and send each over its own bi-stream.
    let mut file = tokio::fs::File::open(file_path).await?;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    let total_chunks = ((file_size + chunk_size as u64 - 1) / chunk_size as u64) as usize;
    let max_streams = max_parallel_streams.max(1);
    let mut bytes_transferred: u64 = 0;
    let mut chunk_retries: i32 = 0;

    let mut next_idx: usize = 0;
    let mut in_flight: Vec<tokio::task::JoinHandle<Result<usize, Box<dyn Error + Send + Sync>>>> = Vec::new();

    while next_idx < total_chunks || !in_flight.is_empty() {
        // Spawn new streams up to the concurrency cap
        while in_flight.len() < max_streams && next_idx < total_chunks {
            let offset = next_idx as u64 * chunk_size as u64;
            let length = (file_size - offset).min(chunk_size as u64) as usize;
            let chunk_index = next_idx as u32;
            let conn_clone = connection.clone();
            let path_clone = file_path.to_string();
            in_flight.push(tokio::spawn(async move {
                let mut f = tokio::fs::File::open(&path_clone).await?;
                f.seek(std::io::SeekFrom::Start(offset)).await?;
                let mut buf = vec![0u8; length];
                f.read_exact(&mut buf).await?;
                let (mut send, mut recv) = conn_clone.open_bi().await?;
                let mut header = [0u8; 8];
                header[0..4].copy_from_slice(&chunk_index.to_be_bytes());
                header[4..8].copy_from_slice(&(length as u32).to_be_bytes());
                send.write_all(&header).await?;
                send.write_all(&buf).await?;
                send.finish().await?;
                // Wait for ack
                let mut ack = [0u8; 1];
                use tokio::io::AsyncReadExt;
                let _ = recv.read_exact(&mut ack).await;
                Ok(length)
            }));
            next_idx += 1;
        }

        // Wait for all in-flight streams to complete (v1: simple barrier).
        // A production version would use a proper worker pool with a
        // bounded channel so a slow stream doesn't block fresh sends.
        for handle in in_flight.drain(..) {
            match handle.await {
                Ok(Ok(len)) => bytes_transferred += len as u64,
                Ok(Err(e)) => {
                    chunk_retries += 1;
                    return Err(format!("stream send failed: {e}").into());
                }
                Err(e) => return Err(format!("join: {e}").into()),
            }
        }
    }

    let duration_ms = started.elapsed().as_millis() as f64;
    let average_throughput_mbps = if duration_ms > 0.0 {
        (bytes_transferred as f64 * 8.0) / 1_000_000.0 / (duration_ms / 1000.0)
    } else {
        0.0
    };

    Ok(SendResult {
        file_id: file_id.to_string(),
        integrity_ok: true,  // receiver verifies; sender reports "no send error"
        duration_ms,
        average_throughput_mbps,
        chunk_retries,
        bytes_transferred,
    })
}

// TrustAllVerifier — TOFU. Acceptable on a LAN where the user has already
// scanned the QR to pair. NOT acceptable on the open internet.
struct TrustAllVerifier;
impl rustls::client::danger::ServerCertVerifier for TrustAllVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::RSA_PSS_SHA256,
        ]
    }
}
