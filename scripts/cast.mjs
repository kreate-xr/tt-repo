// `npm run cast` — show the headset's view on this PC (and so on a TV plugged
// into it) for a demo, with NO internet and NO Wi-Fi: everything goes over the
// USB cable.
//
//   1. waits for a Quest on USB
//   2. maps the headset's localhost:5173 to the dev server here (adb reverse),
//      so the Quest browser can open https://localhost:5173
//   3. mirrors one eye (scrcpy) in a normal window — drag it to the screen you
//      want (the TV), then Alt+F for fullscreen. Several headsets open as
//      side-by-side tiles.
//   4. if a cable is pulled, waits for that headset and does 2-3 again
//
// Needs scrcpy (adb ships inside it):  winget install --id Genymobile.scrcpy --exact
// and `npm run dev` running in another terminal.
//
//   npm run cast                          one headset: cast it. Several: asks which
//   npm run cast -- --all                 cast every connected headset, no question
//   npm run cast -- --device=340YC10G     cast the headset whose serial starts so
//   npm run cast -- --fullscreen          start fullscreen (one headset, one screen)
//   npm run cast -- --full                the whole panel (both eyes, lens-shaped)
//   npm run cast -- --crop=1600:900:2017:510    a different crop (width:height:x:y)
//   npm run cast -- --audio-dup           anything else is passed on to scrcpy
//
// The headsets to cast are chosen once, at start: plug them all in first.
// Ctrl+C stops everything; closing one mirror window stops that headset only.

import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { createInterface } from 'node:readline/promises';

const PORT = 5173; // vite.config.js server.port

// scrcpy copies the raw panel (3664x1920 on Quest 2 / 3S): two lens-warped eye
// images with black surrounds. This cuts a 16:9 window out of the middle of the
// right eye, where the warp is least visible. Meta's own casting draws a
// separate flat image and needs internet; this is the offline approximation.
const DEFAULT_CROP = '1600:900:2017:510';

const OWN_FLAGS = ['--full', '--all'];
const OWN_PREFIXES = ['--crop=', '--device='];
const args = process.argv.slice(2);
const full = args.includes('--full');
const all = args.includes('--all');
const crop = args.find((a) => a.startsWith('--crop=')) || `--crop=${DEFAULT_CROP}`;
const wanted = (args.find((a) => a.startsWith('--device=')) || '').slice('--device='.length);
const extra = args.filter((a) => !OWN_FLAGS.includes(a) && !OWN_PREFIXES.some((p) => a.startsWith(p)));
const baseArgs = [
  ...(full ? [] : [crop]),
  // Sound stays in the headset for the player unless an audio flag is passed.
  ...(extra.some((a) => a.includes('audio')) ? [] : ['--no-audio']),
  // Fullscreen with scrcpy 5's default Direct3D renderer never opens a window
  // on Windows (seen on scrcpy 5.0.1); OpenGL does.
  ...(process.platform === 'win32' ? ['--render-driver=opengl'] : []),
  ...extra,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function adb(...a) {
  const r = spawnSync('adb', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: Boolean(r.error) };
}

/** Every headset adb can see: [{ serial, state, model }]. */
function listDevices() {
  return adb('devices', '-l').out.split(/\r?\n/).slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 2 && !f[0].startsWith('*'))
    .map(([serial, state, ...rest]) => ({
      serial,
      state,
      model: ((rest.find((x) => x.startsWith('model:')) || '').slice(6) || 'headset').replace(/_/g, ' '),
    }));
}

const label = (d) => `${d.model} (${d.serial})`;

function devServerUp() {
  return new Promise((resolve) => {
    const s = connect(PORT, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function waitForAnyHeadset() {
  let told = '';
  for (;;) {
    const devices = listDevices();
    const ready = devices.filter((d) => d.state === 'device');
    if (ready.length) return ready;
    const msg = devices.some((d) => d.state === 'unauthorized')
      ? '• Headset found but not authorised — put it on and accept "Allow USB debugging".'
      : '• Waiting for a headset on USB…';
    if (msg !== told) { console.log(msg); told = msg; }
    await sleep(1500);
  }
}

/** Which of the connected headsets to cast: --device / --all, else ask. */
async function choose(ready) {
  if (wanted) {
    const hit = ready.filter((d) => d.serial.startsWith(wanted));
    if (hit.length !== 1) fail(`--device=${wanted} matches ${hit.length} headsets. Connected:\n${ready.map((d) => `    ${label(d)}`).join('\n')}`);
    return hit;
  }
  if (all || ready.length === 1) return ready;
  if (!process.stdin.isTTY) fail('Several headsets are connected — pass --all or --device=<serial>.');

  console.log('\nSeveral headsets are connected:');
  ready.forEach((d, i) => console.log(`  ${i + 1}) ${label(d)}`));
  console.log('  a) all of them, side by side');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question('Cast which? ')).trim().toLowerCase();
      if (answer === 'a' || answer === 'all') return ready;
      const picked = ready[Number(answer) - 1];
      if (picked) return [picked];
    }
  } finally {
    rl.close();
  }
}

/** Primary screen size, for tiling several mirrors. Windows only; else 1080p. */
function screenSize() {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width)x$($b.Height)"'],
    { encoding: 'utf8' });
    const m = /(\d+)x(\d+)/.exec(r.stdout || '');
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  }
  return { w: 1920, h: 1080 };
}

/**
 * scrcpy window flags. Every mirror is an ordinary window with a title bar, so
 * it can be dragged to another screen (the TV, when the display is extended);
 * Alt+F then makes it fullscreen THERE. One headset gets scrcpy's default
 * window, several get a grid of tiles.
 */
function layout(count) {
  if (count === 1) return [[]];
  const { w, h } = screenSize();
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const tw = Math.floor(w / cols);
  const th = Math.floor(h / rows);
  return Array.from({ length: count }, (_, i) => [
    `--window-x=${(i % cols) * tw}`, `--window-y=${Math.floor(i / cols) * th}`,
    `--window-width=${tw}`, `--window-height=${th}`,
  ]);
}

/** Keep one headset mapped and mirrored until its window is closed. */
async function cast(device, windowArgs) {
  const tag = `[${device.serial.slice(-4)}]`;
  let told = false;
  for (let quickFails = 0; !stopping;) {
    if (adb('-s', device.serial, 'get-state').out !== 'device') {
      if (!told) { console.log(`${tag} waiting for ${label(device)}…`); told = true; }
      await sleep(1500);
      continue;
    }
    told = false;
    const rev = adb('-s', device.serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`);
    if (!rev.ok) { console.log(`${tag} adb reverse failed: ${rev.out}`); await sleep(2000); continue; }
    console.log(`${tag} ${label(device)} connected — mirroring.`);

    const started = Date.now();
    const code = await new Promise((resolve) => {
      spawn('scrcpy', ['-s', device.serial, `--window-title=${label(device)}`, ...baseArgs, ...windowArgs], { stdio: 'inherit' })
        .on('exit', resolve).on('error', () => resolve(1));
    });
    // 0 = the window was closed on purpose; anything else is a lost headset
    // (cable pulled, headset restarted) — or scrcpy rejecting its arguments.
    if (stopping || code === 0) return;
    quickFails = Date.now() - started < 5000 ? quickFails + 1 : 0;
    if (quickFails >= 3) { console.error(`${tag} scrcpy keeps exiting straight away — see its message above.`); return; }
    console.log(`${tag} mirror stopped — reconnecting…`);
    await sleep(1500);
  }
}

async function main() {
  if (adb('version').missing || spawnSync('scrcpy', ['--version']).error) {
    fail('scrcpy / adb not found. Install with:\n    winget install --id Genymobile.scrcpy --exact\n  then open a NEW terminal.');
  }
  if (!(await devServerUp())) {
    console.log(`! Nothing is listening on :${PORT} — start the game with \`npm run dev\` in another terminal.`);
  }

  const chosen = await choose(await waitForAnyHeadset());
  process.on('SIGINT', () => { stopping = true; });
  console.log(`• In each Quest browser open  https://localhost:${PORT}`);
  console.log('• A headset must be awake, or its picture is black.');

  const windows = layout(chosen.length);
  await Promise.all(chosen.map((d, i) => cast(d, windows[i])));
  process.exit(0);
}

main().catch((err) => fail(err && err.stack || String(err)));
