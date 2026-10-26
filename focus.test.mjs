import test from 'node:test';
import assert from 'node:assert/strict';
import { focusSupport, cropPointToCamera, requestPointFocus } from './dist/focus.js';

const supported = { focusMode: true, pointsOfInterest: true };
function mockTrack({ capabilities = { focusMode: ['continuous', 'single-shot'] }, constraints = {}, settings = {}, failure = null } = {}) {
  const requests = [];
  return {
    requests,
    getCapabilities: () => capabilities,
    getConstraints: () => constraints,
    getSettings: () => settings,
    applyConstraints: async request => { requests.push(request); if (failure) throw failure; },
  };
}

test('Safari-like focusDistance capability does not imply controllable autofocus', async () => {
  const track = mockTrack({ capabilities: { focusDistance: { min: .1, max: Infinity }, zoom: { min: 1, max: 6 } } });
  assert.deepEqual(focusSupport(track, { zoom: true }), { point: false, automatic: false, mode: null });
  assert.deepEqual(await requestPointFocus(track, { zoom: true }, { x: .5, y: .5 }), { status: 'unsupported' });
  assert.equal(track.requests.length, 0);
});

test('focus support requires browser keys and suitable modes on the actual track', () => {
  assert.deepEqual(focusSupport(mockTrack(), supported), { point: true, automatic: true, mode: 'single-shot' });
  assert.deepEqual(focusSupport(mockTrack({ capabilities: { focusMode: ['continuous'] } }), supported), { point: true, automatic: true, mode: 'continuous' });
  assert.deepEqual(focusSupport(mockTrack(), { focusMode: true }), { point: false, automatic: true, mode: 'single-shot' });
  assert.deepEqual(focusSupport(mockTrack({ capabilities: { focusMode: ['manual', 'none'] } }), supported), { point: false, automatic: false, mode: null });
  assert.equal(focusSupport(mockTrack({ capabilities: { focusMode: ['continuous'], pointsOfInterest: false } }), supported).point, false);
});

test('unsupported or inaccessible capability information never sends a request', async () => {
  const track = mockTrack();
  track.getCapabilities = () => { throw new Error('unavailable'); };
  assert.equal((await requestPointFocus(track, supported, { x: .5, y: .5 })).status, 'unsupported');
  assert.equal(track.requests.length, 0);
  assert.deepEqual(focusSupport(null, supported), { point: false, automatic: false, mode: null });
});

test('square crop coordinates account for landscape, portrait and digital zoom', () => {
  assert.deepEqual(cropPointToCamera(.5, .5, 1920, 1080), { x: .5, y: .5 });
  assert.deepEqual(cropPointToCamera(0, 0, 1920, 1080), { x: .21875, y: 0 });
  assert.deepEqual(cropPointToCamera(1, 1, 1920, 1080), { x: .78125, y: 1 });
  assert.deepEqual(cropPointToCamera(0, 1, 1080, 1920), { x: 0, y: .78125 });
  assert.deepEqual(cropPointToCamera(0, 0, 1920, 1080, 2), { x: .359375, y: .25 });
  assert.deepEqual(cropPointToCamera(-1, 2, 640, 640), { x: 0, y: 1 });
  assert.throws(() => cropPointToCamera(.5, .5, 0, 1080), RangeError);
  assert.throws(() => cropPointToCamera(.5, .5, 640, 640, .5), RangeError);
});

test('focus request preserves existing constraints and advanced zoom without mutation', async () => {
  const constraints = {
    deviceId: { exact: 'back-lens' }, width: { ideal: 1920 }, frameRate: { ideal: 30 },
    focusMode: 'manual', pointsOfInterest: [{ x: .1, y: .1 }],
    advanced: [{ zoom: 3, focusMode: 'manual' }, { pointsOfInterest: [{ x: .1, y: .1 }] }, { whiteBalanceMode: 'continuous' }],
  };
  const original = structuredClone(constraints);
  const track = mockTrack({ constraints, settings: { focusMode: 'single-shot', pointsOfInterest: [{ x: .25, y: .6 }] } });
  assert.deepEqual(await requestPointFocus(track, supported, { x: .25, y: .6 }), { status: 'requested', mode: 'single-shot' });
  assert.deepEqual(constraints, original);
  assert.deepEqual(track.requests[0], {
    deviceId: { exact: 'back-lens' }, width: { ideal: 1920 }, frameRate: { ideal: 30 },
    focusMode: { exact: 'single-shot' }, pointsOfInterest: { exact: [{ x: .25, y: .6 }] },
    advanced: [{ zoom: 3 }, { whiteBalanceMode: 'continuous' }],
  });
});

test('rejected constraints report failure without a fallback stream restart', async () => {
  const track = mockTrack({ failure: new Error('Requested focus mode is not available') });
  assert.deepEqual(await requestPointFocus(track, supported, { x: .5, y: .5 }), {
    status: 'failed', mode: 'single-shot', error: 'Requested focus mode is not available',
  });
  assert.equal(track.requests.length, 1);
});

test('accepted but missing or mismatched active settings remain unverified', async () => {
  for (const settings of [
    {}, { focusMode: 'single-shot' },
    { focusMode: 'continuous', pointsOfInterest: [{ x: .5, y: .5 }] },
    { focusMode: 'single-shot', pointsOfInterest: [{ x: .2, y: .5 }] },
  ]) {
    const track = mockTrack({ settings });
    assert.deepEqual(await requestPointFocus(track, supported, { x: .5, y: .5 }), { status: 'unverified', mode: 'single-shot' });
  }
});

test('invalid points are rejected before applying, and finite points are clamped', async () => {
  const track = mockTrack();
  assert.equal((await requestPointFocus(track, supported, { x: NaN, y: .5 })).status, 'failed');
  assert.equal(track.requests.length, 0);
  assert.equal((await requestPointFocus(track, supported, { x: -1, y: 2 })).status, 'unverified');
  assert.deepEqual(track.requests[0].pointsOfInterest, { exact: [{ x: 0, y: 1 }] });
});
