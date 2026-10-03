// `npm run dev:local` — the whole accounts / free-trial / payment flow on
// this PC, to click through by hand:
//
//   http://localhost:5180      the game (vite --mode localdev, .env.localdev)
//   Firebase emulators         Auth + Firestore + Functions (the real backend),
//                              project demo-tt-local — nothing real is touched;
//                              accounts and purchases persist in .emulator-data/
//   your local PayLayer        http://127.0.0.1:8080 (PAY_ENV=test) → real
//                              Razorpay TEST checkout
//
// Needs PayLayer running first (in D:\Bhuvnesh_Data\Payment: `npm run dev`,
// plus its Firestore emulator). On first run — or whenever PayLayer no longer
// knows this site (its emulator data was wiped) — the game is registered as a
// PayLayer site and its API key + webhook secret are written to
// functions/.secret.local (gitignored). Secrets are never printed.
//
//   npm run dev:local              start everything; Ctrl+C stops it
//   npm run dev:local -- --setup   force a fresh PayLayer site registration
//
// PAYLAYER_DIR overrides where the PayLayer repo lives.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const PROJECT = 'demo-tt-local';
const APP_ORIGIN = 'http://localhost:5180';
const PAYLAYER_URL = 'http://127.0.0.1:8080';
const PAYLAYER_DIR = process.env.PAYLAYER_DIR || 'D:/Bhuvnesh_Data/Payment';
const WEBHOOK_URL = `http://127.0.0.1:5101/${PROJECT}/us-central1/api/webhooks/paylayer`;
const SECRET_FILE = 'functions/.secret.local';
const PORTS = [9199, 8189, 5101, 4419, 4519, 5180];
const FIREBASE_BIN = process.platform === 'win32' ? 'node_modules\\.bin\\firebase.cmd' : 'node_modules/.bin/firebase';

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function readSecrets() {
  if (!existsSync(SECRET_FILE)) return {};
  return Object.fromEntries(readFileSync(SECRET_FILE, 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

async function payLayerUp() {
  try { return (await fetch(`${PAYLAYER_URL}/readyz`)).ok; } catch { return false; }
}

/** Does PayLayer still accept this site key? (401 = site gone / key revoked) */
async function keyAccepted(apiKey) {
  if (!apiKey) return false;
  const res = await fetch(`${PAYLAYER_URL}/v1/payment-intents?siteReference=dev-local-probe`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return res.status !== 401;
}

function registerSite() {
  console.log('• Registering the game as a PayLayer site (test mode)…');
  const r = spawnSync('npm', ['run', 'cli', '--', 'site:create',
    '--name', '"Table Tennis XR (local dev)"',
    '--origins', APP_ORIGIN,
    '--currencies', 'INR,USD',
    '--webhook-url', WEBHOOK_URL,
  ], { cwd: PAYLAYER_DIR, shell: true, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const apiKey = (out.match(/API key \(server-side only\):\s*(sk_\S+)/) || [])[1];
  const webhookSecret = (out.match(/Webhook secret:\s*(whsec_\S+)/) || [])[1];
  const siteId = (out.match(/Site (\S+) created\./) || [])[1];
  if (r.status !== 0 || !apiKey || !webhookSecret) {
    // The CLI output contains the secrets on success only; on failure it is
    // safe to show.
    fail(`PayLayer site:create failed (exit ${r.status}).\n${out.slice(-1500)}`);
  }
  writeFileSync(SECRET_FILE, [
    `PAYLAYER_API_KEY=${apiKey}`,
    `PAYLAYER_WEBHOOK_SECRET=${webhookSecret}`,
    `TRIAL_IP_SALT=${randomBytes(16).toString('hex')}`,
    '',
  ].join('\n'));
  console.log(`  site ${siteId} registered; key + webhook secret saved to ${SECRET_FILE}`);
}

function freePorts() {
  if (process.platform !== 'win32') return;
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${PORTS.join(',')} -State Listen -ErrorAction SilentlyContinue | `
    + 'ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }'], { stdio: 'ignore' });
}

async function waitFor(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  if (!existsSync(FIREBASE_BIN)) fail('Run `npm install` first (firebase-tools is a devDependency).');
  if (!(await payLayerUp())) {
    fail(`PayLayer is not reachable at ${PAYLAYER_URL}.\n  Start it in ${PAYLAYER_DIR}:\n`
      + '    npx firebase emulators:start --only firestore --project demo-paylayer   (terminal 1)\n'
      + '    npm run dev                                                           (terminal 2)');
  }
  const secrets = readSecrets();
  if (process.argv.includes('--setup') || !(await keyAccepted(secrets.PAYLAYER_API_KEY))) {
    registerSite();
  } else {
    console.log('• PayLayer site key OK');
  }

  freePorts();
  console.log('• Starting Firebase emulators (auth, firestore, functions)…');
  const emulators = spawn(FIREBASE_BIN, [
    'emulators:start', '--config', 'firebase.e2e.json', '--project', PROJECT,
    '--only', 'auth,firestore,functions',
    // --import refuses a directory that does not exist yet (first run).
    ...(existsSync('.emulator-data') ? ['--import', '.emulator-data'] : []),
    '--export-on-exit', '.emulator-data',
  ], {
    shell: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: '60' },
  });
  if (!(await waitFor(`http://127.0.0.1:5101/${PROJECT}/us-central1/api/api/me`, 120_000))) {
    fail('The Functions emulator did not come up within 2 minutes (see the log above).');
  }

  console.log('• Starting the game…');
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'localdev', '--port', '5180', '--strictPort'], {
    env: { ...process.env, DEV_HTTP: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (!(await waitFor(APP_ORIGIN, 60_000))) fail('Vite did not start on :5180.');

  console.log(`
────────────────────────────────────────────────────────────────────
  Ready:  ${APP_ORIGIN}

  • Free trial: 10 min of PLAY. To skip ahead (then reload the page):
    npm run dev:local:expire              (trial over)
    npm run dev:local:expire -- --left 30 (30 s left)
  • Payments are Razorpay TEST mode — use a Razorpay test card / UPI
    success ID from Razorpay's test docs. Nothing is charged.
  • Accounts and purchases are kept in .emulator-data/ between runs.

  Ctrl+C to stop (emulator data is saved on exit).
────────────────────────────────────────────────────────────────────
`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (vite.exitCode === null) vite.kill('SIGKILL');
    // The emulators got the same Ctrl+C from the console and are exporting
    // their data; wait for them rather than killing the export.
  };
  process.on('SIGINT', stop);
  emulators.on('exit', () => {
    stop();
    freePorts();
    process.exit(0);
  });
}

main().catch((err) => fail(err && err.stack || String(err)));
