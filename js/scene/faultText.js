// Player-facing fault copy.
//
// faultRuleText — full-sentence rule statements for the 2D HUD log, shown
// when the LOCAL player commits a fault. States the rule, not just the
// verdict. Returns '' for ordinary outcomes.
//
// faultCue — the short in-headset version for the over-net FOUL call
// (pointBurst.js): what went wrong and the one thing to change.
export function faultRuleText(reason, detail = null) {
  if (reason === 'illegalVolley') {
    return 'illegal volley — ITTF: you may only strike the ball after it has bounced on your own half.';
  }
  if (reason === 'serveFault') {
    if (detail === 'overTable') {
      return 'serve struck over the table — ITTF: the ball must be behind your end line until you hit it.';
    }
    if (detail === 'belowTable') {
      return 'serve struck below the table — ITTF: the ball must stay above the playing surface until you hit it.';
    }
    if (detail === 'lowToss') {
      return 'service fault — ITTF: the toss must rise at least 16 cm from your open palm before you strike.';
    }
    if (detail === 'noOwnBounce') {
      return 'serve fault — ITTF: the serve must bounce on your own half first, then cross the net.';
    }
    if (detail === 'doubleOwnBounce') {
      return 'serve fault — the serve bounced on your half and never crossed the net.';
    }
    if (detail === 'net') {
      return "serve fault — the serve hit the net and did not land on the opponent's half.";
    }
    if (detail === 'missedHalf') {
      return "serve fault — ITTF: after your own half, the serve must bounce on the opponent's half.";
    }
    return 'serve fault — the serve must bounce on your half, then the opponent\'s.';
  }
  if (reason === 'ballLost' && detail === 'serveMiss') {
    return 'service fault — the paddle missed the ball on the serve.';
  }
  return '';
}

// The full rule above is too long to read in the ~2 s before the next serve;
// this is the glanceable version, so a player stops repeating the same fault.
// Keep both lines short — they render on one line each over the net.
const FAULT_CUES = {
  serveFault: {
    overTable:       { reason: 'Serve hit over the table',         tip: 'Toss and strike from behind your end line' },
    belowTable:      { reason: 'Serve hit below table height',     tip: 'Strike the ball above the table surface' },
    lowToss:         { reason: 'Toss too low',                     tip: 'Toss the ball up at least 16 cm first' },
    noOwnBounce:     { reason: "Serve didn't bounce on your side", tip: 'Hit it so it lands on YOUR half first' },
    doubleOwnBounce: { reason: "Serve didn't cross the net",       tip: 'Hit a little harder to clear the net' },
    net:             { reason: 'Serve hit the net',                tip: 'Aim a little higher over the net' },
    missedHalf:      { reason: "Serve missed the opponent's half", tip: "Softer — land it on the opponent's half" },
    _:               { reason: 'Serve fault',                      tip: 'Bounce on your half, then theirs' },
  },
  ballLost: {
    serveMiss:       { reason: 'Missed the ball on the serve',     tip: 'Watch the ball onto the paddle' },
  },
  illegalVolley: {
    _:               { reason: 'Hit before it bounced',            tip: 'Let it bounce on your side first' },
  },
  doubleHit: {
    _:               { reason: 'Ball hit twice',                   tip: 'One touch per shot' },
  },
  netTouch: {
    _:               { reason: 'Touched the net',                  tip: 'Keep the paddle and hand off the net' },
  },
};

// { reason, tip } for a fault, null for an ordinary outcome.
export function faultCue(reason, detail = null) {
  const byDetail = FAULT_CUES[reason];
  if (!byDetail) return null;
  return byDetail[detail] || byDetail._ || null;
}

// Not a fault yet: the first short toss is a warning and a retake.
export const LOW_TOSS_WARNING_CUE = {
  reason: 'Toss too low — retake',
  tip: 'At least 16 cm up. Next short toss is a fault',
};

// Multiplayer guest: the host's Foul Rules setting just reached us.
export const FOULS_OFF_NOTICE_CUE = {
  reason: 'Foul rules OFF — free play',
  tip: "The host's setting. Only out / missed balls score",
};
export const FOULS_ON_NOTICE_CUE = {
  reason: 'Foul rules ON',
  tip: "The host's setting. ITTF faults are called",
};
