// ITTF fault geometry — pure predicates, no scene/physics singletons.
//
// rallyManager already scores everything that can be judged from BOUNCES
// (serve landed on the wrong half, double bounce, ball never came back).
// Two ITTF faults can't be judged that way because they are decided at the
// moment of CONTACT, before the ball goes anywhere:
//
//   1. Obstruction / volley (Law 2.5.7) — striking the ball
//      before it has bounced on your own court. In VR this is the single
//      most tempting exploit: stand at the net and swat everything out of
//      the air. Nothing in the bounce bookkeeping can see it, because the
//      ball simply never touches the striker's half.
//
//   2. Service from the wrong place (Law 2.6.1/2.6.2) — the ball must be
//      behind the server's end line and above the level of the playing
//      surface from the last moment it is stationary until it is struck.
//      A headset player can trivially hold the ball over the table and tap
//      it down; the resulting serve bounces own-half-then-far-half and
//      passes every bounce-based test.
//
// Both live here as pure functions of {contact position, incoming velocity,
// table geometry} so they can be unit-tested without a headset, a scene or
// a physics tick.
//
// SIDE CONVENTION. These take a boolean `isNear`, not a side name: +Z is the
// near half, -Z is the far half, and callers name their sides differently
// ('player'/'ai' in the AI match, 'self'/'opponent' in multiplayer). An
// earlier version compared against the literal 'player', which silently
// treated every multiplayer side as the far half and inverted both rules.

// --- Tolerances --------------------------------------------------------------
// These are deliberately LENIENT. A false fault takes a point away from a
// player who did nothing wrong, which is far worse than letting a marginal
// one through — and headset tracking, the 40 mm ball and the courtesy toss
// all put a few centimetres of noise on the contact position.
//
// 12 cm of slack on the end line: the trigger-fallback toss (playerServe.js)
// is released 5 cm behind the line and drifts slightly inward during flight,
// so a late strike legitimately happens a few centimetres inside the line.
// What we are actually catching is the player who reaches out over the table
// — that is a third of a metre of violation, not three centimetres.
export const SERVE_BEHIND_LINE_GRACE_M = 0.12;
// 3 cm below the surface plane before "struck from below the table" trips.
export const SERVE_ABOVE_SURFACE_GRACE_M = 0.03;

// Default only — callers pass the live tuned GRAVITY from physics/constants.
const DEFAULT_GRAVITY = -9.81;

// True when `z` is behind (outside) the side's own end line, within grace.
function isBehindEndLine(z, tableBox, isNear, grace) {
  return isNear
    ? z >= tableBox.max.z - grace
    : z <= tableBox.min.z + grace;
}

// Law 2.6: where the serve was STRUCK from.
//
// Returns null when the contact is legal, otherwise the fault detail string
// that reaches the player as on-panel copy:
//   'overTable'  — struck in front of the end line (over the playing surface)
//   'belowTable' — struck below the level of the playing surface
//
// Returns null (rather than guessing) when the geometry isn't available:
// a missing tableBox or contact position means we cannot judge, and an
// unjudgeable serve must not cost anybody a point.
export function checkServeContact({
  contactPos,
  tableBox,
  tableSurfaceY = 0,
  isNear = true,
  lineGrace = SERVE_BEHIND_LINE_GRACE_M,
  heightGrace = SERVE_ABOVE_SURFACE_GRACE_M,
} = {}) {
  if (!contactPos || !tableBox) return null;
  // Position is checked before height: "you reached over the table" is the
  // more common and more actionable message of the two.
  if (!isBehindEndLine(contactPos.z, tableBox, isNear, lineGrace)) return 'overTable';
  if (contactPos.y < tableSurfaceY - heightGrace) return 'belowTable';
  return null;
}

// A contact made before the ball has bounced on the striker's own half.
//
// This is NOT automatically a fault. ITTF only calls it obstruction when the
// ball was "above or travelling towards the playing surface" — a ball that
// has already sailed past the end line is out, and the point belongs to the
// striker whether or not they then swat it away. That distinction matters
// enormously in a headset: batting away a ball flying at your face is the
// most common reflex there is, and punishing it would feel broken.
//
// So we answer the ITTF question directly — would this ball, left alone,
// have landed on the striker's court?
//
//   'volley' — yes: it was travelling toward the striker's court, so the
//              contact is obstruction and the striker loses the point.
//   'out'    — no: the opponent's shot was already going out, so the point
//              is the striker's regardless of the swat.
//
// The projection is plain ballistics (no drag, no Magnus). Over the
// ~100-300 ms between an interception and where the ball would have landed
// those terms move the landing point by ~1 cm — far inside the margin that
// decides "on the table" vs "half a metre long".
export function classifyPreBounceContact({
  contactPos,
  inVel,
  tableBox,
  tableSurfaceY = 0,
  isNear = true,
  gravity = DEFAULT_GRAVITY,
} = {}) {
  if (!contactPos || !tableBox) return null;
  // No velocity to project with: fall back to the crude test — a ball still
  // short of the end line was heading for the table.
  if (!inVel) {
    return isBehindEndLine(contactPos.z, tableBox, isNear, 0) ? 'out' : 'volley';
  }

  const g = gravity < 0 ? gravity : DEFAULT_GRAVITY;
  // Solve for the surface crossing: ½g·t² + vy·t + (y − surfaceY) = 0.
  const a = 0.5 * g;
  const b = inVel.y;
  const c = contactPos.y - tableSurfaceY;
  const disc = b * b - 4 * a * c;
  // Downward gravity above the surface always has a real descending root;
  // a negative discriminant means the ball is already below table level and
  // rising away from it — nothing to obstruct.
  if (disc < 0) return 'out';
  const sq = Math.sqrt(disc);
  // The two roots straddle the apex; the LATER one is the descending
  // crossing. (2a is negative, so the larger root isn't a fixed branch —
  // take the max rather than assuming a sign.)
  const t = Math.max((-b + sq) / (2 * a), (-b - sq) / (2 * a));
  if (!(t > 0)) return 'out';

  const landX = contactPos.x + inVel.x * t;
  const landZ = contactPos.z + inVel.z * t;
  const centerZ = (tableBox.min.z + tableBox.max.z) / 2;
  const insideFootprint =
    landX >= tableBox.min.x && landX <= tableBox.max.x &&
    landZ >= tableBox.min.z && landZ <= tableBox.max.z;
  // Must be heading for the STRIKER's half specifically. A ball that would
  // come down on the far half hasn't reached the striker's court and can't
  // be obstructed by them.
  const onStrikerHalf = isNear ? landZ >= centerZ : landZ <= centerZ;

  return (insideFootprint && onStrikerHalf) ? 'volley' : 'out';
}
