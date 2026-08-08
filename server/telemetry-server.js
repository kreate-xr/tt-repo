// Tiny HTTP receiver for client telemetry beacons. No framework — Node's
// built-in http module is enough.
//
// Run plain HTTP (desktop dev):
//   node server/telemetry-server.js [port]
// Run HTTPS (required for production / Quest sendBeacon over wss-served page):
//   TLS_CERT=/cert.pem TLS_KEY=/key.pem node server/telemetry-server.js [port]
//
// For v1 we just log each payload as JSON to stdout. Pipe to a file or pick a
// real sink later.

const PORT = parseInt(process.env.PORT || process.argv[2] || '8081', 10);
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

const path = '/telemetry';

function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }
  if (req.method !== 'POST' || req.url !== path) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body || '{}');
      const stamp = new Date().toISOString();
      console.log(`[${stamp}] ${JSON.stringify(payload)}`);
    } catch (e) {
      console.warn('telemetry: bad payload', e.message);
    }
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
  });
}

if (TLS_CERT && TLS_KEY) {
  const https = require('https');
  const fs = require('fs');
  https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  }, handler).listen(PORT, () => {
    console.log(`telemetry server listening on https://0.0.0.0:${PORT}${path}`);
  });
} else {
  const http = require('http');
  http.createServer(handler).listen(PORT, () => {
    console.log(`telemetry server listening on http://0.0.0.0:${PORT}${path}`);
  });
}
