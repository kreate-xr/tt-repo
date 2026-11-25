// `npm run cast` — show the headset's view on this PC (and so on a TV plugged
// into it) for a demo, with NO internet and NO Wi-Fi: everything goes over the
// USB cable.
//
//   1. waits for the Quest on USB
//   2. maps the headset's localhost:5173 to the dev server here (adb reverse),
//      so the Quest browser can open https://localhost:5173
//   3. mirrors one eye fullscreen (scrcpy)
//   4. if the cable is pulled, waits for the headset and does 2-3 again
//
// Needs scrcpy (adb ships inside it):  winget install --id Genymobile.scrcpy --exact
// and `npm run dev` running in another terminal.
//
//   npm run cast                          one eye, cropped, fullscreen
//   npm run cast -- --full                the whole panel (both eyes, lens-shaped)
//   npm run cast -- --crop=1600:900:2017:510    a different crop (width:height:x:y)
//   npm run cast -- --audio-dup           anything else is passed on to scrcpy
//
// Ctrl+C (or closing the mirror window) stops it.

import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';

const PORT = 5173; // vite.config.js server.port

// scrcpy copies the raw panel (3664x1920 on Quest 2 / 3S): two lens-warped eye
// images with black surrounds. This cuts a 16:9 window out of the middle of the
// right eye, where the warp is least visible. Meta's own casting draws a
// separate flat image and needs internet; this is the offline approximation.
const DEFAULT_CROP = '1600:900:2017:510';

const args = process.argv.slice(2);
const full = args.includes('--full');
const crop = (args.find((a) => a.startsWith('--crop=')) || `--crop=${DEFAULT_CROP}`);
const extra = args.filter((a) => a !== '--full' && !a.startsWith('--crop='));
const scrcpyArgs = [
  ...(full ? [] : [crop]),
  // Sound stays in the headset for the player unless an audio flag is passed.
  ...(extra.some((a) => a.includes('audio')) ? [] : ['--no-audio']),
  '--fullscreen',
  // Fullscreen with scrcpy 5's default Direct3D renderer never opens a window
  // on Windows (seen on scrcpy 5.0.1); OpenGL does.
  ...(process.platform === 'win32' ? ['--render-driver=opengl'] : []),
  ...extra,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function adb(...a) {
  const r = spawnSync('adb', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: Boolean(r.error) };
}

function devServerUp() {
  return new Promise((resolve) => {
    const s = connect(PORT, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function waitForHeadset() {
  let told = '';
  for (;;) {
    const state = adb('get-state').out;
    if (state === 'device') return;
    const msg = /unauthorized/.test(state)
      ? '• Headset found but not authorised — put it on and accept "Allow USB debugging".'
      : '• Waiting for the headset on USB…';
    if (msg !== told) { console.log(msg); told = msg; }
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

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });

  for (let quickFails = 0; !stopping;) {
    await waitForHeadset();
    const rev = adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
    if (!rev.ok) { console.log(`! adb reverse failed: ${rev.out}`); await sleep(2000); continue; }
    console.log(`• Headset connected. In the Quest browser open  https://localhost:${PORT}`);
    console.log('• Mirroring (the headset must be awake, or the picture is black)…');

    const started = Date.now();
    const code = await new Promise((resolve) => {
      spawn('scrcpy', scrcpyArgs, { stdio: 'inherit' }).on('exit', resolve).on('error', () => resolve(1));
    });
    // 0 = the window was closed on purpose; anything else is a lost headset
    // (cable pulled, headset restarted) — or scrcpy rejecting its arguments.
    if (stopping || code === 0) break;
    quickFails = Date.now() - started < 5000 ? quickFails + 1 : 0;
    if (quickFails >= 3) fail('scrcpy keeps exiting straight away — see its message above.');
    console.log('• Mirror stopped — reconnecting…');
    await sleep(1500);
  }
  process.exit(0);
}

main().catch((err) => fail(err && err.stack || String(err)));
