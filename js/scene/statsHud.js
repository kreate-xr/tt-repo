// Per-drill live stats + end-of-set summary panel.
// DOM-based; rendered via WebXR dom-overlay during MR sessions and over the
// canvas in desktop preview.

let liveLineEl = null;
let summaryEl = null;
// Last string written to the live line. setLiveLine is called every XR frame
// by the in-game loop; without this equality gate it replaced the DOM text
// node and dirtied style at 72–90 Hz even when nothing changed.
let lastLiveLineText = null;

export function initStatsHud() {
  if (!liveLineEl) {
    liveLineEl = document.createElement('div');
    liveLineEl.id = 'training-live-stats';
    liveLineEl.style.cssText = `
      position: fixed; top: 14px; right: 14px;
      font: 600 14px/1.3 'Segoe UI', system-ui, sans-serif;
      color: #00ff88; background: rgba(0,0,0,0.62);
      padding: 8px 12px; border-radius: 8px;
      border: 1px solid rgba(0,255,136,0.25);
      pointer-events: none; z-index: 9998;
      letter-spacing: 0.02em;
    `;
    liveLineEl.textContent = '';
    liveLineEl.style.display = 'none';
    document.body.appendChild(liveLineEl);
  }

  if (!summaryEl) {
    summaryEl = document.createElement('div');
    summaryEl.id = 'training-summary';
    summaryEl.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      min-width: 320px; max-width: 480px;
      padding: 22px 26px;
      background: rgba(0,0,0,0.86);
      border: 1px solid rgba(0,255,136,0.35);
      border-radius: 16px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      color: #fff;
      z-index: 9999;
      display: none;
    `;
    document.body.appendChild(summaryEl);
  }
}

export function setLiveLine(text) {
  if (text === lastLiveLineText) return;
  if (!liveLineEl) initStatsHud();
  lastLiveLineText = text;
  liveLineEl.style.display = 'block';
  liveLineEl.textContent = text;
}

export function hideLiveLine() {
  if (liveLineEl) liveLineEl.style.display = 'none';
  // Forget the cached text so the next setLiveLine always re-shows the
  // element even if the string happens to match the pre-hide one.
  lastLiveLineText = null;
}

/**
 * End-of-set panel, fed by the M7 event log's summary() (plus the display
 * labels inGame adds). One source of truth: these are the same numbers
 * Review & Stats analyses, so the panel and the review can never disagree
 * about how a session went — which is exactly how the old SessionStats
 * copy drifted (drills that fed the log but not the stats showed zeros).
 */
export function showSummary(summary, { onRetry, onChangeDrill, onExit }) {
  if (!summaryEl) initStatsHud();

  const dur = ((summary.durationMs || 0) / 1000).toFixed(1);
  const returnPct = Math.round((summary.returnRate || 0) * 100);
  const rows = [
    ['Balls fed', `${summary.feeds ?? 0}`],
    ['Returned', `${summary.returned ?? 0} (${returnPct}%)`],
    ['Missed', `${summary.missed ?? 0}`],
    ['Errors', `${summary.errored ?? 0}`],
    ['Longest streak', `${summary.longestRally ?? 0}`],
  ];

  summaryEl.innerHTML = `
    <h2 style="margin:0 0 10px 0;color:#00ff88;font-size:1.4rem;">Set Complete</h2>
    <div style="color:#aaa;font-size:0.9rem;margin-bottom:14px;">
      ${summary.drillLabel || summary.drillId || 'Drill'} · ${summary.difficultyLabel || ''} · ${dur}s
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;font-size:1rem;margin-bottom:14px;">
      ${rows.map(([label, value]) =>
    `<div>${label}</div><div style="text-align:right;font-weight:600;">${value}</div>`).join('')}
    </div>
    <div style="display:flex;gap:10px;justify-content:center;">
      <button data-action="retry" style="padding:9px 18px;border:none;border-radius:8px;background:linear-gradient(135deg,#00ff88,#00aaff);color:#000;font-weight:700;cursor:pointer;">Retry</button>
      <button data-action="change" style="padding:9px 18px;border:1px solid rgba(255,255,255,0.25);border-radius:8px;background:transparent;color:#fff;cursor:pointer;">Change Drill</button>
      <button data-action="exit" style="padding:9px 18px;border:1px solid rgba(255,90,90,0.35);border-radius:8px;background:transparent;color:#ff8888;cursor:pointer;">Exit</button>
    </div>
  `;
  summaryEl.style.display = 'block';
  hideLiveLine();

  summaryEl.querySelector('[data-action="retry"]').onclick = () => { hideSummary(); onRetry?.(); };
  summaryEl.querySelector('[data-action="change"]').onclick = () => { hideSummary(); onChangeDrill?.(); };
  summaryEl.querySelector('[data-action="exit"]').onclick = () => { hideSummary(); onExit?.(); };
}

export function hideSummary() {
  if (summaryEl) summaryEl.style.display = 'none';
}

export function clearStatsHud() {
  hideLiveLine();
  hideSummary();
}
