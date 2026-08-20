// Player-facing fault copy for the 2D HUD log.
//
// Full-sentence rule statements shown when the LOCAL player commits a fault.
// The HUD log is where a player goes to find out WHY after the fact, so this
// states the rule, not just the verdict. Returns '' for ordinary outcomes.
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
    return 'serve fault — the serve must bounce on your half, then the opponent\'s.';
  }
  return '';
}
