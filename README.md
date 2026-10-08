# DropBridge

Dropno file transfer and ClipboardBridge text sharing in one Node process, one listening port, and one responsive tabbed UI. Both peer-to-peer engines retain their existing transfer and recovery behavior. Switching tools preserves the embedded sessions. Each tool has its own pairing code; pair both tools to use both with another device.

## Run

Requires Node.js 22 or newer.

```sh
npm install
npm start
```

Open http://localhost:3000. On your phone use http://YOUR-PC-LAN-IP:3000 on the same Wi-Fi. The default HOST is 0.0.0.0. Set HOST=127.0.0.1 to restrict access to this computer, or PORT to choose a different port.

Files and clipboard can also be opened directly at /files/ and /clipboard/. QR codes and sharing links point to the appropriate tool. Clipboard Copy requires HTTPS on phones; manual selection remains available on HTTP. An HTTPS reverse proxy must forward both /files/signal and /clipboard/signal WebSocket upgrades. PUBLIC_URL can specify the public HTTPS origin.

File bytes and clipboard text travel over WebRTC rather than being uploaded to the HTTP server. STUN_URL, ICE_SERVERS and RELAY_ONLY retain Dropno's existing configuration. See apps/dropno/README.md and apps/clipboard/README.md for storage limits, trust, reconnect behavior and browser limitations.

## Verify

```sh
npm test
```

Includes both original test suites plus combined mount, WebSocket, QR, LAN configuration and HTTP isolation checks. Physical phone and TURN testing still depend on your environment.

server.js dispatches HTTP and upgrades to two unbound app handlers; only the shared server listens. The existing application modules remain separate to preserve their protocols and pairing recovery.
