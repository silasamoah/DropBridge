# Dropno

A local-first browser file transfer app. Pair two browsers using a six-digit code, QR code or link. Select or drop files; they arrive **automatically**, without an Accept step. Each file is verified with SHA-256 before it appears in the received-files list. Click Save file to download it.

File contents, file names, checksums and progress travel over a reliable WebRTC DataChannel. The Node server handles pairing and SDP/ICE signalling, serves the interface, and generates pairing QR images. Files are never uploaded to this server. An explicitly configured TURN server may relay encrypted WebRTC traffic when direct connectivity fails.

## Run

Requires Node.js **20.19 or newer**.

```sh
cd Dropno
npm install
npm start
```

Open **http://localhost:3000** in two tabs to try it on one computer. Create a room in one, then enter its code in the other. Choose multiple files or drag them onto the page. There is no receiver approval prompt after pairing. Save completed files using their individual download links.

On two devices on the same Wi-Fi, open **http://YOUR-COMPUTER-LAN-IP:3000** on both. The server binds to all interfaces by default. Allow the port through your firewall when needed. To scan a QR code from a phone, open the computer's LAN address in the host browser first: a QR pointing to localhost points to the scanning device itself. Use HTTPS for browser disk storage and screen wake locks on a LAN; localhost is also a secure context. On plain HTTP, the bounded memory fallback still works where WebRTC is available.

PowerShell:

```powershell
$env:PORT = '3000'
$env:HOST = '0.0.0.0' # 127.0.0.1 limits access to this computer
npm start
```

If a port is occupied, Dropno prints a clear message and exits. Stop the existing instance with Ctrl+C or use `$env:PORT = '3001'; npm start`, then open **http://localhost:3001**. Restart the server and refresh both browsers after updating the app; the transfer protocol is version 2 and is incompatible with the previous Accept-based version.

## Features

- Two-browser pairing with codes, locally generated QR codes and shareable links.
- Device names, editable and remembered in each browser.
- Automatic receiving with no Accept/Decline UI. Pairing authorizes transfers from that peer; Cancel remains available.
- Multiple-file queues (up to 100 pending files), with queue removal and cancellation.
- Simultaneous sending and receiving, one active file per direction.
- Chunked, ordered transfer with a bounded window of unacknowledged bytes.
- Progress based on receiver-confirmed bytes, transfer speed and local recent-transfer history.
- Incremental SHA-256 checks; damaged or incomplete files are not offered for download.
- Disk-backed receiving through an OPFS worker where supported; bounded memory fallback elsewhere.
- Separate download links for every completed file, individual removal and Clear files.
- Automatic signalling reconnection and private-token pairing recovery.
- Automatic peer renegotiation and transfer resume from the receiver's stored offset.
- Foreground screen wake lock during transfers where supported.
- Optional STUN/TURN configuration; direct and relayed connection labels.
- Optional trusted-device records backed by persistent ECDSA device keys and a fresh mutual challenge on every connection.

## Recovery and iOS

Waiting rooms expire after 15 minutes. Once paired, disconnected browsers keep their reserved places for **10 minutes**. A 256-bit private reconnect token is kept in sessionStorage and sent only to the signalling server; it is never placed in a QR code or URL. Other browsers cannot take an offline peer's place by entering the code. Negotiation epochs prevent stale SDP/ICE messages from damaging a replacement connection.

The transfer controller survives channel replacement while the page remains alive. It retains sender File objects, receiver storage and incremental hash state. Each chunk carries a transfer ID and byte offset. The receiver acknowledges only after storing the bytes (and flushing disk writes). After reconnection, it reports its confirmed offset and the sender continues there. A completed-transfer receipt avoids retransmitting a file if the last acknowledgement was lost.

**Keep both pages visible and screens unlocked on iPhone/iPad.** iOS may suspend a background page; JavaScript cannot force transfers to run while suspended. Returning to an intact page triggers reconnect and resume. A wake lock helps prevent automatic screen sleep while visible, on HTTPS/localhost and supported browsers; it does not enable background execution and can be denied or released by the browser.

Resume requires both pages to remain alive and the server's room to remain available. Reloading or discarding a page loses active File objects, incremental hashes and unsent queues: reselect interrupted files. Completed disk-backed files and the pairing token can survive a same-tab reload. Completed memory-backed files cannot. Restarting the signalling server loses its rooms and tokens; pair again. Explicit Disconnect ends the pairing and cancels unfinished work.

Sources: [WebKit background suspension](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/), [MDN Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API), [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).

## Storage, limits and privacy

On HTTPS/localhost with working OPFS synchronous access in workers, incoming chunks stream into temporary browser-owned disk files rather than retaining the entire file in JavaScript memory. Individual files are capped at **8 GiB**, subject to available browser quota and disk space. If that API is unavailable, total retained incoming memory is limited to **512 MiB**, including completed files. Remove received files to reclaim space. Saving a file creates a user download; it does not remove Dropno's temporary copy.

Completed disk-backed files are remembered in this tab's sessionStorage and restored on reload. Abandoned partial files belonging to the tab are removed on reload. Clear files removes completed temporary copies. Browser site-data clearing or eviction can remove stored files; download anything you want to keep. Closing a tab may leave disk copies until site-data clearing, because this version does not run cross-tab/background garbage collection. SHA-256 runs incrementally with bounded working memory; the sender reads the file once to compute its expected checksum before sending it.

Rooms, tokens and signalling state live in server memory. Recent-transfer history stores only names, sizes, directions and timestamps (last 30 entries) in browser localStorage; no file bytes are in history. Pairing codes remain short-lived bearer secrets: share them only with the intended person because anyone with an unused code can join first and files arrive automatically thereafter. Device names are labels, not verified identities.

On HTTPS/localhost with WebCrypto and IndexedDB support, each browser generates a non-extractable ECDSA P-256 private key and stores it in IndexedDB. Before file transfer, the peers exchange public keys and fresh random challenges over their DataChannel, verify signatures binding both keys and challenges, then signal readiness. A forged signature prevents that channel from transferring files. Click **Trust this device** after verifying that you paired with the intended person. Trust records bind to the SHA-256 fingerprint of the public key, not the device name; returning keys are marked Trusted after a new signature check. Forget removes a trust record. Clearing browser site data resets that browser's identity. Unsupported/insecure browsers can still transfer after code pairing, but cannot be added as verified trusted devices.

Trust is an optional recognition feature, not a restriction that rejects every new device. Pairing with a new untrusted browser still authorizes automatic receiving. It does not independently authenticate the very first exchange or provide discovery/automatic pairing after room expiry; codes/QR links are still used for a new pairing.

The DataChannel encrypts traffic using WebRTC DTLS. The signalling server sees device names, room codes, network addresses and SDP/ICE information. There are no analytics, accounts, external fonts or upload endpoints. The UI never renders received names as HTML or automatically opens files. Internet deployment requires HTTPS/WSS and appropriate access controls/rate limits; this app is primarily for local use.

## Optional STUN and relay fallback

By default no external ICE service is contacted: local connections are attempted directly. An optional STUN service discovers addresses but does not relay files:

```powershell
$env:STUN_URL = 'stun:YOUR-STUN-SERVER:3478'
npm start
```

For networks where direct connections fail, supply your own TURN service:

```powershell
$env:ICE_SERVERS = '[{"urls":"stun:YOUR-STUN-SERVER:3478"},{"urls":"turn:YOUR-TURN-SERVER:3478","username":"YOUR-USERNAME","credential":"YOUR-CREDENTIAL"}]'
npm start
```

With policy `all` (default), the browser negotiates direct candidates or TURN relay as available. Set `$env:RELAY_ONLY = '1'` to force relay during your own TURN test. The UI shows whether the selected connection is direct or relayed. No TURN service is provisioned or paid for by Dropno. TURN credentials in `/config` are available to anyone who can access this app; use short-lived, limited credentials and restrict access when deploying. Never put credentials in source control. NATs, isolated guest Wi-Fi, VPNs and firewalls can still affect connectivity.

## Structure and dependencies

```text
server/index.js           HTTP assets, config, QR and startup errors
server/rooms.js           Room slots, reconnect tokens, signalling epochs
public/index.html         Pairing, queues and automatic receive interface
public/styles.css        Responsive styling
public/js/signalling.js   WebSocket reconnect and foreground checks
public/js/peer.js         WebRTC negotiation and channel lifecycle
public/js/transfer.js     Resumable v2 protocol, queues, receipts, cancellation
public/js/hash.js         Streaming SHA-256 helpers
public/js/identity.js     Persistent device keys, mutual proofs, trust records
public/js/storage.js      Storage abstraction, fallback, completed-file restore
public/js/storage-worker.js  Durable OPFS chunk writes off the UI thread
public/js/wake-lock.js    Foreground screen wake-lock lifecycle
public/js/app.js          UI and recovery orchestration
public/vendor/hashes/    Locally served noble SHA-256 modules + MIT license
test/                    Node integration/unit checks
scripts/check-browser.cjs Real-browser acceptance checks
```

Runtime dependencies: `ws`, `qrcode-generator`, `@noble/hashes`, all with no required transitive runtime dependencies. No frontend framework or build step. The selected noble browser files are checked in with their license so the frontend works directly from `public/`; run `npm run vendor:hashes` after updating the hash dependency. QR generation and hashing are local, with no third-party API calls.

Future extensions can add cross-reload partial-transfer manifests, trusted-device discovery/automatic pairing, a selectable download folder where supported, clipboard messages and longer-term transfer history. The transport/storage/controller layers are separate from the UI.

## Verify

```sh
npm test
```

Optional browser checks (keep `npm start` running in another terminal):

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

Use `$env:BROWSER_CHANNEL = 'msedge'` for installed Edge instead of downloading Chromium; set `$env:DROPNO_URL = 'http://localhost:3001'` for a different address. Browser checks need local network access and produce screenshots in `.test-artifacts/`.

Validated locally with Node and Edge: HTTP/signalling, reserved tokens and restart epochs, QR response, streaming hashes against Node SHA-256, mutual device proof verification and forged-signature rejection, persistent trusted keys, wake-lock lifecycle, automatic transfers with byte-for-byte download comparison, multi-file queues, simultaneous directions, empty files, drag-and-drop, completed-file restoration, forced mid-file reconnect/resume, intentional corruption rejection, cancellation, memory fallback/budget, disconnects and mobile layout. Real iOS suspension, separate physical devices and a real TURN relay still need testing in their intended environments.
