// Beta read-out: the funnel, the failures, the feedback, the signup list.
//
// The client CANNOT read any of this back — firestore.rules denies `read` on
// all three collections, deliberately, so a player's feedback and email are
// not fetchable by anyone who can open the app. That leaves exactly two doors:
// the Firebase console, and this script. Uses the ADMIN SDK, which bypasses
// security rules, so it needs a service-account key rather than the web config
// in .env.local.
//
// Setup (one-time):
//   1. Firebase Console → Project Settings → Service accounts →
//      "Generate new private key" → save the JSON somewhere OUTSIDE the repo
//   2. export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
//      (PowerShell: $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\key.json")
//   3. npm i -D firebase-admin   (>= 12, for the named-database getFirestore)
//
// The key decides the project: a sportyxr-tech service account reads prod, a
// sportyxr-test one reads test. Keep one of each outside the repo.
//
// Run:
//   node scripts/query-sessions.mjs                # funnel + failures + feedback
//   node scripts/query-sessions.mjs --days 3       # only the last 3 days
//   node scripts/query-sessions.mjs --emails       # the early-access list, CSV
//   node scripts/query-sessions.mjs --feedback     # every rating and note
//
// A collection-group query over `runs` is what makes this one read instead of
// one-per-player. Firestore will print a link to create the required index the
// first time it runs; follow it once.

import process from 'node:process';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DAYS = Number(valueOf('--days', '30'));

async function db() {
  let admin;
  try {
    admin = await import('firebase-admin/app');
  } catch {
    throw new Error('firebase-admin is not installed. Run: npm i -D firebase-admin');
  }
  const { getFirestore } = await import('firebase-admin/firestore');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set — point it at a service-account JSON key (see the header of this file).'
    );
  }
  if (!admin.getApps().length) admin.initializeApp({ credential: admin.applicationDefault() });
  // The named database, same as js/network/firebaseClient.js — the app never
  // writes to '(default)', so a query there is always empty.
  return getFirestore(admin.getApp(), 'tabletennis');
}

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%`.padStart(4) : '   —');

function since() {
  const d = new Date();
  d.setDate(d.getDate() - DAYS);
  return d;
}

async function loadRuns(store) {
  const snap = await store.collectionGroup('runs')
    .where('startedAt', '>=', since())
    .orderBy('startedAt', 'desc')
    .get();
  return snap.docs.map((d) => ({ id: d.id, uid: d.ref.parent.parent.id, ...d.data() }));
}

function reportFunnel(runs) {
  // Only real XR sessions count in the funnel — a `lobby-*` run is a failed
  // join recorded before the player ever entered XR, and folding those in
  // would understate every step below it.
  const xr = runs.filter((r) => !String(r.xrMode || '').startsWith('lobby'));
  const step = (name) => xr.filter((r) => r.milestones && r.milestones[name] !== undefined).length;

  const total = xr.length;
  const rows = [
    ['page load', step('pageLoad')],
    ['entry armed', step('entryArmed')],
    ['session started', total],
    ['models loaded', step('modelsLoaded')],
    ['first rally', step('firstRally')],
    ['match complete', step('matchComplete')],
  ];

  console.log(`\n=== FUNNEL — last ${DAYS} days, ${total} XR sessions, ${new Set(xr.map((r) => r.uid)).size} players ===\n`);
  for (const [label, n] of rows) {
    console.log(`  ${label.padEnd(18)} ${String(n).padStart(5)}  ${pct(n, total)}`);
  }

  const ended = xr.filter((r) => r.endedAt);
  console.log(`\n  sessions with an end-write: ${ended.length}/${total}` +
    ` (the rest are headset-off / tab-killed — expected, not a bug)`);
  if (ended.length) {
    const mins = ended.map((r) => (r.durationMs || 0) / 60000).sort((a, b) => a - b);
    const median = mins[Math.floor(mins.length / 2)];
    console.log(`  median session length: ${median.toFixed(1)} min`);
  }
}

function reportFailures(runs) {
  const joins = runs.filter((r) => String(r.xrMode || '').startsWith('lobby'));
  console.log(`\n=== FAILED MULTIPLAYER JOINS — ${joins.length} ===\n`);
  if (!joins.length) { console.log('  (none)'); return; }
  for (const r of joins.slice(0, 25)) {
    const err = (r.errors && r.errors[0] && r.errors[0].msg) || 'unknown';
    console.log(`  ${r.xrMode.padEnd(13)} ${err}`);
    const phases = r.net && r.net.trace && r.net.trace.phases;
    if (phases && phases.length) {
      // The biggest delta IS the culprit — that is the whole reason
      // connectTrace is collected unconditionally.
      const worst = phases.reduce((a, b) => (b.deltaMs > a.deltaMs ? b : a));
      console.log(`      stalled at: ${worst.phase} (+${worst.deltaMs}ms of ${r.net.trace.totalMs}ms total)`);
    }
  }
}

function reportErrors(runs) {
  const counts = new Map();
  for (const r of runs) {
    for (const e of r.errors || []) {
      const key = e.msg;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  if (!counts.size) return;
  console.log(`\n=== ERRORS — ${counts.size} distinct ===\n`);
  for (const [msg, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(n).padStart(4)}×  ${msg.slice(0, 110)}`);
  }
  console.log('\n  Symbolicate a minified frame against dist/assets/*.map (vite build sourcemap: hidden).');
}

async function reportFeedback(store) {
  const snap = await store.collectionGroup('items')
    .where('createdAt', '>=', since())
    .orderBy('createdAt', 'desc')
    .get();
  const items = snap.docs.map((d) => d.data());
  const rated = items.filter((i) => typeof i.rating === 'number');
  const avg = rated.length
    ? (rated.reduce((s, i) => s + i.rating, 0) / rated.length).toFixed(2)
    : '—';
  console.log(`\n=== FEEDBACK — ${items.length} items, ${rated.length} rated, mean ${avg}/5 ===\n`);
  for (let r = 5; r >= 1; r--) {
    const n = rated.filter((i) => i.rating === r).length;
    console.log(`  ${r}★ ${'█'.repeat(n).slice(0, 50)} ${n}`);
  }
  const notes = items.filter((i) => i.text);
  if (notes.length) {
    console.log(`\n  --- ${notes.length} written notes ---\n`);
    for (const n of notes) {
      console.log(`  [${n.rating ? `${n.rating}★` : ' — '}] ${n.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
}

async function reportEmails(store) {
  const snap = await store.collection('signups').orderBy('createdAt', 'desc').get();
  console.log('email,method,createdAt,uid');
  for (const d of snap.docs) {
    const s = d.data();
    const when = s.createdAt && s.createdAt.toDate ? s.createdAt.toDate().toISOString() : '';
    console.log(`${s.email},${s.method},${when},${d.id}`);
  }
  console.error(`\n(${snap.size} signups)`);
}

async function main() {
  const store = await db();

  if (has('--emails')) { await reportEmails(store); return; }
  if (has('--feedback')) { await reportFeedback(store); return; }

  const runs = await loadRuns(store);
  reportFunnel(runs);
  reportFailures(runs);
  reportErrors(runs);
  await reportFeedback(store);
  console.log('\nEarly-access list: node scripts/query-sessions.mjs --emails\n');
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
