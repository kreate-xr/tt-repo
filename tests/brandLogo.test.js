// Brand-mark pixel conditioning — the part of brandLogo.js that has to be
// right for the SportyXR logo to survive being pasted onto dark geometry.
//
// public/logo.webp is an opaque VP8 plate: black "Sporty" + blue-violet
// "XR" on white, with padding. The conversion has to knock the plate out
// to transparent, lift the black half to white (it is invisible on a dark
// barrier otherwise), leave the colored half alone, and report the mark's
// own aspect rather than the padded asset's. Canvas/Image are absent under
// the node test environment, so the two pure passes are exercised directly
// with hand-built RGBA.

const { recolorToBrandInk, inkBounds } = require('../js/scene/brandLogo.js');

const px = (...bytes) => Uint8ClampedArray.from(bytes);

test('the opaque white plate becomes fully transparent', () => {
  const out = recolorToBrandInk(px(255, 255, 255, 255));
  expect(out[3]).toBe(0);
});

test('black wordmark ink becomes opaque WHITE ink', () => {
  const out = recolorToBrandInk(px(0, 0, 0, 255));
  expect(out[3]).toBe(255);
  // The whole point: repainted, or it vanishes against ROOM.WALL_COLOR.
  expect([out[0], out[1], out[2]]).toEqual([255, 255, 255]);
});

test('the saturated XR gradient keeps its authored color at full strength', () => {
  // A mid-luminance brand blue. A luminance-based alpha rule would fade
  // this to roughly half; the min() rule keeps it near-opaque.
  const out = recolorToBrandInk(px(43, 127, 255, 255));
  expect(out[3]).toBe(255 - 43);
  expect(out[3]).toBeGreaterThan(200);
  expect([out[0], out[1], out[2]]).toEqual([43, 127, 255]);
});

test('antialiased grey edges become partially-transparent white', () => {
  const out = recolorToBrandInk(px(128, 128, 128, 255));
  expect(out[3]).toBe(127);
  expect([out[0], out[1], out[2]]).toEqual([255, 255, 255]);
});

test('an already-transparent source pixel stays transparent', () => {
  // Today's asset has no alpha channel, so this guards the replacement
  // case: a black-on-transparent PNG must not have its clear background
  // promoted to opaque white ink.
  const out = recolorToBrandInk(px(0, 0, 0, 0));
  expect(out[3]).toBe(0);
});

test('trim box is the tight inclusive bounds of the ink', () => {
  // 4x3 of clear plate with two ink pixels at (1,1) and (2,2).
  const rgba = new Uint8ClampedArray(4 * 3 * 4);
  rgba[(1 * 4 + 1) * 4 + 3] = 255;
  rgba[(2 * 4 + 2) * 4 + 3] = 255;
  expect(inkBounds(rgba, 4, 3)).toEqual({ x0: 1, y0: 1, x1: 2, y1: 2 });
});

test('codec ringing below the ink threshold does not widen the trim', () => {
  const rgba = new Uint8ClampedArray(4 * 3 * 4);
  rgba[(1 * 4 + 1) * 4 + 3] = 255;
  rgba[(0 * 4 + 0) * 4 + 3] = 8;   // faint ringing in the corner
  expect(inkBounds(rgba, 4, 3)).toEqual({ x0: 1, y0: 1, x1: 1, y1: 1 });
});

test('an all-clear image yields null rather than an empty box', () => {
  expect(inkBounds(new Uint8ClampedArray(4 * 3 * 4), 4, 3)).toBeNull();
});

test('trimming a padded plate recovers the mark aspect, not the asset aspect', () => {
  // A 20x20 white plate carrying a 10x4 black mark — the shape of the real
  // asset's problem (394x235 file, far wider mark). Callers size geometry
  // off this aspect, so a padded measurement would print the mark small
  // and floating in dead space.
  const w = 20, h = 20;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = 255;
  }
  for (let y = 8; y < 12; y++) {
    for (let x = 5; x < 15; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0;
    }
  }
  recolorToBrandInk(rgba);
  const box = inkBounds(rgba, w, h);
  expect(box).toEqual({ x0: 5, y0: 8, x1: 14, y1: 11 });
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  expect(bw / bh).toBeCloseTo(2.5);
  expect(bw / bh).not.toBeCloseTo(w / h);
});
