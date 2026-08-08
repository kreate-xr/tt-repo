// Per-drill live stats + end-of-set summary panel.
// DOM-based; rendered via WebXR dom-overlay during MR sessions and over the
// canvas in desktop preview.

let liveLineEl = null;
let summaryEl = null;

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
  if (!liveLineEl) initStatsHud();
  liveLineEl.style.display = 'block';
  liveLineEl.textContent = text;
}

export function hideLiveLine() {
  if (liveLineEl) liveLineEl.style.display = 'none';
}

export function showSummary(snapshot, { onRetry, onChangeDrill, onExit }) {
  if (!summaryEl) initStatsHud();

  const dur = snapshot.durationSec.toFixed(1);
  const perSpinRows = Object.entries(snapshot.perSpinResults || {})
    .map(([spin, r]) => `<tr><td style="padding:2px 10px 2px 0;color:#aaa;">${spin}</td><td style="text-align:right;">${r.cleared}/${r.faced}</td></tr>`)
    .join('');

  summaryEl.innerHTML = `
    <h2 style="margin:0 0 10px 0;color:#00ff88;font-size:1.4rem;">Set Complete</h2>
    <div style="color:#aaa;font-size:0.9rem;margin-bottom:14px;">
      ${snapshot.drillId} · ${snapshot.difficulty} · ${dur}s
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;font-size:1rem;margin-bottom:14px;">
      <div>Shots fed</div><div style="text-align:right;font-weight:600;">${snapshot.shotsFed}</div>
      <div>Returned</div><div style="text-align:right;font-weight:600;">${snapshot.shotsReturned} (${snapshot.returnPct}%)</div>
      <div>On-target</div><div style="text-align:right;font-weight:600;">${snapshot.onTarget} (${snapshot.accuracyPct}%)</div>
      <div>Longest streak</div><div style="text-align:right;font-weight:600;">${snapshot.longestStreak}</div>
    </div>
    ${perSpinRows ? `<table style="width:100%;border-top:1px solid rgba(255,255,255,0.12);padding-top:8px;margin-bottom:14px;font-size:0.95rem;">${perSpinRows}</table>` : ''}
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
