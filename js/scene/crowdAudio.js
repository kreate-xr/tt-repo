// Positional crowd audio anchored to the stadium's 24 audience sections
// (Seats_Audi_1 .. Seats_Audi_24 in TableTennis_Stadium.glb). Uses the
// pre-recorded MP3s in public/sounds/ played through per-anchor PannerNodes
// so cheers actually feel like they come from the correct side of the arena.
//
// Files (from public/sounds/):
//   pointWin.mp3            — crowd cheer after any won point. Long (~40s);
//                             we truncate per-cheer via source.stop() so
//                             back-to-back points don't overlap awkwardly.
//   disapointment.mp3       — crowd groan/sigh when the ball is missed. ~6s.
//                             Played on the LOSING side's stands so it reads
//                             as "your fans are bummed" (or "AI fans are
//                             bummed") for the appropriate side.
//   beforeAndAfterMatch.mp3 — big anthem/announcement track. Played
//                             center-listener (through the audio graph's
//                             non-positional head) at match start and
//                             match end so it feels like the venue's PA
//                             system rather than a directional cheer.
//
// Loading is async (fetch + decodeAudioData). Methods called before the
// buffers finish loading no-op silently — the arena takes several seconds
// to mount and the load usually finishes well before the first point.
//
// Downmix: source MP3s are stereo. Feeding stereo into an HRTF PannerNode
// downmixes badly (both channels are re-panned through the same HRTF
// pass, muddying the result). We mono-downmix positional buffers at load
// time. The center-listener PA plays are left stereo — no HRTF pass to
// muddy, and the original stereo mix reads as a big room sound.

import { getAudioContext, createSpatialHead } from './audio.js';

const POINT_WIN_URL     = 'sounds/pointWin.mp3';
const DISAPPOINTMENT_URL = 'sounds/disapointment.mp3';
const MATCH_URL         = 'sounds/beforeAndAfterMatch.mp3';

// Per-cheer-intensity safety caps (seconds). These are the ABSOLUTE max
// each cheer will play if nothing else interrupts it — pointWin.mp3 is
// ~40s, so an uncapped play would drone on well past the next serve.
// In normal play the cheer is instead cut short by quietDown() when the
// rally manager fires onServeRequested for the next serve (see
// aiMatch.js). The caps here only kick in if quietDown never fires
// (e.g. at match end, or if the serve schedule is disrupted).
// Bumped from the previous 1.5/3/6s values because the earlier caps cut
// the cheers off too aggressively; now the sound gets to breathe until
// the natural next-serve fade takes over.
const CHEER_STOP_SMALL  = 5.0;
const CHEER_STOP_MEDIUM = 8.0;
const CHEER_STOP_BIG    = 12.0;
// Fade duration when quietDown() is called. 500ms is short enough that
// the crowd noticeably drops as the server steps up, but long enough
// that it doesn't sound like a hard mute.
const QUIET_DOWN_FADE_MS = 500;

// Per-file gain scale. MP3s are often mastered louder than our synthesized
// paddle-hit sounds; scale down so a cheer doesn't clip against a smash.
const GAIN_POINT_WIN     = 0.65;
const GAIN_DISAPPOINTMENT = 0.55;
const GAIN_MATCH_PA      = 0.75;

function partitionAnchors(anchors, tableCenterZ) {
  const player = [];
  const ai = [];
  for (const a of anchors) {
    if (a.position.z >= tableCenterZ) player.push(a);
    else ai.push(a);
  }
  return { player, ai };
}

// Downmix any multi-channel buffer to mono by averaging channels. Required
// for correct HRTF panning — the browser's mono-safe path on PannerNode.
// Returns the same buffer if already mono.
function toMono(buffer, ctx) {
  if (buffer.numberOfChannels === 1) return buffer;
  const mono = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
  const out = mono.getChannelData(0);
  const chans = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) chans.push(buffer.getChannelData(ch));
  const n = chans.length;
  for (let i = 0; i < buffer.length; i++) {
    let sum = 0;
    for (let c = 0; c < n; c++) sum += chans[c][i];
    out[i] = sum / n;
  }
  return mono;
}

async function fetchAndDecode(url, ctx) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const arr = await res.arrayBuffer();
  // decodeAudioData supports both promise + callback forms; use promise.
  return await ctx.decodeAudioData(arr);
}

/**
 * anchors: array of { position: THREE.Vector3, node: Object3D }
 * tableCenterZ: world-space Z of table midline; used to partition anchors.
 */
export function createCrowdAudio({ anchors, tableCenterZ }) {
  if (!anchors || anchors.length === 0) return null;
  const ctx = getAudioContext();

  const { player: playerAnchors, ai: aiAnchors } = partitionAnchors(anchors, tableCenterZ);
  console.log(`[crowdAudio] ${anchors.length} anchors: ${playerAnchors.length} player-side, ${aiAnchors.length} AI-side`);

  // Per-anchor spatial heads — created once, reused for every source.
  const anchorHeads = anchors.map((a) => ({
    anchor: a,
    head: createSpatialHead(a.position, { dry: 0.7, wet: 0.8 }),
  }));
  // Non-positional head for PA-style plays (match start/end anthem).
  // dry-dominant + light reverb so it feels like it's coming from house
  // speakers rather than being right in the ear.
  const paHead = createSpatialHead(null, { dry: 0.95, wet: 0.35 });

  // All currently-playing crowd sources. quietDown() iterates this to
  // fade them out when the next serve is about to begin. Each entry is
  // { src, gain, baseGain } — baseGain is captured at start so the fade
  // ramps from the current value (which may already have been reduced
  // by the natural stop-fade window) to zero.
  const activeSources = new Set();
  function trackSource(src, gain, baseGain) {
    const entry = { src, gain, baseGain };
    activeSources.add(entry);
    // Auto-remove when the source ends naturally so the set doesn't leak.
    src.addEventListener('ended', () => {
      activeSources.delete(entry);
      try { src.disconnect(); gain.disconnect(); } catch (_) {}
    });
  }

  // Buffers filled in by the async load below. Access via getters so
  // early callers see null cleanly instead of undefined.
  let bufPointWinMono = null;      // mono, for positional plays
  let bufDisappointMono = null;    // mono, for positional plays
  let bufMatchStereo = null;       // stereo (or original), for PA plays
  let loaded = false;
  let loadError = null;

  // Kick off the async load. `ready` resolves once all three files are
  // decoded (or with the caught error attached to loadError). Rejecting
  // would force every caller to await + catch — we want fail-quiet so a
  // missing file doesn't break gameplay. Instead resolve either way and
  // let callers check isLoaded()/getLoadError() if they care.
  const ready = (async () => {
    try {
      const [pw, dp, mt] = await Promise.all([
        fetchAndDecode(POINT_WIN_URL, ctx),
        fetchAndDecode(DISAPPOINTMENT_URL, ctx),
        fetchAndDecode(MATCH_URL, ctx),
      ]);
      bufPointWinMono   = toMono(pw, ctx);
      bufDisappointMono = toMono(dp, ctx);
      bufMatchStereo    = mt; // left stereo for PA use
      loaded = true;
      console.log(`[crowdAudio] MP3s loaded — pointWin ${pw.duration.toFixed(1)}s, ` +
                  `disappointment ${dp.duration.toFixed(1)}s, match ${mt.duration.toFixed(1)}s`);
    } catch (err) {
      loadError = err;
      console.warn('[crowdAudio] failed to load sound files:', err);
    }
  })();

  function playAtAnchor(buffer, anchorEntry, {
    gainScale = 1, pitchJitterCents = 100, stopAfterSec = null,
    delaySec = 0,
  } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (pitchJitterCents > 0) {
      const cents = (Math.random() * 2 - 1) * pitchJitterCents;
      src.playbackRate.value = Math.pow(2, cents / 1200);
    }
    const g = ctx.createGain();
    g.gain.value = gainScale;
    src.connect(g).connect(anchorEntry.head);
    const startAt = ctx.currentTime + Math.max(0, delaySec);
    src.start(startAt);
    if (stopAfterSec != null) {
      // Longer linear fade-out on the last 400ms so the safety-cap
      // truncation doesn't click — this is the fallback path when
      // quietDown() isn't called (match end, disrupted schedule).
      const stopAt = startAt + stopAfterSec;
      const fadeStart = Math.max(startAt, stopAt - 0.4);
      g.gain.setValueAtTime(gainScale, fadeStart);
      g.gain.linearRampToValueAtTime(0, stopAt);
      try { src.stop(stopAt); } catch (_) {}
    }
    // Track for quietDown(). Cleanup is via the 'ended' listener inside
    // trackSource — no separate src.onended assignment (that would
    // overwrite the tracker's cleanup path).
    trackSource(src, g, gainScale);
  }

  function playCenter(buffer, { gainScale = 1, delaySec = 0 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gainScale;
    src.connect(g).connect(paHead);
    src.start(ctx.currentTime + Math.max(0, delaySec));
    trackSource(src, g, gainScale);
  }

  /**
   * Fade every currently-playing crowd source to silence over `fadeMs` and
   * then stop them. Called by aiMatch.js when the rally manager fires
   * onServeRequested — the natural moment for the crowd to quiet down as
   * the server steps up to the line.
   *
   * Sources already scheduled to stop earlier than the fade window are
   * left alone — they'll end via their own stop schedule.
   */
  function quietDown(fadeMs = QUIET_DOWN_FADE_MS) {
    if (!loaded) return;
    if (activeSources.size === 0) return;
    const t = ctx.currentTime;
    const fadeSec = Math.max(0.05, fadeMs / 1000);
    for (const entry of activeSources) {
      const { src, gain } = entry;
      try {
        // Cancel the pending stop-fade so our shorter fade wins, then
        // ramp from the current gain value down to zero.
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + fadeSec);
        src.stop(t + fadeSec);
      } catch (_) { /* source may already be stopped */ }
    }
  }

  // Pick N random anchors from a side's pool (returns anchorHeads entries).
  function sampleAnchors(sidePool, count) {
    const pool = anchorHeads.filter((h) => sidePool.includes(h.anchor));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
  }

  // Small = 3-5 anchors + 1.5s cap. Medium ~ half the side + 3s cap.
  // Big = all anchors + 6s cap.
  function cheerParams(intensity, poolSize) {
    switch (intensity) {
      case 'small':
        return { count: Math.min(poolSize, 3 + Math.floor(Math.random() * 3)),
                 stop: CHEER_STOP_SMALL, gain: GAIN_POINT_WIN * 0.75 };
      case 'big':
        return { count: poolSize, stop: CHEER_STOP_BIG, gain: GAIN_POINT_WIN * 1.0 };
      case 'medium':
      default:
        return { count: Math.min(poolSize, Math.ceil(poolSize * 0.5)),
                 stop: CHEER_STOP_MEDIUM, gain: GAIN_POINT_WIN * 0.9 };
    }
  }

  /**
   * Play the pointWin cheer on `side`'s stands. Kept as a low-level
   * primitive; most callers should use reactToPoint below.
   */
  function cheerForSide(side, intensity = 'medium') {
    if (!loaded) return;
    const pool = side === 'player' ? playerAnchors : aiAnchors;
    if (pool.length === 0) return;
    const { count, stop, gain } = cheerParams(intensity, pool.length);
    const picks = sampleAnchors(pool, count);
    for (let i = 0; i < picks.length; i++) {
      // Stagger start times up to 120ms so all anchors don't play sample-
      // frame-aligned — gives the cheer a natural wave feel.
      playAtAnchor(bufPointWinMono, picks[i], {
        gainScale: gain,
        pitchJitterCents: 120,
        stopAfterSec: stop,
        delaySec: Math.random() * 0.12,
      });
    }
  }

  /**
   * Groan / disappointment on the losing side's stands. Shorter and
   * quieter than a cheer — reads as a collective sigh, not a boo.
   */
  function disappointmentForSide(side) {
    if (!loaded) return;
    const pool = side === 'player' ? playerAnchors : aiAnchors;
    if (pool.length === 0) return;
    // Half the stands, slightly delayed relative to the cheer so the
    // "yeah!" from one side and the "aww" from the other don't stomp on
    // each other rhythmically.
    const picks = sampleAnchors(pool, Math.ceil(pool.length * 0.5));
    for (const p of picks) {
      playAtAnchor(bufDisappointMono, p, {
        gainScale: GAIN_DISAPPOINTMENT,
        pitchJitterCents: 80,
        stopAfterSec: null, // it's short (~6s) — play in full
        delaySec: 0.10 + Math.random() * 0.15,
      });
    }
  }

  /**
   * The main point-scored reaction. Winner's stands cheer, loser's stands
   * groan — both fire in parallel, staggered inside their own helpers.
   * `intensity` scales the cheer only ('small' | 'medium' | 'big').
   */
  function reactToPoint(winnerSide, intensity = 'medium') {
    cheerForSide(winnerSide, intensity);
    const loserSide = winnerSide === 'player' ? 'ai' : 'player';
    disappointmentForSide(loserSide);
  }

  /**
   * Match-start fanfare — the PA-style anthem file, center-listener so it
   * feels like it's coming from the house speakers.
   */
  function playMatchStart() {
    if (!loaded || !bufMatchStereo) return;
    playCenter(bufMatchStereo, { gainScale: GAIN_MATCH_PA });
  }

  /**
   * Match-won celebration — the anthem + a big scattered cheer on the
   * winner's stands. Anthem carries the moment; the scattered cheer adds
   * directional excitement so it doesn't feel like a static end-of-match
   * cutscene.
   */
  function playMatchWon(winnerSide) {
    if (!loaded) return;
    if (bufMatchStereo) playCenter(bufMatchStereo, { gainScale: GAIN_MATCH_PA });
    // Layer scattered pointWin snippets across the winner's stands
    // starting shortly after the anthem kicks in.
    const pool = winnerSide === 'player' ? playerAnchors : aiAnchors;
    const picks = sampleAnchors(pool, pool.length);
    for (const p of picks) {
      playAtAnchor(bufPointWinMono, p, {
        gainScale: GAIN_POINT_WIN * 0.7,
        pitchJitterCents: 150,
        stopAfterSec: 4.5,
        delaySec: 0.4 + Math.random() * 1.2,
      });
    }
  }

  /**
   * Compatibility shim — some earlier callers used this name for a
   * between-points ambient touch. Map it to a light-intensity cheer
   * across both sides (feels like acknowledgement applause).
   */
  function playScatteredApplause() {
    if (!loaded) return;
    for (const h of anchorHeads) {
      if (Math.random() < 0.5) {
        playAtAnchor(bufPointWinMono, h, {
          gainScale: GAIN_POINT_WIN * 0.35,
          pitchJitterCents: 150,
          stopAfterSec: 1.2,
          delaySec: Math.random() * 0.3,
        });
      }
    }
  }

  function dispose() {
    for (const { head } of anchorHeads) {
      try { head.disconnect(); } catch (_) {}
    }
    try { paHead.disconnect(); } catch (_) {}
  }

  return {
    // Preferred API.
    reactToPoint, playMatchStart, playMatchWon, quietDown,
    // Lower-level primitives + back-compat.
    cheerForSide, disappointmentForSide, playScatteredApplause,
    dispose,
    anchorCount: anchors.length,
    // Async-ready hook — resolves once MP3s are decoded (or the load
    // failed). Callers who want to fire the match-start anthem as soon
    // as the sound is available should await this.
    ready,
    // For diagnostics.
    isLoaded: () => loaded,
    getLoadError: () => loadError,
  };
}
