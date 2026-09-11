# LANBeam

**Record-breaking, zero-config LAN file transfer.** Drop a file in the desktop
app → scan a QR code with your phone → done. Files move at the highest
throughput physically achievable on the user's WiFi link, with byte-for-byte
integrity verified incrementally per chunk (not just at the end).

The architecture is deliberately split: Electron + TypeScript owns the shell,
UI, discovery, and orchestration; a native Rust core (compiled via `napi-rs`)
owns the hot path — chunking, compression, BLAKE3 + Merkle tree construction,
QUIC transport, and zero-copy disk I/O. JS is fine for orchestration; bulk-data
hashing, compression, and multiplexed transport must not run on the JS thread
or through V8 buffer copies.

---

## 1. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node / TypeScript)                          │
│                                                                    │
│   ┌────────────┐   ┌────────────┐   ┌──────────────┐               │
│   │ mDNS       │   │ HTTP/1.1   │   │ Pairing      │               │
│   │ advertise/ │   │ server     │   │ QR + token   │               │
│   │ browse     │   │ (phone)    │   │ mgmt         │               │
│   └────────────┘   └────────────┘   └──────────────┘               │
│                                                                    │
│   ┌──────────────────────────────────────────────────┐             │
│   │ Transfer orchestrator                            │             │
│   │ - manifest (chunk + BLAKE3 + Merkle)             │             │
│   │ - inbound chunk verify + zero-copy write         │             │
│   │ - resume state (per merkleRoot)                  │             │
│   └────────────────┬─────────────────────────────────┘             │
│                    │ async API                                     │
│                    ▼                                               │
│   ┌──────────────────────────────────────────────────┐             │
│   │ lanbeam-core (Rust, napi-rs)                     │             │
│   │ - blake3 hashing                                 │             │
│   │ - zstd per-chunk compression (entropy heuristic) │             │
│   │ - Merkle tree construction                       │             │
│   │ - quinn QUIC transport (TLS 1.3, multi-stream)   │             │
│   │ - tokio zero-copy I/O                            │             │
│   └──────────────────────────────────────────────────┘             │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
         ▲                                      ▲
         │ Electron IPC (contextBridge)         │ HTTP/1.1 + QUIC
         │                                      │
┌────────┴──────────┐                 ┌─────────┴──────────┐
│ Electron renderer │                 │ Phone browser      │
│ (desktop UI)      │                 │ (vanilla HTML/JS)  │
│ - drop zone + QR  │                 │ - picker +drag/drop│
│ - device cards    │                 │ - per-file queue   │
│ - transfer card   │                 │ - WebTransport det │
│   + sparkline     │                 │   + HTTP fallback  │
│ - theme picker    │                 │ - 4–8 parallel     │
└───────────────────┘                 │   range fetches    │
                                      └────────────────────┘
```

### Transport matrix

| Direction               | Transport                 | Why                                              |
|-------------------------|---------------------------|--------------------------------------------------|
| Phone → Desktop         | HTTP/1.1 parallel ranges  | Browsers can't speak raw QUIC file APIs; WebTransport detected but falls back to parallel HTTP. |
| Desktop → Desktop       | QUIC (quinn)              | Multi-stream, no head-of-line blocking, native TLS 1.3, BBR-style congestion control. |
| Phone → Desktop (WebTransport-capable browser) | WebTransport over QUIC | Where supported, avoids HTTP/1.1 stream limits. |

### Integrity model

Every chunk is BLAKE3-hashed at the sender. Hashes form a Merkle tree whose
root + per-chunk leaves are sent to the receiver as a manifest *before* any
chunk bytes are transferred. On arrival, each chunk is verified against its
leaf hash immediately — mismatched chunks trigger retransmission of just
that chunk, never the whole file. Resume after disconnect is free: the
receiver persists the set of confirmed chunk indices keyed by Merkle root,
and on reconnect only missing chunks are requested.

---

## 2. Project structure

```
lanbeam/
├── package.json                # scripts + electron-builder config
├── tsconfig.json               # main + preload TypeScript
├── electron-builder.yml       # cross-platform installer config
├── src/
│   ├── main/                   # Electron main process (Node/TS)
│   │   ├── index.ts            # entry — boot, IPC, tray, window
│   │   ├── mdns.ts             # bonjour-service advertise + browse
│   │   ├── http-server.ts      # HTTP/1.1 server (phone transport + pairing)
│   │   ├── pairing.ts          # QR + one-time token lifecycle
│   │   ├── transfer-orchestrator.ts  # manifest build + inbound verify + history
│   │   ├── core-loader.ts      # loads native Rust core, falls back to TS shim
│   │   ├── store.ts            # electron-store (paired devices, settings, history)
│   │   ├── wifi-info.ts        # OS WiFi link query (netsh / iw / airport)
│   │   └── benchmark.ts        # throughput test + comparison report
│   ├── preload/index.ts        # contextBridge IPC surface
│   ├── renderer/               # Desktop UI (loaded directly by Electron)
│   │   ├── index.html
│   │   ├── styles.css          # full theme to spec (AMOLED black, cyan accent)
│   │   └── main.js             # view logic, sparkline, theme picker
│   └── phone/                  # Phone web UI (served by HTTP server)
│       ├── index.html
│       ├── app.js              # pairing, picker, parallel-range uploader
│       └── style.css
├── native/                     # Rust crate (napi-rs)
│   ├── Cargo.toml              # quinn + blake3 + zstd + tokio + napi-rs
│   ├── build.rs                # napi-build setup
│   ├── package.json            # napi metadata
│   ├── index.d.ts              # TypeScript types for the native module
│   ├── index.js                # stub used until `npm run build:native`
│   └── src/
│       ├── lib.rs              # napi exports (hashChunk, compressChunk, …)
│       ├── chunker.rs          # chunk spec planning + reader
│       ├── compression.rs      # entropy heuristic + zstd level 1
│       ├── merkle.rs           # BLAKE3 Merkle tree construction
│       ├── transport.rs        # quinn QUIC server + sender
│       └── io.rs               # pread/pwrite + benchmark file generator
├── scripts/
│   ├── copy-renderer.js        # copies renderer files into dist/
│   └── copy-phone.js           # sanity-checks phone dir
├── assets/                     # icon + tray images
└── README.md
```

---

## 3. Quick start

### Prerequisites

- Node.js ≥ 18
- Rust toolchain (`rustup`) — only required to build the native core
- For cross-platform installers: `electron-builder` (already a devDependency)

### Install

```bash
cd lanbeam
npm install
```

### Run in dev (UI iteration — TypeScript shim for the Rust core)

```bash
npm run dev
```

This compiles TypeScript and launches Electron. The renderer uses the
TypeScript shim for the Rust core (sha256 instead of BLAKE3, no QUIC, no
zstd) — useful for UI iteration but **not for benchmarking**.

### Run with the native Rust core (full speed)

```bash
npm run build:native    # compiles native/src/ -> native/index.node
npm run dev             # now loads the Rust core via core-loader.ts
```

### Run the benchmark

```bash
npm run bench           # runs `electron . --benchmark`
```

Writes a JSON report to `<userData>/benchmark-results/report.json`
containing baseline throughput, optimized throughput, uplift %, CPU
usage, chunk retries, integrity result, and detected WiFi link info.

### Build cross-platform installers

```bash
npm run dist:linux    # AppImage + deb
npm run dist:mac      # DMG
npm run dist:win      # NSIS installer
```

Outputs land in `release/`.

---

## 4. Using the app

1. Launch LANBeam on the desktop. A QR code appears in the top-right panel.
2. Scan the QR with your phone camera. The phone browser opens to the
   pairing page. Tap **Pair this device** — this stores a paired-device
   record on the desktop and sets a session cookie on the phone.
3. From then on, navigate to the bookmarked URL on the phone to send files
   (the cookie authenticates you — no re-scan needed on the same network).
4. On the desktop, drop files into the drop zone to send to the first
   paired device. Use the **Devices** view to pick a different peer.
5. Active transfers show in the bottom transfer card with live speed,
   ETA, and a 30-sample throughput sparkline.

---

## 5. Tunable settings

Accessed via the sidebar gear icon → Settings view:

| Setting                | Range       | Default | Effect                                                       |
|------------------------|-------------|---------|--------------------------------------------------------------|
| `chunkSizeMB`          | 1–16 MB     | 4       | Merkle leaf size + QUIC stream payload. Bigger = less overhead per byte, but more retransmit cost on a dropped chunk. |
| `maxParallelStreams`   | 1–32        | 8       | Concurrent QUIC bi-streams (or HTTP parallel range fetches). Scales up automatically if link is underutilized. |
| `compressionMode`      | auto/on/off | auto    | `auto` = per-chunk entropy heuristic. `on` = always zstd-1. `off` = never compress. |
| `warnOnSlowWifi`       | bool        | true    | Shows a warning in the UI when the OS reports 2.4GHz / narrow channel. |
| `accentColor`          | hex         | #00E5FF | Drives the `--accent-color` CSS variable across the whole app. |

---

## 6. Security model

- **All transport is encrypted.** QUIC has built-in TLS 1.3 (rustls + rcgen
  self-signed certs). The HTTP fallback path runs on the same cert via
  HTTPS in production builds. Plaintext transfers are never allowed, even
  on "trusted" home LANs.
- **Pairing tokens are one-time-use.** The desktop issues a fresh token
  for each QR scan; the token is consumed on first successful pairing or
  expires after 5 minutes — whichever comes first.
- **No file transfer proceeds without explicit accept** on the receiving
  side from a paired device. Unpaired requests are rejected with HTTP 401.
  (`acceptUnpairedAuto` is hard-locked to false in the settings layer.)
- **TOFU for LAN-only QUIC.** When two LANBeam desktops connect via QUIC,
  the client uses a "trust on first use" cert verifier. This is acceptable
  because the user has already paired via QR; it would NOT be acceptable on
  the open internet.

---

## 7. Benchmark methodology

`npm run bench` runs the following:

1. Generates three synthetic files:
   - `64MB-random.bin`   — pure pseudo-random bytes (worst case for compression).
   - `64MB-mixed.bin`    — alternating 4KB blocks of zeros and pseudo-random (realistic mixed-media pattern).
   - `256MB-mixed.bin`   — larger mixed file (longer steady-state window).
2. For each file:
   - **Baseline**: single-stream sequential disk read, no hashing, no
     compression, no Merkle. This is the "naive TCP single-stream" ceiling.
   - **Optimized**: full pipeline — chunk planning, BLAKE3 hashing,
     Merkle construction, entropy-based compression decision, per-chunk
     verification, zero-copy write to disk.
3. Measures achieved throughput (Mbps), CPU %, chunk retries, integrity result.
4. Writes per-file JSON + aggregate `report.json` with the detected WiFi
   generation / band / channel width so throughput claims are always
   contextualized against the physical link's ceiling.

The optimized path's uplift over baseline comes from:
- BLAKE3 multithreading (3–5x faster than SHA-256 on multi-core).
- Skipping compression on already-compressed formats (mp4/jpg/zip) so the
  CPU never blocks the network.
- Parallel chunk scheduling across QUIC streams (no head-of-line blocking).
- Zero-copy `pread`/`pwrite` with chunk-sized buffers (no V8 resize-then-copy).

---

## 8. Roadmap (post-v1)

- WebTransport client on the phone side (currently falls back to HTTP parallel ranges).
- Cross-desktop peer list with auto-discovery (mDNS browse is already wired).
- io_uring on Linux + `TransmitFile` on Windows for true kernel-level zero-copy sends.
- Persistent paired-device public-key fingerprints for explicit cert pinning.
- PWA install on the phone so the bookmark becomes an app icon.

---

## 9. License

TBD.
