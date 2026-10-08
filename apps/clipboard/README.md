# ClipboardBridge

A local-first browser text clipboard bridge built with Node.js, WebSockets and vanilla HTML/CSS/JS. Pair two devices by room code or QR link; text travels directly over a WebRTC DataChannel. Sending and copying are manual.

## Start

Requires Node.js 22+ and npm. From this project folder:

```sh
npm install
npm start
```

Open **http://localhost:3000** in two tabs for a quick test. Create a room in one, join from the other, and wait for **Connected**. `npm run dev` watches server changes. If port 3000 is busy, stop your previous server with Ctrl+C or choose another port:

```powershell
$env:PORT = '3001'
npm start
```

Then open **http://localhost:3001**. This repository is the standalone project; copies extracted elsewhere must be replaced separately when updating. Version 0.2 changes the wire protocol: restart the server and refresh both devices together.

## Windows and a phone

The server binds to loopback by default. To reach it from another device on the same Wi-Fi:

```powershell
# Windows PowerShell
$env:HOST = '0.0.0.0'
npm start
```

```sh
# macOS / Linux
HOST=0.0.0.0 npm start
```

Create a room on the computer. The address selector suggests its available LAN IPv4 addresses. Choose your Wi-Fi address if several are listed, scan the QR with your phone camera, and tap **Join room** on the phone. A QR link fills the room code; it does not join automatically. The QR generator runs locally and never calls a QR service. You can also open `http://<computer-LAN-IP>:3000` manually and enter the code. Allow the port through your firewall on your private network if needed.

`localhost` on a phone refers to the phone itself. A loopback-only server cannot serve your phone; the page explains this if the selected QR address is localhost. Isolated guest Wi-Fi and firewalls can block local WebRTC connections. No external STUN or TURN servers are configured.

### Copying and HTTPS

Localhost is suitable for desktop clipboard testing. A phone visiting a LAN IP over HTTP needs **trusted HTTPS** for the Copy button. Until configured, select and copy received text manually; the UI selects it for you after an automatic-copy error. See [MDN Clipboard.writeText](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText).

An optional local HTTPS example is included in [docs/https-setup.md](docs/https-setup.md), with a Caddy configuration in [examples/Caddyfile](examples/Caddyfile). The proxy must forward `/signal` WebSocket upgrades. Set `PUBLIC_URL` to the HTTPS origin, for example:

```powershell
$env:PUBLIC_URL = 'https://192.168.1.50'
npm start
```

Use the real address and trust the local certificate on every device. `PUBLIC_URL` only sets the pairing address; it does not enable TLS by itself. It must be an HTTP(S) origin without a path. No certificate or proxy is installed automatically.

## Delivery and recovery

- **Sending** waits for an acknowledgement from the receiving page. **Delivered** means its page received the text; it does not mean its system clipboard was changed. Copying still requires a click.
- If an acknowledgement does not arrive within eight seconds, the UI shows **Unconfirmed** and offers **Retry previous text**. A disconnected channel also marks pending delivery unconfirmed. There is no silent resend.
- Retrying sends the same message ID and original text. The receiver suppresses duplicates among the last 256 IDs remembered in that tab, and acknowledges retries again. Your current draft stays unchanged if you edit it before retrying. Reloading clears the received-ID cache, so retries across a receiver reload can be displayed again.
- Returning to the tab creates a fresh signalling connection and WebRTC channel. Network changes and temporary server failures retry while visible, with an increasing delay capped at ten seconds. The UI shows the retry countdown, paused-peer reservation, and a **Retry connection** button.
- Ordinary reconnects retain draft and received text. A full page reload clears text, delivery state and pending retries; clipboard content is never written to browser storage or the signalling server.
- iOS can suspend background browser tabs. Continuous background transfer is not guaranteed. Return to the page and wait for **Connected** before sending. See [WebKit's background behavior](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/).

## Remembered pairing

**Remember this pairing for 24 hours** is enabled by default and can be unchecked before creating or joining. Remembered pairings save only the room code, private resume token, and absolute expiry in browser storage. The tab restores its own seat after reload; a new tab shows saved rooms with an explicit Resume button. Multiple tabs keep separate active tickets to avoid taking each other's seat on reload.

Rooms support two devices. A private resume token is required to reclaim a reserved seat; a room code alone cannot take it. Waiting rooms with only one participant expire after ten minutes. Paired remembered devices can resume until the room's absolute 24-hour expiry. If a device opted out of remembering, its disconnected seat expires after two minutes and ends the room. The UI displays the applicable reservation time.

**Forget pairing** removes local credentials and revokes the room on the server when connected; both devices must pair again. **Leave room** also ends the room and forgets this tab's saved ticket. If the server is unreachable, local forgetting still works, but the server reservation expires on its own. A server restart loses all room state and invalidates saved tickets; the UI removes them when rejected. Browser storage is scoped to the address: localhost, a LAN IP, and an HTTPS hostname have separate saved pairings. Blocked/private storage can prevent remembering; manual pairing still works.

## Structure

```text
server/index.js           HTTP assets, QR endpoints and WebSocket transport
server/room-manager.js    Pairing, reservations, expiry, tokens and negotiation
server/network.js        Reachable address suggestions
public/index.html        Accessible manual clipboard UI
public/styles.css        Responsive styling
public/js/app.js         UI and connection lifecycle
public/js/signalling.js  WebSocket client
public/js/peer.js        WebRTC and DataChannel transport
public/js/protocol.js    Versioned text/ack messages and validation
public/js/delivery.js    Confirmation, timeout and safe retry tracking
public/js/pairing.js     Expiring pairing credentials; no clipboard storage
public/js/setup.js       QR/link and phone setup UI
public/js/clipboard.js   Browser clipboard adapter
test/                    Server, room, delivery, protocol and storage tests
scripts/browser-smoke.mjs Optional browser integration checks
docs/                    HTTPS guide and physical phone test matrix
```

There are two small runtime dependencies: `ws` and the zero-dependency `qrcode-svg` generator. No build step, framework, database or hosted service is required. The room manager takes an injected transport and clock, so another client transport or native agent can reuse it.

## Tests

```sh
npm test
```

These tests cover pairing capacity, signalling, stale sessions, private-token resumption, forget/revocation, expiry, occupied ports, QR endpoint validation, message limits, delivery confirmation/loss/retry, duplicate suppression, and separate-tab remembered pairing.

### Browser checks

Playwright is optional test tooling and is not required to run the app. Install it locally without changing the project's dependency declarations:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

Or use installed Chrome in PowerShell:

```powershell
$env:BROWSER_CHANNEL = 'chrome'
npm run test:browser
```

The smoke test starts its own server on a free port and closes it afterward. It checks real peer transfer, acknowledgements, lost-confirmation retry, QR-link pairing, reload resumption, simulated lifecycle and network events, server restart, forgetting credentials, and mobile viewport layout. Set `UI_ARTIFACT_DIR` to save screenshots and a JSON report. An existing Playwright installation can be supplied with `PLAYWRIGHT_MODULE`.

For other desktop browser engines, install their Playwright binaries and set `BROWSER_ENGINE` to `webkit` or `firefox`; unset `BROWSER_CHANNEL` for those engines. These runs do not emulate an actual mobile operating system. Browser testing may need local network/UDP access for WebRTC.

Physical iPhone/Android backgrounding, lock-screen behavior, Wi-Fi handoffs, and battery restrictions still require real devices. [docs/phone-testing.md](docs/phone-testing.md) gives exact checks and a results template; these checks are explicitly marked not run.

## Limits and future native agent

Text is limited to 12,000 UTF-8 bytes; the transport also checks the browser's negotiated message size after JSON encoding. Received content is rendered as plain text. The server relays signalling only and never saves or forwards clipboard text. Retry payloads and the latest received text remain in tab memory.

A room code is a temporary pairing secret, not identity verification. Use trusted local networks and HTTPS when appropriate. Basic origin checking, request limits, payload limits, heartbeat cleanup and room capacity limits are included; this is not intended as an authenticated public service. No files/images, background clipboard polling, automatic OS clipboard sync, native desktop agent, or internet relay is implemented.

The v2 text contract is `{ "version": 2, "type": "clipboard:text", "id": "<32 hex characters>", "text": "..." }`. Receipt confirmation is `{ "version": 2, "type": "clipboard:ack", "id": "<same id>" }`. Add a separate native clipboard adapter beside `clipboard.js` and a compatible transport endpoint later. `protocol.js`, `delivery.js`, and the injected room manager can be reused without coupling OS clipboard access to the UI or signalling server.
