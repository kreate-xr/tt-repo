// `npm run test:e2e` — boots the Auth, Firestore and Functions emulators
// (firebase.e2e.json, project demo-tt) around e2e/accounts.e2e.mjs.
//
// The Functions emulator reads secrets from functions/.secret.local; this
// writes the fake PayLayer's values there for the run and puts back whatever
// was there before. The file is gitignored either way.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { FAKE_API_KEY, FAKE_WEBHOOK_SECRET } from './fakePayLayer.mjs';

const SECRET_FILE = 'functions/.secret.local';
// Every port the suite owns (firebase.e2e.json, Vite, the fake PayLayer).
const E2E_PORTS = [9199, 8189, 5101, 4419, 4519, 5180, 8790];

// Windows: emulator JVMs and dev servers can outlive the run that started
// them and hold these ports for the next one.
function freePorts() {
  if (process.platform !== 'win32') return;
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${E2E_PORTS.join(',')} -State Listen -ErrorAction SilentlyContinue | `
    + 'ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }'], { stdio: 'ignore' });
}
freePorts();
const previous = existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, 'utf8') : null;

writeFileSync(SECRET_FILE, [
  `PAYLAYER_API_KEY=${FAKE_API_KEY}`,
  `PAYLAYER_WEBHOOK_SECRET=${FAKE_WEBHOOK_SECRET}`,
  'TRIAL_IP_SALT=e2e-salt',
  '',
].join('\n'));

let status = 1;
try {
  const r = spawnSync('firebase', [
    'emulators:exec', '--config', 'firebase.e2e.json',
    '--only', 'auth,firestore,functions', '--project', 'demo-tt',
    '"node e2e/accounts.e2e.mjs"',
  ], {
    stdio: 'inherit',
    shell: true,
    // The CLI gives function discovery 10 s by default, which a cold Windows
    // start (antivirus scanning node_modules) can miss.
    env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: '60' },
  });
  status = r.status ?? 1;
} finally {
  if (previous === null) rmSync(SECRET_FILE, { force: true });
  else writeFileSync(SECRET_FILE, previous);
  freePorts();
}
process.exit(status);
