import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestCalibration } from './dist/recognition.js';
import { normalizeCalibration, normalizedDistance } from './dist/geometry.js';

function target(calibration, size = 240, marks = false) {
  const c = normalizeCalibration(calibration), data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = normalizedDistance((x + .5) / size, (y + .5) / size, c);
    let value = c.rings.some(ring => Math.abs(ring - r) < .009) ? 60 : 225;
    if (marks && ((x > 92 && x < 99 && y > 109 && y < 126)
      || Math.hypot(x - 168, y - 62) < 3 || Math.hypot(x - 83, y - 157) < 3)) value = 35;
    const p = (y * size + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
  }
  return { width: size, height: size, data };
}

function close(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual}, expected ${expected}`);
}

test('measures ten circular contours and their nonuniform spacing from pixels', () => {
  const c = { cx: .515, cy: .485, radius: .44, shape: 'circle',
    rings: [.09, .18, .29, .39, .48, .6, .7, .81, .9, 1] };
  const result = suggestCalibration(target(c), { shape: 'circle' });
  assert.equal(result.status, 'suggested');
  close(result.calibration.cx, c.cx, .012, 'center x');
  close(result.calibration.cy, c.cy, .012, 'center y');
  close(result.calibration.radius, c.radius, .012, 'outer radius');
  result.calibration.rings.forEach((ring, i) => close(ring, c.rings[i], .025, `ring ${i}`));
});

test('fits off-center rotated five-ring oval despite a few printed marks', () => {
  const c = { cx: .55, cy: .46, radiusX: .31, radiusY: .43, shape: 'oval', rotation: 16,
    exponent: 2.6, rings: [.21, .39, .61, .79, 1] };
  const result = suggestCalibration(target(c, 240, true), {
    shape: 'oval', radiusX: .35, radiusY: .45, rings: [.2, .4, .6, .8, 1],
  });
  assert.equal(result.status, 'suggested');
  close(result.calibration.cx, c.cx, .015, 'center x');
  close(result.calibration.cy, c.cy, .015, 'center y');
  close(result.calibration.radiusX, c.radiusX, .02, 'horizontal radius');
  close(result.calibration.radiusY, c.radiusY, .02, 'vertical radius');
  close(result.calibration.rotation, c.rotation, 4, 'rotation');
  result.calibration.rings.forEach((ring, i) => close(ring, c.rings[i], .03, `ring ${i}`));
});

test('retains ellipse mode and derives the axes rather than copying the seed', () => {
  const c = { cx: .46, cy: .53, radiusX: .35, radiusY: .43, shape: 'ellipse', rotation: -13,
    rings: [.2, .4, .6, .8, 1] };
  const result = suggestCalibration(target(c), { shape: 'ellipse', rings: c.rings });
  assert.equal(result.status, 'suggested');
  assert.equal(result.calibration.shape, 'ellipse');
  close(result.calibration.radiusX, c.radiusX, .02, 'horizontal radius');
  close(result.calibration.radiusY, c.radiusY, .02, 'vertical radius');
});

test('rejects blank, random, and striped frames without replacing the seed', () => {
  const c = { cx: .5, cy: .5, radius: .4, rings: [.2, .4, .6, .8, 1] };
  for (const mode of ['blank', 'random', 'stripes']) {
    const image = target(c, 180); let state = 314159;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const value = mode === 'blank' ? 200 + x / 12 : mode === 'random' ? state >>> 24 : y % 20 < 2 ? 50 : 220;
      const p = (y * image.width + x) * 4;
      image.data[p] = image.data[p + 1] = image.data[p + 2] = value;
    }
    assert.equal(suggestCalibration(image, c).status, 'not-found', mode);
  }
  assert.deepEqual(c.rings, [.2, .4, .6, .8, 1]);
});

test('does not invent missing contours to satisfy the selected preset', () => {
  const image = target({ shape: 'circle', radius: .44, rings: [.2, .4, .6, .8, 1] });
  assert.equal(suggestCalibration(image, { shape: 'circle' }).status, 'not-found');
  assert.equal(suggestCalibration({ width: 10, height: 10, data: [] }).status, 'not-found');
});

test('recognizes light inner rings on a dark bullseye alongside dark outer rings', () => {
  const c = normalizeCalibration({ shape: 'circle', cx: .5, cy: .5, radius: .425 });
  const image = target(c, 320);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const r = normalizedDistance((x + .5) / image.width, (y + .5) / image.height, c);
    if (r > .5) continue;
    const line = c.rings.some(ring => Math.abs(ring - r) < .008);
    const p = (y * image.width + x) * 4, value = line ? 175 : 35;
    image.data[p] = image.data[p + 1] = image.data[p + 2] = value;
  }
  const result = suggestCalibration(image, c);
  assert.equal(result.status, 'suggested');
  close(result.calibration.radius, c.radius, .012, 'outer radius');
  result.calibration.rings.forEach((ring, i) => close(ring, c.rings[i], .03, `mixed ring ${i}`));
});

test('adjusts oval roundness from the observed contours', () => {
  const c = { cx: .5, cy: .51, radiusX: .34, radiusY: .45, shape: 'oval', rotation: 0,
    exponent: 2.2, rings: [.2, .4, .6, .8, 1] };
  const result = suggestCalibration(target(c), { ...c, exponent: 2.6, cy: .5 });
  assert.equal(result.status, 'suggested');
  close(result.calibration.exponent, c.exponent, .15, 'oval roundness');
  close(result.calibration.radiusY, c.radiusY, .015, 'vertical radius');
});
