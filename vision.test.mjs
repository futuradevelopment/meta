import assert from 'node:assert/strict';
import test from 'node:test';
import { ChangeDetector, scorePoint } from './dist/vision.js';
import { normalizedDistance } from './dist/geometry.js';
const calibration = { cx: 0.5, cy: 0.5, radius: 0.45 };

function frame(value = 180, size = 100) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = data[p + 1] = data[p + 2] = value;
    data[p + 3] = 255;
  }
  return { width: size, height: size, data };
}

function paint(image, x, y, width, height, value) {
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      const p = (py * image.width + px) * 4;
      image.data[p] = image.data[p + 1] = image.data[p + 2] = value;
    }
  }
  return image;
}

test('scores normalized points, boundaries, exterior, and custom rings', () => {
  assert.equal(scorePoint(0.5, 0.5, calibration), 10);
  assert.equal(scorePoint(0.545, 0.5, calibration), 10);
  assert.equal(scorePoint(0.546, 0.5, calibration), 9);
  assert.equal(scorePoint(0.95, 0.5, calibration), 1);
  assert.equal(scorePoint(0.96, 0.5, calibration), 0);
  assert.equal(scorePoint(NaN, 0.5, calibration), 0);
  const custom = { ...calibration, rings: [0.05, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] };
  assert.equal(scorePoint(0.54, 0.5, custom), 9);
});

test('requires reference and rejects mismatched frame dimensions', () => {
  const detector = new ChangeDetector(100, 100);
  assert.equal(detector.hasReference, false);
  assert.equal(detector.analyze(frame(), calibration).status, 'waiting');
  assert.throws(() => detector.setReference(frame(180, 80)), RangeError);
  detector.setReference(frame());
  assert.equal(detector.hasReference, true);
  assert.equal(detector.analyze(frame(), calibration).status, 'stable');
});

test('detects an isolated persistent mark, emits once, and rearms on a new reference', () => {
  const detector = new ChangeDetector(100, 100);
  detector.setReference(frame());
  const marked = paint(frame(), 58, 48, 4, 4, 30);
  assert.equal(detector.analyze(marked, calibration, {}, 0).status, 'waiting');
  assert.equal(detector.analyze(marked, calibration, {}, 100).status, 'waiting');
  const result = detector.analyze(marked, calibration, {}, 200);
  assert.equal(result.status, 'candidate');
  assert.deepEqual(result.candidate, { x: 0.6, y: 0.5, area: 16 });
  assert.equal(detector.analyze(marked, calibration, {}, 300).status, 'waiting');
  detector.setReference(marked);
  assert.equal(detector.analyze(marked, calibration, {}, 400).status, 'stable');
  const second = paint(paint(frame(), 58, 48, 4, 4, 30), 40, 40, 3, 3, 25);
  assert.equal(detector.analyze(second, calibration, { stableFrames: 1 }, 500).status, 'candidate');
});

test('compensates a uniform brightness shift while preserving a small new mark', () => {
  const detector = new ChangeDetector(100, 100);
  detector.setReference(frame(130));
  assert.equal(detector.analyze(frame(180), calibration).status, 'stable');
  const marked = paint(frame(180), 48, 48, 3, 3, 30);
  assert.equal(detector.analyze(marked, calibration, { stableFrames: 1 }, 0).status, 'candidate');
});

test('rejects large regional changes and multiple ambiguous marks', () => {
  const detector = new ChangeDetector(100, 100);
  detector.setReference(frame());
  const widespread = paint(frame(), 25, 25, 30, 30, 30);
  assert.equal(detector.analyze(widespread, calibration, {}, 0).status, 'movement');
  const multiple = paint(paint(frame(), 40, 40, 3, 3, 30), 60, 60, 3, 3, 30);
  assert.equal(detector.analyze(multiple, calibration, { stableFrames: 1 }, 100).status, 'movement');
});

test('ignores changes outside the target and transient marks', () => {
  const detector = new ChangeDetector(100, 100);
  detector.setReference(frame());
  assert.equal(detector.analyze(paint(frame(), 0, 0, 5, 5, 30), calibration).status, 'stable');
  const mark = paint(frame(), 48, 48, 3, 3, 30);
  assert.equal(detector.analyze(mark, calibration, {}, 0).status, 'waiting');
  assert.equal(detector.analyze(frame(), calibration, {}, 100).status, 'stable');
  assert.equal(detector.analyze(mark, calibration, {}, 200).status, 'waiting');
});

test('elliptical mask ignores outside changes but detects a mark beyond the legacy radius', () => {
  const c = { shape: 'ellipse', cx: .5, cy: .5, radius: .1, radiusX: .38, radiusY: .18, rings: [.2, .4, .6, .8, 1] };
  const detector = new ChangeDetector(100, 100);
  detector.setReference(frame());
  // Within the old circular default, but above this ellipse.
  assert.equal(detector.analyze(paint(frame(), 48, 20, 3, 3, 30), c, {}, 0).status, 'stable');
  // Within the ellipse but outside its retained legacy radius.
  const result = detector.analyze(paint(frame(), 76, 48, 3, 3, 30), c, { stableFrames: 1 }, 100);
  assert.equal(result.status, 'candidate');
  assert.ok(result.candidate.x > .7);
  assert.equal(scorePoint(result.candidate.x, result.candidate.y, c), 7);
});

test('oval mask and exposure sampling exclude exterior lighting changes', () => {
  const c = { shape: 'oval', cx: .5, cy: .5, radius: .45, radiusX: .35, radiusY: .15, rotation: 28, exponent: 2.6, rings: [.2, .4, .6, .8, 1] };
  const detector = new ChangeDetector(100, 100);
  detector.setReference(frame(130));
  const changed = frame(210);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    if (normalizedDistance((x + .5) / 100, (y + .5) / 100, c) <= 1) paint(changed, x, y, 1, 1, 130);
  }
  assert.equal(detector.analyze(changed, c, {}, 0).status, 'stable');
  paint(changed, 49, 49, 3, 3, 20);
  const result = detector.analyze(changed, c, { stableFrames: 1 }, 100);
  assert.equal(result.status, 'candidate');
  assert.equal(scorePoint(result.candidate.x, result.candidate.y, c), 10);
});

test('live ellipse rotation rebuilds alignment features for the new target region', () => {
  const original = frame(205), current = frame(205);
  for (const offset of [15, 25, 35, 65, 75, 85]) {
    // The two disjoint regions deliberately move in opposite directions.
    paint(original, offset, 47, 3, 3, 30); paint(current, offset + 3, 47, 3, 3, 30);
    paint(original, 47, offset, 3, 3, 30); paint(current, 44, offset, 3, 3, 30);
  }
  const c = { shape: 'ellipse', cx: .5, cy: .5, radiusX: .4, radiusY: .12, rotation: 0 };
  const detector = new ChangeDetector(100, 100);
  detector.setReference(original);
  assert.deepEqual(detector.analyze(current, c, {}, 0).alignment, { x: .03, y: 0 });
  c.rotation = 90;
  assert.deepEqual(detector.analyze(current, c, {}, 150).alignment, { x: -.03, y: 0 });
});

function rings(size = 100) {
  const image = frame(205, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x + .5 - size / 2, y + .5 - size / 2);
    const line = [5, 10, 15, 20, 25, 30, 35, 40, 44].some(radius => Math.abs(r - radius * size / 100) < .85 * size / 100);
    const value = line ? 40 : 205;
    const p = (y * size + x) * 4;
    image.data[p] = image.data[p + 1] = image.data[p + 2] = value;
  }
  return image;
}

function translated(image, dx, dy) {
  const output = frame(205, image.width);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const xx = x - dx, yy = y - dy;
    if (xx < 0 || yy < 0 || xx >= image.width || yy >= image.height) continue;
    const p = (y * image.width + x) * 4, q = (yy * image.width + xx) * 4;
    output.data.set(image.data.subarray(q, q + 4), p);
  }
  return output;
}

function blurred(image, radius = 1) {
  const output = frame(205, image.width);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    let sum = 0, count = 0;
    for (let yy = Math.max(0, y - radius); yy <= Math.min(image.height - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(image.width - 1, x + radius); xx++) {
        sum += image.data[(yy * image.width + xx) * 4]; count++;
      }
    }
    const p = (y * image.width + x) * 4;
    output.data[p] = output.data[p + 1] = output.data[p + 2] = Math.round(sum / count);
  }
  return output;
}

test('registers a small translated patterned image without inventing a mark', () => {
  const detector = new ChangeDetector(100, 100), original = rings();
  detector.setReference(original);
  const result = detector.analyze(translated(original, 3, -2), calibration, {}, 0);
  assert.equal(result.status, 'stable');
  assert.deepEqual(result.alignment, { x: .03, y: -.02 });
});

test('retains a real localized change while compensating a small translation', () => {
  const detector = new ChangeDetector(100, 100), original = rings();
  detector.setReference(original);
  const changed = paint(translated(original, 2, 3), 48, 50, 3, 3, 0);
  let result;
  for (let i = 0; i < 3; i++) result = detector.analyze(changed, calibration, {}, i * 150);
  assert.equal(result.status, 'candidate');
  assert.deepEqual(result.alignment, { x: .02, y: .03 });
  assert.ok(Math.abs(result.candidate.x - .475) < .012);
  assert.ok(Math.abs(result.candidate.y - .485) < .012);
});

test('suppresses scattered isolated sensor pixels', () => {
  const detector = new ChangeDetector(100, 100), original = frame();
  detector.setReference(original);
  const noisy = frame();
  for (let y = 15; y < 90; y += 6) for (let x = 15; x < 90; x += 6) paint(noisy, x, y, 1, 1, 0);
  const result = detector.analyze(noisy, calibration, {}, 0);
  assert.equal(result.status, 'stable');
  assert.equal(result.changedPixels, 0);
});

test('recovers from a settled focus change and detects the next mark', () => {
  const detector = new ChangeDetector(100, 100), original = rings();
  detector.setReference(original);
  const settled = blurred(original);
  let result, recovered = 0;
  for (let i = 0; i < 12; i++) {
    result = detector.analyze(settled, calibration, {}, i * 150);
    if (result.status === 'recovered') recovered++;
    assert.notEqual(result.status, 'candidate');
  }
  assert.equal(recovered, 1);
  assert.equal(result.status, 'stable');
  const mark = paint(blurred(original), 48, 48, 3, 3, 0);
  for (let i = 0; i < 3; i++) result = detector.analyze(mark, calibration, {}, 2000 + i * 150);
  assert.equal(result.status, 'candidate');
});

test('does not reset continuously moving or changing blurred images', () => {
  const detector = new ChangeDetector(100, 100), original = rings();
  detector.setReference(original);
  const soft = blurred(original);
  for (let i = 0; i < 30; i++) {
    const result = detector.analyze(translated(soft, i % 2 ? 2 : -2, 0), calibration, {}, i * 150);
    assert.notEqual(result.status, 'recovered');
    assert.notEqual(result.status, 'candidate');
  }
});

test('a transient geometry disruption does not absorb a later isolated mark', () => {
  const detector = new ChangeDetector(100, 100), original = rings();
  detector.setReference(original);
  detector.analyze(translated(original, 12, 9), calibration, {}, 0);
  const changed = paint(rings(), 48, 48, 3, 3, 0);
  let result;
  for (let i = 0; i < 3; i++) result = detector.analyze(changed, calibration, {}, 500 + i * 150);
  assert.equal(result.status, 'candidate');
});

test('multiple plausible localized changes are not silently adopted', () => {
  const detector = new ChangeDetector(100, 100);
  detector.setReference(frame());
  const multiple = paint(paint(frame(), 40, 40, 3, 3, 30), 60, 60, 3, 3, 30);
  for (let i = 0; i < 30; i++) {
    const result = detector.analyze(multiple, calibration, {}, i * 150);
    assert.equal(result.status, 'movement');
    assert.equal(result.reason, 'ambiguous');
  }
});

test('out-of-range image translation requests calibration instead of resetting', () => {
  const detector = new ChangeDetector(100, 100), original = rings();
  detector.setReference(original);
  for (let i = 0; i < 12; i++) {
    const result = detector.analyze(translated(original, 12, 9), calibration, {}, i * 150);
    assert.equal(result.status, 'recalibrate');
  }
});


test('a focus change with distinct new marks never absorbs those marks during recovery', () => {
  const detector = new ChangeDetector(320, 320), original = rings(320);
  detector.setReference(original);
  const soft = blurred(original, 2);
  paint(soft, 157, 157, 5, 5, 0);
  paint(soft, 191, 191, 5, 5, 0);
  for (let i = 0; i < 16; i++) {
    const result = detector.analyze(soft, calibration, {}, i * 150);
    assert.notEqual(result.status, 'recovered');
  }
});


test('compensates camera contrast and brightness changes without hiding a new mark', () => {
  const detector = new ChangeDetector(100, 100), original = rings();
  detector.setReference(original);
  const exposed = rings();
  for (let p = 0; p < exposed.data.length; p += 4) {
    const value = Math.round(exposed.data[p] * .72 + 12);
    exposed.data[p] = exposed.data[p + 1] = exposed.data[p + 2] = value;
  }
  assert.equal(detector.analyze(exposed, calibration, {}, 0).status, 'stable');
  paint(exposed, 48, 48, 3, 3, 0);
  let result;
  for (let i = 0; i < 3; i++) result = detector.analyze(exposed, calibration, {}, 200 + i * 150);
  assert.equal(result.status, 'candidate');
});
