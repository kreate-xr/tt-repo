// DEPRECATED — superseded by Firestore-based signaling (js/network/SignalingClient.js).
// Kept in the repo for reference and as a fallback transport; the game does
// not connect to this server anymore. Safe to delete once the Firestore path
// is verified in production.
//
// Minimal WebSocket signaling relay for the WebRTC multiplayer module.
// Knows about rooms only; never inspects SDP/ICE payloads, never stores game
// state, never persists anything. Once two peers connect and exchange ICE,
// this server is out of the loop.
//
// Run plain WS (desktop dev on http://localhost):
//   node server/signaling-server.js [port]
//
// Run WSS (required for Quest, since WebXR mandates HTTPS and HTTPS pages
// cannot open plain ws://):
//   TLS_CERT=/path/cert.pem TLS_KEY=/path/key.pem node server/signaling-server.js [port]

const WebSocket = require('ws');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || process.argv[2] || '8080', 10);
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

let wss;
if (TLS_CERT && TLS_KEY) {
  const https = require('https');
  const server = https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  });
  wss = new WebSocket.Server({ server });
  server.listen(PORT, () => {
    console.log(`signaling server listening on wss://0.0.0.0:${PORT}`);
  });
} else {
  wss = new WebSocket.Server({ port: PORT });
  console.log(`signaling server listening on ws://0.0.0.0:${PORT}`);
}

const rooms = new Map(); // roomCode -> [ws1, ws2]

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'JOIN') {
      const code = msg.room;
      if (!code) return;
      if (!rooms.has(code)) rooms.set(code, []);
      const room = rooms.get(code);
      if (room.length >= 2) {
        ws.send(JSON.stringify({ type: 'ROOM_FULL' }));
        return;
      }
      room.push(ws);
      ws.room = code;
      const role = room.length === 1 ? 'host' : 'guest';
      ws.send(JSON.stringify({ type: 'JOINED', role }));
      if (room.length === 2) {
        for (const peer of room) {
          peer.send(JSON.stringify({ type: 'PEER_READY' }));
        }
      }
      return;
    }

    if (msg.type === 'OFFER' || msg.type === 'ANSWER' || msg.type === 'ICE') {
      const room = rooms.get(ws.room);
      if (!room) return;
      for (const peer of room) {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          peer.send(raw.toString());
        }
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    const remaining = room.filter((p) => p !== ws);
    if (remaining.length === 0) {
      rooms.delete(ws.room);
    } else {
      rooms.set(ws.room, remaining);
      for (const peer of remaining) {
        if (peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ type: 'PEER_DISCONNECTED' }));
        }
      }
    }
  });
});
