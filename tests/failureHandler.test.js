// Unit tests for V2 failureHandler. Spec §section_7.
//
// Both the test and failureHandler.js import from js/physics/ball.js and
// js/scene/models.js. jest.mock replaces those modules with the factories
// below; both consumers (the test and failureHandler) get the SAME mocked
// objects, so mutations via the test's imports are visible inside
// failureHandler.

jest.mock('../js/physics/ball.js', () => ({
  spawnBallAt: jest.fn(),
  ballVelocity: {
    x: 0, y: 0, z: 0,
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; },
  },
  ballAngularVelocity: { x: 0, y: 0, z: 0 },
}));
jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  return {
    tableBox: new T.Box3(
      new T.Vector3(-0.7625, -0.01, -1.37),
      new T.Vector3( 0.7625,  0.01,  1.37),
    ),
    tableSurfaceY: 0,
    ballModel: { position: { x: 0, y: 0, z: 0 }, visible: true },
  };
});

import {
  createFailureHandler,
  TARGET_REQUEST_TIMEOUT_MS,
  SOLVER_INFEASIBLE_REPEAT_LIMIT,
  BALL_SPEED_SANITY_LIMIT_MPS,
} from '../js/modes/aiMatch/failureHandler.js';
import { spawnBallAt, ballVelocity, ballAngularVelocity } from '../js/physics/ball.js';
import { ballModel } from '../js/scene/models.js';

beforeEach(() => {
  jest.useFakeTimers();
  spawnBallAt.mockClear();
  ballModel.position.x = 0; ballModel.position.y = 0; ballModel.position.z = 0;
  ballModel.visible = true;
  ballVelocity.x = 0; ballVelocity.y = 0; ballVelocity.z = 0;
  ballAngularVelocity.x = 0; ballAngularVelocity.y = 0; ballAngularVelocity.z = 0;
});
afterEach(() => {
  jest.useRealTimers();
});

// --- Constants ------------------------------------------------------------

describe('failureHandler constants', () => {
  test('match spec values', () => {
    expect(TARGET_REQUEST_TIMEOUT_MS).toBe(50);
    expect(SOLVER_INFEASIBLE_REPEAT_LIMIT).toBe(3);
    expect(BALL_SPEED_SANITY_LIMIT_MPS).toBe(100);
  });
});

// --- Worker target timeout ------------------------------------------------

describe('requestTarget / onTargetResponse', () => {
  test('successful response within timeout cancels timer and delivers target', () => {
    const fh = createFailureHandler({ log: () => {} });
    const postFn = jest.fn();
    const cb = jest.fn();
    fh.requestTarget(postFn, cb);
    expect(postFn).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();

    const target = [0.1, 0.7, 6.0, 5.0, 1.0];
    const delivered = fh.onTargetResponse(target);
    expect(delivered).toBe(true);
    expect(cb).toHaveBeenCalledWith(target);

    // Advance time past timeout — should NOT fire the callback again.
    jest.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('timeout fires fallback target when worker is silent', () => {
    const fh = createFailureHandler({ log: () => {} });
    const cb = jest.fn();
    fh.requestTarget(jest.fn(), cb);

    jest.advanceTimersByTime(TARGET_REQUEST_TIMEOUT_MS + 1);
    expect(cb).toHaveBeenCalledTimes(1);
    const fallback = cb.mock.calls[0][0];
    expect(Array.isArray(fallback)).toBe(true);
    expect(fallback.length).toBeGreaterThanOrEqual(5);
  });

  test('late response after timeout is dropped (callback not invoked twice)', () => {
    const fh = createFailureHandler({ log: () => {} });
    const cb = jest.fn();
    fh.requestTarget(jest.fn(), cb);
    jest.advanceTimersByTime(TARGET_REQUEST_TIMEOUT_MS + 1);
    expect(cb).toHaveBeenCalledTimes(1);

    const delivered = fh.onTargetResponse([0.2, 0.8, 5.0, 0, 1.0]);
    expect(delivered).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('uses last-known-good target on subsequent timeout', () => {
    const fh = createFailureHandler({ log: () => {} });
    const good = [0.3, 0.9, 7.0, 10.0, 1.0];
    fh.requestTarget(jest.fn(), jest.fn());
    fh.onTargetResponse(good);
    expect(fh.getLastKnownGoodTarget()).toEqual(good);

    const cb = jest.fn();
    fh.requestTarget(jest.fn(), cb);
    jest.advanceTimersByTime(TARGET_REQUEST_TIMEOUT_MS + 1);
    expect(cb).toHaveBeenCalledWith(good);
  });
});

// --- Solver infeasibility counter -----------------------------------------

describe('onSolverResult / shouldGiveUpRally', () => {
  test('counter increments on infeasible, resets on feasible', () => {
    const fh = createFailureHandler({ log: () => {} });
    fh.onSolverResult(false);
    fh.onSolverResult(false);
    expect(fh.getSolverInfeasibleCount()).toBe(2);
    expect(fh.shouldGiveUpRally()).toBe(false);

    fh.onSolverResult(true);
    expect(fh.getSolverInfeasibleCount()).toBe(0);
    expect(fh.shouldGiveUpRally()).toBe(false);
  });

  test('shouldGiveUpRally trips at SOLVER_INFEASIBLE_REPEAT_LIMIT', () => {
    const fh = createFailureHandler({ log: () => {} });
    for (let i = 0; i < SOLVER_INFEASIBLE_REPEAT_LIMIT; i++) fh.onSolverResult(false);
    expect(fh.shouldGiveUpRally()).toBe(true);
  });

  test('resetSolverCount clears state', () => {
    const fh = createFailureHandler({ log: () => {} });
    fh.onSolverResult(false); fh.onSolverResult(false); fh.onSolverResult(false);
    expect(fh.shouldGiveUpRally()).toBe(true);
    fh.resetSolverCount();
    expect(fh.shouldGiveUpRally()).toBe(false);
  });
});

// --- Ball state validation ------------------------------------------------

describe('validateBallState', () => {
  test('returns true when state is clean', () => {
    const fh = createFailureHandler({ log: () => {} });
    expect(fh.validateBallState()).toBe(true);
    expect(spawnBallAt).not.toHaveBeenCalled();
  });

  test('returns false and resets ball when position contains NaN', () => {
    const fh = createFailureHandler({ log: () => {} });
    ballModel.position.x = NaN;
    expect(fh.validateBallState()).toBe(false);
    expect(spawnBallAt).toHaveBeenCalledTimes(1);
  });

  test('returns false and resets when velocity exceeds sanity limit', () => {
    const fh = createFailureHandler({ log: () => {} });
    ballVelocity.x = BALL_SPEED_SANITY_LIMIT_MPS + 50;
    expect(fh.validateBallState()).toBe(false);
    expect(spawnBallAt).toHaveBeenCalledTimes(1);
  });

  test('returns false and resets when spin contains Infinity', () => {
    const fh = createFailureHandler({ log: () => {} });
    ballAngularVelocity.y = Infinity;
    expect(fh.validateBallState()).toBe(false);
    expect(spawnBallAt).toHaveBeenCalledTimes(1);
  });

  test('skips validation when ball is invisible', () => {
    const fh = createFailureHandler({ log: () => {} });
    ballModel.visible = false;
    ballModel.position.x = NaN;
    expect(fh.validateBallState()).toBe(true);
    expect(spawnBallAt).not.toHaveBeenCalled();
  });

  test('does not storm-reset within cooldown window', () => {
    const fh = createFailureHandler({ log: () => {} });
    ballModel.position.x = NaN;
    fh.validateBallState();
    expect(spawnBallAt).toHaveBeenCalledTimes(1);
    fh.validateBallState();
    expect(spawnBallAt).toHaveBeenCalledTimes(1);
  });
});

// --- Dispose --------------------------------------------------------------

describe('dispose', () => {
  test('cancels pending request and terminates worker', () => {
    const worker = { terminate: jest.fn() };
    const fh = createFailureHandler({ worker, log: () => {} });
    const cb = jest.fn();
    fh.requestTarget(jest.fn(), cb);
    fh.dispose();
    jest.advanceTimersByTime(TARGET_REQUEST_TIMEOUT_MS + 1);
    expect(cb).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  test('survives a worker that throws on terminate', () => {
    const worker = { terminate: () => { throw new Error('boom'); } };
    const fh = createFailureHandler({ worker, log: () => {} });
    expect(() => fh.dispose()).not.toThrow();
  });
});
