// World-to-wearer alignment (js/xr/viewerAlign.js). The table is built along
// the origin's -Z, so the offset space must put -Z exactly where the head
// faces on the floor plane, whatever way the runtime's local-floor points.

const { computeAlignment, createViewerAlign } = require('../js/xr/viewerAlign.js');

const yawQuat = (yaw) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
// Head yawed by `yaw`, then pitched by `pitch` (negative = looking down).
function headQuat(yaw, pitch) {
  const a = yawQuat(yaw);
  const b = { x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) };
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

describe('computeAlignment', () => {
  test('head already facing -Z at origin → identity', () => {
    const a = computeAlignment({ x: 0, y: 1.6, z: 0 }, yawQuat(0));
    expect(a.x).toBe(0);
    expect(a.z).toBe(0);
    expect(a.yaw).toBeCloseTo(0, 6);
  });

  test.each([Math.PI / 2, -Math.PI / 2, 2.5, -3])('recovers head yaw %p', (yaw) => {
    const a = computeAlignment({ x: 0.4, y: 1.6, z: -1.2 }, yawQuat(yaw));
    expect(Math.cos(a.yaw)).toBeCloseTo(Math.cos(yaw), 6);
    expect(Math.sin(a.yaw)).toBeCloseTo(Math.sin(yaw), 6);
    expect(a.x).toBe(0.4);
    expect(a.z).toBe(-1.2);
  });

  test('pitch does not change the yaw', () => {
    const a = computeAlignment({ x: 0, y: 1.6, z: 0 }, headQuat(1.0, -0.6));
    expect(a.yaw).toBeCloseTo(1.0, 6);
  });

  test('looking straight down still yields the facing direction', () => {
    const a = computeAlignment({ x: 0, y: 1.6, z: 0 }, headQuat(-0.8, -Math.PI / 2));
    expect(a.yaw).toBeCloseTo(-0.8, 6);
  });
});

describe('createViewerAlign', () => {
  beforeAll(() => {
    global.XRRigidTransform = function (position, orientation) {
      this.position = position;
      this.orientation = orientation;
    };
  });
  afterAll(() => { delete global.XRRigidTransform; });

  function rig(pose) {
    const set = jest.fn();
    const base = { getOffsetReferenceSpace: jest.fn((t) => ({ offset: t })) };
    const frame = { getViewerPose: jest.fn(() => pose) };
    const onAligned = jest.fn();
    const align = createViewerAlign({ setReferenceSpace: set }, base, onAligned);
    return { set, base, frame, onAligned, align };
  }

  test('aligns once on the first tracked frame, again only on request', () => {
    const r = rig({ transform: { position: { x: 1, y: 1.7, z: 2 }, orientation: yawQuat(0.5) } });
    r.align.update(r.frame);
    r.align.update(r.frame);
    expect(r.set).toHaveBeenCalledTimes(1);
    expect(r.onAligned).toHaveBeenCalledTimes(1);
    const t = r.base.getOffsetReferenceSpace.mock.calls[0][0];
    expect(t.position).toEqual({ x: 1, y: 0, z: 2 });
    expect(t.orientation.y).toBeCloseTo(Math.sin(0.25), 6);

    r.align.request();
    r.align.update(r.frame);
    expect(r.set).toHaveBeenCalledTimes(2);
  });

  test('waits while the viewer pose is unavailable', () => {
    const r = rig(null);
    r.align.update(r.frame);
    r.align.update(null);
    expect(r.set).not.toHaveBeenCalled();
  });
});
