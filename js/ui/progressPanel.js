// The start page's "Your progress" section — reads js/profile/progress.js and
// fills the static markup in index.html.
//
// Flat page only, never drawn in the headset: it renders on page load and
// again when an XR session ends (the overlay coming back), so it costs the
// game nothing while a ball is in play.
//
// textContent / createElementNS throughout — no innerHTML, so a hand-edited
// localStorage entry cannot inject markup.

import { summarizeProgress, KINDS } from '../profile/progress.js';

// The AI's internal ids, under the names the wrist menu shows.
const AI_LEVEL_LABELS = Object.freeze({
  beginner: 'Club',
  intermediate: 'International',
  pro: 'Elite',
});

const SVG_NS = 'http://www.w3.org/2000/svg';

function $(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch (e) {
    return '';
  }
}

/**
 * Sparkline into an <svg viewBox="0 0 100 30" preserveAspectRatio="none">,
 * fitted to the values' own range: on a fixed 0–100 axis a 52 → 71 climb in a
 * 40px-tall strip reads as a flat line. The first and latest values are printed in the label.
 */
function drawSparkline(svg, values, labelEl, labelText, unit) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!values || values.length < 2) {
    svg.setAttribute('hidden', '');
    if (labelEl) labelEl.textContent = '';
    return;
  }
  svg.removeAttribute('hidden');
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  // A flat series still needs a span to divide by; centre it.
  if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }
  const step = 100 / (values.length - 1);
  const pts = values.map((v, i) => {
    const y = 27 - ((v - lo) / (hi - lo)) * 24;
    return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
  });
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', pts.join(' '));
  line.setAttribute('class', 'spark-line');
  svg.appendChild(line);
  if (labelEl) {
    labelEl.textContent =
      `${labelText} · ${values[0]}${unit} → ${values[values.length - 1]}${unit}`;
  }
}

function recentLine(e) {
  const date = formatDate(e.date);
  if (e.kind === KINDS.AI) {
    const level = AI_LEVEL_LABELS[e.difficulty] || e.difficulty;
    const result = `${e.won ? 'Won' : 'Lost'} ${e.playerGames}-${e.aiGames}`;
    return `${date} · AI ${level} · ${result} · ${e.accuracyPct}% accuracy`;
  }
  return `${date} · Training (${e.levelLabel}) · Score ${e.score}`;
}

export function renderProgress() {
  const section = $('progress');
  if (!section) return;
  const view = summarizeProgress();

  $('progress-empty').hidden = !view.empty;
  $('progress-body').hidden = view.empty;
  if (view.empty) return;

  const ai = view.ai;
  $('progress-ai-none').hidden = !!ai;
  $('progress-ai-stats').hidden = !ai;
  if (ai) {
    setText('progress-ai-record', `Played ${ai.played} · Won ${ai.won}`);
    setText('progress-ai-accuracy', `${ai.lastAccuracy}%`);
    const delta = $('progress-ai-delta');
    if (delta) {
      if (ai.accuracyDelta === null || ai.accuracyDelta === 0) {
        delta.textContent = ai.accuracyDelta === 0 ? '= same as last' : '';
        delta.className = 'delta';
      } else {
        const up = ai.accuracyDelta > 0;
        delta.textContent = `${up ? '▲ +' : '▼ '}${ai.accuracyDelta} vs last`;
        delta.className = `delta ${up ? 'up' : 'down'}`;
      }
    }
    setText('progress-ai-speed', `${ai.bestSpeedKmh} km/h`);
    drawSparkline($('progress-ai-spark'), ai.accuracyTrend,
      $('progress-ai-spark-label'), 'Accuracy, last 10 matches', '%');
  }

  const tr = view.training;
  $('progress-tr-none').hidden = !!tr;
  $('progress-tr-stats').hidden = !tr;
  if (tr) {
    setText('progress-tr-level', `${tr.levelLabel} level · ${tr.played} session${tr.played === 1 ? '' : 's'}`);
    setText('progress-tr-last', String(tr.lastScore));
    setText('progress-tr-best', String(tr.bestScore));
    setText('progress-tr-weakest', tr.weakestLabel || '—');
    drawSparkline($('progress-tr-spark'), tr.scoreTrend,
      $('progress-tr-spark-label'), 'Score, last 10 sessions', '');
  }

  const list = $('progress-recent');
  if (list) {
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const e of view.recent) {
      const li = document.createElement('li');
      li.textContent = recentLine(e);
      list.appendChild(li);
    }
  }
}

/** Never lets a progress-render bug break the start page. */
export function refreshProgress() {
  try {
    renderProgress();
  } catch (e) {
    console.warn('[progress] render failed', e);
  }
}
