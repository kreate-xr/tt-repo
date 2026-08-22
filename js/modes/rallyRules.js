// The ITTF rally rules, as one pure state machine.
//
// WHY THIS EXISTS: the AI match (aiMatch/rallyManager.js) and multiplayer
// (multiplayer/matchModel.js createRallyTracker) each grew their own copy of
// "who won this rally", and they disagreed — multiplayer ended the point on
// any net contact (not a rule), had no service-legality test, no let, and no
// own-side-bounce rule. Two implementations of one rulebook is a bug factory:
// a player who learns the game in one mode is wrong in the other. Everything
// that decides a RALLY now lives here, once.
//
// What stays with the callers: scoring, serve rotation, game/match end,
// timers, ball spawning, networking. This module only ever answers "did that
// event end the rally, and how".
//
// SIDES. The machine is geometric, not player-centric: `near` owns +Z (the
// larger tableBox.z), `far` owns -Z. Callers name the sides themselves —
// the AI match passes ('player', 'ai'), multiplayer passes ('self',
// 'opponent') — and get their own labels back in every verdict.
//
// VERDICTS. Every register* call returns one of:
//   null                        — rally continues
//   { let: true }               — replay, no point (net-cord serve landed good)
//   { winner, reason, detail, foul }
// `foul` names the side that broke a rule rather than simply missing, and is
// null for ordinary outcomes. Callers use it to announce a fault AS a fault.
//
// Reasons: serveFault · ownSideBounce · doubleBounce · illegalVolley ·
//          ballOut · doubleHit · netTouch · ballLost

import { checkServeContact, classifyPreBounceContact } from './aiMatch/ittfFaults.js';

// Two contacts by the same side closer together than this are treated as ONE
// physical contact, not an ITTF double hit. The physics layer already has a
// 50 ms re-collision cooldown (HIT_COOLDOWN), but one intended stroke can
// still register twice a little beyond it — a slow scooping swing where the
// ball skids along the rubber, or a wristy flick whose swept test catches the
// blade twice. A genuine second stroke takes longer than this to wind up, so
// the threshold buys back the false positives at no cost to the real rule.
export const DOUBLE_HIT_MIN_GAP_MS = 150;

function defaultNow() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

// `getGeometry` returns the live table geometry — it's a function because
// tableBox/tableSurfaceY are module-level bindings that stay null until the
// models load, and a rally manager may outlive a scene rebuild. Shape:
//   { tableBox, tableSurfaceY, centerZ, gravity }
// Everything is optional; the rules that need a piece of geometry simply
// don't fire when it's missing (an unjudgeable event must not cost a point).
export function createRallyRules({
  near = 'near',
  far = 'far',
  getGeometry = () => ({}),
  now = defaultNow,
} = {}) {
  let active = false;
  let lastHitter = null;      // side label | null
  let server = null;          // side label | null — who is serving this rally
  let lastHitAt = 0;
  // Bounces on each side since the OPPONENT of that side last struck. A
  // side's own stroke does not clear its own counter, which is what keeps a
  // double hit from looking like a volley.
  const bounces = { [near]: 0, [far]: 0 };
  const hits = { [near]: 0, [far]: 0 };
  // Bounces of any kind since the last stroke — the double-hit test.
  let bouncesSinceHit = 0;
  // Serve-stroke bookkeeping: the stroke runs from the server's contact until
  // the serve either completes legally or faults.
  let serveStroke = false;
  let serveOwnBounceSeen = false;
  let serveNetTouched = false;

  const other = (side) => (side === near ? far : near);

  function geometry() {
    const g = getGeometry() || {};
    const tableBox = g.tableBox || null;
    return {
      tableBox,
      tableSurfaceY: g.tableSurfaceY ?? 0,
      centerZ: g.centerZ ?? (tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0),
      gravity: g.gravity ?? -9.81,
    };
  }

  // Which side of the table a Z coordinate belongs to.
  function sideOfZ(z) {
    return z < geometry().centerZ ? far : near;
  }

  const point = (winner, reason, detail = null, foul = null) =>
    ({ winner, reason, detail, foul });

  // Start a fresh rally. `server` may be null when the caller genuinely
  // doesn't know (a headless harness driving bounces directly); the service
  // rules then simply don't apply.
  function beginRally({ server: srv = null } = {}) {
    active = false;
    lastHitter = null;
    server = srv;
    lastHitAt = 0;
    bounces[near] = 0;
    bounces[far] = 0;
    hits[near] = 0;
    hits[far] = 0;
    bouncesSinceHit = 0;
    serveStroke = false;
    serveOwnBounceSeen = false;
    serveNetTouched = false;
  }

  // For a serve that never produces a paddle-hit event — the AI match's
  // scripted serve spawns the ball already moving. Puts the machine in the
  // state a real serve stroke would have left it in.
  function armServeStroke(side) {
    active = true;
    lastHitter = side;
    server = side;
    bounces[near] = 0;
    bounces[far] = 0;
    bouncesSinceHit = 0;
    serveStroke = true;
    serveOwnBounceSeen = false;
    serveNetTouched = false;
  }

  // A paddle contact. `contactPos` / `inVel` are the ball's position and
  // incoming velocity at contact (ball.js ships both on every paddleHit);
  // without them the contact-time rules stand down.
  //
  // `assumeServeBounced` credits a serve stroke with its required own-half
  // bounce up front. It exists for multiplayer: the receiving peer only
  // starts integrating the ball when the handoff packet lands, so on a slow
  // link it can miss the server's own-half bounce entirely and then read a
  // perfectly legal serve as one that skipped their half. We can only judge
  // what we saw, and the cost of standing down is a rare uncalled fault
  // rather than a point taken from someone who did nothing wrong.
  function registerHit(side, {
    contactPos = null, inVel = null, at = null, assumeServeBounced = false,
  } = {}) {
    const t = at === null ? now() : at;
    const opponent = other(side);
    const { tableBox, tableSurfaceY, gravity } = geometry();

    // Read the pre-contact state before the bookkeeping overwrites it.
    const isServeStroke = side === server && hits[near] === 0 && hits[far] === 0;
    const bouncesOnStrikerSide = bounces[side];
    const struckAfterOpponent = lastHitter === opponent;
    const repeatStrike = lastHitter === side && bouncesSinceHit === 0;
    const sinceLastHit = t - lastHitAt;

    serveStroke = isServeStroke;
    serveOwnBounceSeen = isServeStroke && assumeServeBounced;
    serveNetTouched = false;
    lastHitter = side;
    lastHitAt = t;
    active = true;
    hits[side] += 1;
    bouncesSinceHit = 0;
    // Only the side the ball is now heading toward gets its counter cleared.
    bounces[opponent] = 0;

    // The geometry helpers work in near/far terms, not in our side names.
    const isNear = side === near;

    // Law 2.6 — where the serve was struck from.
    if (isServeStroke) {
      const detail = checkServeContact({ contactPos, tableBox, tableSurfaceY, isNear });
      return detail ? point(opponent, 'serveFault', detail, side) : null;
    }

    // Law 2.10 — striking the ball twice successively.
    if (repeatStrike && sinceLastHit >= DOUBLE_HIT_MIN_GAP_MS) {
      return point(opponent, 'doubleHit', null, side);
    }

    // Law 2.5.7 — obstruction. Only judgeable when we watched the opponent
    // put the ball here; otherwise we have no idea how it arrived.
    if (struckAfterOpponent && bouncesOnStrikerSide === 0) {
      const verdict = classifyPreBounceContact({
        contactPos, inVel, tableBox, tableSurfaceY, isNear, gravity,
      });
      if (verdict === 'volley') return point(opponent, 'illegalVolley', null, side);
      // The opponent's shot had already cleared the end line — their loss the
      // moment it did, whatever the striker then did with it. Scored here so
      // the swat isn't later mistaken for the striker's own shot going out.
      if (verdict === 'out') return point(side, 'ballOut', 'out', null);
    }
    return null;
  }

  function registerBounce({ z = 0 } = {}) {
    if (!active || !lastHitter) return null;
    const side = sideOfZ(z);
    const opponent = other(lastHitter);
    bouncesSinceHit += 1;

    if (side === lastHitter) {
      // The serve's required first bounce on the server's own half.
      if (serveStroke && !serveOwnBounceSeen && !serveNetTouched) {
        serveOwnBounceSeen = true;
        return null;
      }
      // A serve that died on the server's half (a second own bounce, or it
      // fell back off the net), or a rally return that touched the hitter's
      // own court — either way the hitter loses.
      return point(opponent, serveStroke ? 'serveFault' : 'ownSideBounce');
    }

    if (serveStroke) {
      // Reached the receiver without touching the server's half first.
      if (!serveOwnBounceSeen) return point(opponent, 'serveFault');
      // Clipped the cord and still arrived legally — replay.
      if (serveNetTouched) return { let: true };
      serveStroke = false; // serve complete, rally live
    }

    // We're on the receiving side by definition here (side !== lastHitter),
    // so two bounces means the receiver never got a racket on it.
    bounces[side] += 1;
    if (bounces[side] >= 2) return point(lastHitter, 'doubleBounce');
    return null;
  }

  // The ball touched the net assembly in flight. Never a point by itself —
  // the cord ball can dribble over and play on, and where it comes down
  // decides. Recorded only so a cord SERVE that lands good becomes a let.
  function registerNetHit() {
    if (active && serveStroke) serveNetTouched = true;
    return null;
  }

  // Law 2.10 — a player, or anything they wear or carry, touches the net
  // assembly while the ball is in play. Unlike every other rule here this one
  // isn't about the ball at all, so the caller detects it (see netTouch.js)
  // and reports it.
  function registerNetTouch(side) {
    if (!active) return null;
    return point(other(side), 'netTouch', null, side);
  }

  function registerBallLost() {
    if (!active) return null;
    if (!lastHitter) {
      // Nobody ever struck it — a whiffed serve toss. The receiver takes it.
      return server ? point(other(server), 'ballLost', 'serveMiss') : null;
    }
    const opponent = other(lastHitter);
    // No bounce on the far side means the last shot never landed → it went
    // out or short. A bounce there means the receiver failed to return it.
    const wentOut = bounces[opponent] === 0;
    return wentOut
      ? point(opponent, 'ballLost', 'out')
      : point(lastHitter, 'ballLost', 'missedReturn');
  }

  return {
    beginRally,
    armServeStroke,
    registerHit,
    registerBounce,
    registerNetHit,
    registerNetTouch,
    registerBallLost,
    sideOfZ,
    isActive: () => active,
    getLastHitter: () => lastHitter,
    getServer: () => server,
    hitsBy: (side) => hits[side] || 0,
    bouncesOn: (side) => bounces[side] || 0,
    isServeStrokeActive: () => serveStroke,
  };
}
