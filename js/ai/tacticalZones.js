// Tactical placement zones — a curated menu of "smart player" target
// coordinates on the player side of the table. Real players don't just
// mirror where their opponent is; they play deliberate placements —
// deep cross-court, wide corners, short drops, body shots — to open the
// court and force movement.
//
// Prior to this module, all three engines picked target x/z either:
//   (a) by mirroring the player's position (neutral picker), or
//   (b) by sampling from a Voronoi heatmap of the player's OWN landings.
// Neither generates a wide-angle target unless the player has already hit
// one — the AI could never "invent" a corner shot. Result: the AI reads
// as predictable and reactive.
//
// This module owns the zone vocabulary and a distance-weighted sampler.
// Consumers roll a probability to decide whether to use a tactical zone
// vs the existing neutral/heatmap pick.
//
// Coordinates are spec-frame:
//   x: signed lateral, ~[-0.7, +0.7] within table bounds
//   z: non-negative "from net" distance on the player side, ~[0.0, 1.37]
//
// Worker-safe: no THREE, no DOM.

// Zone catalog. Each zone is a target CENTER plus a soft radius the
// picker jitters within. Names are descriptive so anti-repeat and
// telemetry can log them meaningfully.
export const TACTICAL_ZONES = Object.freeze([
  // Deep corners — classic setup shots. Force movement all the way back
  // and force a diagonal recovery. Centers sit ~10 cm inside the lines
  // (table corner is x ±0.7625, z 1.37): international players attack the
  // lines, and the old 0.60/1.15 centers left a 16-22 cm courtesy strip no
  // real opponent grants. Zone jitter + each tier's SAFE clamp still keep
  // the sampled target inside that tier's court (beginner's wide jitter
  // clamps back to ±0.70, pro's runs to ±0.745).
  { name: 'deep_wide_left',       x: -0.66, z: 1.24, radius: 0.07 },
  { name: 'deep_wide_right',      x:  0.66, z: 1.24, radius: 0.07 },
  { name: 'deep_middle_left',     x: -0.30, z: 1.26, radius: 0.09 },
  { name: 'deep_middle_right',    x:  0.30, z: 1.26, radius: 0.09 },

  // Wide mid-court — hardest to reach from center. Reward the player who
  // camps middle by pulling them out.
  { name: 'wide_left',            x: -0.70, z: 0.75, radius: 0.07 },
  { name: 'wide_right',           x:  0.70, z: 0.75, radius: 0.07 },

  // Short drops — change of pace. Force a player who was expecting deep
  // to lunge forward.
  { name: 'short_middle',         x:  0.00, z: 0.30, radius: 0.10 },
  { name: 'short_wide_left',      x: -0.45, z: 0.30, radius: 0.08 },
  { name: 'short_wide_right',     x:  0.45, z: 0.30, radius: 0.08 },

  // Body shot — aim AT the player's likely torso position (jam them,
  // hard to decide forehand vs backhand). Resolved at pick-time using
  // player_xz, not from this fixed table.
  { name: 'body_jam',             x:  0.00, z: 0.90, radius: 0.10, jam: true },

  // Elbow / crossover shots — the single most exploited placement in
  // high-level TT. Not the corner, not the body — the transition seam
  // between forehand and backhand grip. Forces a fraction-of-a-second
  // grip decision that even Pros hesitate on. Resolved at pick-time as
  // player_xz.x ± 0.18 (roughly at the dominant elbow line).
  //
  // We don't know player handedness, so we offer both directions and
  // the picker's distance/wrong-footing weighting will prefer whichever
  // is farther from the player's current lateral position.
  { name: 'elbow_right',          x:  0.18, z: 0.90, radius: 0.06, elbow: 'right' },
  { name: 'elbow_left',           x: -0.18, z: 0.90, radius: 0.06, elbow: 'left'  },
]);

// Recommended per-difficulty probability of picking a tactical zone
// instead of the engine's default (neutral mirror / heatmap exploit).
//
// Beginner sits at 0.10. It was dropped to 0.03 ("real beginners have zero
// placement awareness") back when the tier was framed as a raw novice — but
// the tier is SHOWN as CLUB, and a club player absolutely places some balls
// on purpose: not every ball, not a plan, but a deliberate wide or deep one
// every couple of rallies. 10% reads as occasional intent without blurring
// the gap to the international tier's every-ball-is-placed 0.50. (0.15 was
// tried historically and DID blur the gap — that ceiling is why this isn't
// higher.)
//
// Intermediate is the international tier: at that level essentially every ball
// is placed with intent — corner, wide, short, body jam or elbow seam — so half
// of all shots come from this curated menu.
//
// Pro is deliberately LOWER, not higher. Tactical placement and the struggle
// heatmap are alternatives, not additives: a shot routed here is a shot NOT
// routed to the heatmap. Pro at 0.55 meant its personalised-punishment share
// was (1 - 0.55) x 0.92 = 0.414, BELOW intermediate's 0.425 — the top tier
// exploited the player's weaknesses less than the tier under it.
//
// Dropping pro to 0.42 (with exploit at 0.95) puts its heatmap share at 0.55.
// The tiers now differ in kind: intermediate plays generically good placement,
// pro plays what it has learned about YOU.
export const TACTICAL_PROBABILITY_BY_DIFFICULTY = Object.freeze({
  beginner:     0.10,
  intermediate: 0.50,
  pro:          0.42,
});

function gaussian01(rng) {
  let u, v, s;
  do {
    u = rng() * 2 - 1;
    v = rng() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  return u * Math.sqrt(-2 * Math.log(s) / s);
}

// Weight a zone by:
//   1. Distance from the player. Farther = harder to reach = better.
//   2. Wrong-footing bonus. If the player is moving right (positive
//      paddleVelocity.x), zones on the LEFT get bonus weight — the
//      player has to reverse direction to reach them.
//   3. Anti-repeat. If a zone appears in the caller-supplied recentZoneNames
//      list, its weight is halved. The window length belongs to the CALLER,
//      not to this module — beginner keeps 2, intermediate 3, pro 4.
const DIST_WEIGHT     = 1.5;
const MAX_TABLE_DIST  = 1.7;
const WRONG_FOOT_GAIN = 0.6;
const REPEAT_HALVE    = 0.5;

// --- Player anticipation ----------------------------------------------------
//
// Where the player will BE when the ball arrives, not where they are now.
//
// Aiming away from a player's CURRENT position is only good placement if they
// are standing still. Against a moving player it is actively wrong: they are
// already travelling toward the space you just picked. Projecting them forward
// first makes "away from the player" mean "behind their momentum", which is
// what wrong-footing actually is.
//
// This lives here because tacticalZones is the module that already reasons
// about player position and movement; the engines import it for their neutral
// and heatmap branches too, which previously ignored velocity entirely and so
// diluted the whole wrong-footing effect to about a third of its strength.
//
// Lead time is roughly AI contact → player contact at rally pace. The cap
// stops a single noisy velocity sample from projecting the player off the
// table — the EMA in aiMatch already smooths it, this is belt-and-braces.
const ANTICIPATION_LEAD_S = 0.35;
const ANTICIPATION_MAX_M  = 0.35;

export function anticipatePlayerXZ(playerXZ, playerVelocityXZ) {
  if (!playerXZ) return null;
  if (!playerVelocityXZ) return playerXZ;
  const vx = Number.isFinite(playerVelocityXZ.x) ? playerVelocityXZ.x : 0;
  const vz = Number.isFinite(playerVelocityXZ.z) ? playerVelocityXZ.z : 0;
  const dx = Math.max(-ANTICIPATION_MAX_M, Math.min(ANTICIPATION_MAX_M, vx * ANTICIPATION_LEAD_S));
  const dz = Math.max(-ANTICIPATION_MAX_M, Math.min(ANTICIPATION_MAX_M, vz * ANTICIPATION_LEAD_S));
  return { x: playerXZ.x + dx, z: playerXZ.z + dz };
}

function computeZoneWeights(zones, playerXZ, playerVelocityXZ, recentZoneNames) {
  const px = playerXZ ? playerXZ.x : 0;
  const pz = playerXZ ? playerXZ.z : 0.7; // assume player near mid-depth if unknown
  const vx = (playerVelocityXZ && Number.isFinite(playerVelocityXZ.x)) ? playerVelocityXZ.x : 0;

  const out = new Array(zones.length);
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    // Resolve body-jam and elbow zones to the player's actual XZ.
    // Body: aim at their torso. Elbow: aim 18cm to one side of them
    // (the seam between forehand and backhand grip transitions).
    let targetX = z.x;
    let targetZ = z.z;
    if (z.jam && playerXZ) {
      targetX = playerXZ.x;
      targetZ = Math.min(1.2, Math.max(0.5, playerXZ.z));
    } else if (z.elbow && playerXZ) {
      const off = z.elbow === 'right' ? 0.18 : -0.18;
      targetX = playerXZ.x + off;
      targetZ = Math.min(1.2, Math.max(0.5, playerXZ.z));
    }
    // Distance factor — normalized to MAX_TABLE_DIST.
    const dx = targetX - px;
    const dz = targetZ - pz;
    const dist = Math.hypot(dx, dz);
    const distFactor = 1 + DIST_WEIGHT * Math.min(1, dist / MAX_TABLE_DIST);
    // Wrong-footing factor — targeting opposite of player's lateral
    // movement direction gets a bonus.
    let wrongFoot = 1;
    if (Math.abs(vx) > 0.15) { // ignore micro-jitter
      const targetSign = targetX >= 0 ? 1 : -1;
      const moveSign   = vx        >= 0 ? 1 : -1;
      // Reward when signs differ (target opposite of movement).
      if (targetSign !== moveSign) {
        wrongFoot = 1 + WRONG_FOOT_GAIN * Math.min(1, Math.abs(vx) / 1.5);
      }
    }
    // Anti-repeat factor — halve if the zone appeared in recent picks.
    const recentHit = recentZoneNames && recentZoneNames.includes(z.name);
    const repeatFactor = recentHit ? REPEAT_HALVE : 1;

    out[i] = distFactor * wrongFoot * repeatFactor;
  }
  return out;
}

function weightedSampleIndex(weights, rng) {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return -1;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// Pick a tactical zone target. Returns { target: [x, z], name }. The caller
// adds jitter downstream, but this function also samples inside the zone's
// soft radius so multiple picks of the same zone don't produce identical
// targets.
//
// It cannot currently return null, though the signature once advertised that
// and all three engines still guard with `if (pick)`. Every factor in
// computeZoneWeights is strictly positive (distFactor >= 1, wrongFoot >= 1,
// repeatFactor >= 0.5), so the weighted sample always finds a zone. The guards
// are kept as cheap insurance against that invariant changing — but do not
// write code that RELIES on a null here.
export function pickTacticalTarget(rng, playerXZ, playerVelocityXZ, recentZoneNames) {
  const zones = TACTICAL_ZONES;
  const weights = computeZoneWeights(zones, playerXZ, playerVelocityXZ, recentZoneNames);
  const idx = weightedSampleIndex(weights, rng);
  if (idx < 0) return null;
  const zone = zones[idx];
  // Resolve body-jam and elbow zones at emit time so target tracks current player pose.
  let cx = zone.x;
  let cz = zone.z;
  if (zone.jam && playerXZ) {
    cx = playerXZ.x;
    cz = Math.min(1.2, Math.max(0.5, playerXZ.z));
  } else if (zone.elbow && playerXZ) {
    const off = zone.elbow === 'right' ? 0.18 : -0.18;
    cx = playerXZ.x + off;
    cz = Math.min(1.2, Math.max(0.5, playerXZ.z));
  }
  const r = zone.radius;
  // Circular gaussian jitter, radius clamped so it stays inside the zone.
  const jx = gaussian01(rng) * r * 0.5;
  const jz = gaussian01(rng) * r * 0.5;
  return {
    target: [cx + jx, cz + jz],
    name: zone.name,
  };
}
