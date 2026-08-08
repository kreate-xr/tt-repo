"""Re-analyze TTsound.mp3 with a LONG window covering the full bounce tail so
low-frequency (bass) resonances aren't missed. Prior 25 ms window truncated
the sustain where the bass sits.

Reports per-event: attack, decay, band energies over the FULL event,
and the top 8 spectral peaks in a 200 ms window.
Also prints an overall averaged spectrum across all detected events so the
tonal signature is stable.
"""

import os

import numpy as np
import soundfile as sf
from scipy.signal import find_peaks

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "TTsound.mp3")

data, sr = sf.read(PATH, always_2d=False)
if data.ndim > 1:
    data = data.mean(axis=1)
data = data.astype(np.float32)

print(f"sample rate: {sr} Hz   duration: {len(data)/sr:.2f} s   peak={np.max(np.abs(data)):.3f}")
print()

# Envelope
win = max(1, int(sr * 0.002))
env = np.convolve(np.abs(data), np.ones(win)/win, mode="same")

floor = np.percentile(env, 20)
thresh = max(floor * 8, env.max() * 0.25)
peaks, _ = find_peaks(env, height=thresh, distance=int(sr * 0.05))
print(f"detected {len(peaks)} bounces")
print()

# Long window: 200 ms covers full decay incl. bass tail
LONG_MS = 200
seg_len = int(sr * LONG_MS / 1000)

def analyze_event(p):
    start = max(0, p - int(sr * 0.005))     # 5 ms pre-roll
    seg = data[start : start + seg_len]
    if len(seg) < seg_len:
        seg = np.pad(seg, (0, seg_len - len(seg)))
    seg_win = seg * np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg_win))
    freqs = np.fft.rfftfreq(len(seg_win), 1/sr)
    return seg, spec, freqs

def band_energy(spec, freqs, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return float((spec[m]**2).sum())

# Averaged spectrum over ALL events (stable signature)
avg_spec = None
for p in peaks:
    _, spec, freqs = analyze_event(p)
    avg_spec = spec.copy() if avg_spec is None else (avg_spec + spec)
avg_spec /= len(peaks)

total = float((avg_spec**2).sum()) + 1e-12

# Fine-grained band breakdown
bands = [(20,80,'sub'), (80,200,'bass'), (200,400,'low-mid'),
         (400,1000,'mid'), (1000,2500,'body'), (2500,5000,'presence'),
         (5000,8000,'brilliance'), (8000,sr/2,'air')]
print(f"--- averaged spectrum over all {len(peaks)} events, {LONG_MS} ms window ---")
print("band energies (fraction of total):")
for lo, hi, label in bands:
    e = band_energy(avg_spec, freqs, lo, hi) / total
    bar = '#' * int(e * 100)
    print(f"  {label:>12} {lo:>4}-{int(hi):>5} Hz : {e*100:5.1f}%  {bar}")

# Top 12 spectral peaks in averaged spectrum
avg_spec_peaks, _ = find_peaks(avg_spec, height=avg_spec.max()*0.10)
top = sorted(avg_spec_peaks, key=lambda i: -avg_spec[i])[:12]
top_freqs = [(int(round(freqs[i])), round(float(avg_spec[i]/avg_spec.max()), 3))
             for i in top]
print()
print("top 12 spectral peaks (Hz, normalized magnitude):")
for f, m in top_freqs:
    bar = '#' * int(m * 40)
    print(f"  {f:>5} Hz : {m:.3f}  {bar}")

# Log-spaced spectrum shape (dB relative to peak) — quick visual profile
print()
print("--- spectrum shape (dB rel. peak) ---")
for target in [40, 60, 80, 120, 160, 220, 300, 400, 600, 800, 1100, 1500,
               2000, 2600, 3400, 4500, 6000, 8000, 10000]:
    if target < sr / 2:
        idx = int(target * len(avg_spec) * 2 / sr)  # rfft len -> freq mapping
        # correction: freq = idx * sr / N where N=len(seg)  -> idx = f*N/sr
        idx = int(target * seg_len / sr)
        idx = min(idx, len(avg_spec) - 1)
        db = 20 * np.log10(avg_spec[idx] / avg_spec.max() + 1e-12)
        bar = '=' * max(0, int(40 + db))
        print(f"  {target:>5} Hz : {db:6.1f} dB  {bar}")

# Also: energy VS TIME within an event, in each band, to see if bass sits in tail
print()
print("--- band energy vs time (first event, 5 windows of 40 ms) ---")
p0 = peaks[0]
for w in range(5):
    s = p0 - int(sr*0.005) + w * int(sr*0.04)
    seg = data[s : s + int(sr*0.04)] * np.hanning(int(sr*0.04))
    if len(seg) < 32: continue
    spec = np.abs(np.fft.rfft(seg))
    fr = np.fft.rfftfreq(len(seg), 1/sr)
    tot = float((spec**2).sum()) + 1e-12
    def bf(lo, hi):
        m = (fr>=lo)&(fr<hi); return float((spec[m]**2).sum())/tot
    print(f"  t=+{w*40:>3} ms  bass(80-300)={bf(80,300)*100:5.1f}%  "
          f"body(1-2.5k)={bf(1000,2500)*100:5.1f}%  "
          f"air(>5k)={bf(5000, sr/2)*100:5.1f}%")
