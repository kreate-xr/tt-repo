// `npm run dev:local:expire [-- --left <seconds>]` — skip ahead in the free
// trial while `npm run dev:local` is running, instead of playing 10 minutes.
// Sets the trial clock of EVERY account in the local Auth emulator (anonymous
// ones included) to <seconds> remaining — default 0, i.e. trial over. Reload
// the page afterwards. Emulator-only: it talks to 127.0.0.1 and project
// demo-tt-local, nothing else.

const PROJECT = 'demo-tt-local';
const AUTH = 'http://127.0.0.1:9199';
const FIRESTORE = 'http://127.0.0.1:8189';
const TRIAL_MS = 10 * 60 * 1000;

const i = process.argv.indexOf('--left');
const leftSec = i > -1 ? Math.max(0, Math.min(600, Number(process.argv[i + 1]) || 0)) : 0;
const usedMs = TRIAL_MS - leftSec * 1000;

async function main() {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
    method: 'POST',
    headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ returnUserInfo: true }),
  }).catch(() => null);
  if (!res || !res.ok) {
    console.error('✗ Auth emulator not reachable — is `npm run dev:local` running?');
    process.exit(1);
  }
  const users = (await res.json()).userInfo || [];
  if (!users.length) {
    console.log('No accounts yet — open the game once first.');
    return;
  }
  for (const u of users) {
    const url = `${FIRESTORE}/v1/projects/${PROJECT}/databases/tabletennis/documents/users/${u.localId}?updateMask.fieldPaths=trial`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { trial: { mapValue: { fields: {
        usedMs: { integerValue: String(usedMs) },
        lastTickMs: { nullValue: null },
        leaseMs: { integerValue: '0' },
      } } } } }),
    });
    console.log(`${r.ok ? '✓' : '✗'} ${u.email || '(anonymous)'} ${u.localId} → ${leftSec}s left`);
  }
  console.log('\nReload the game page to see it.');
}

main();
