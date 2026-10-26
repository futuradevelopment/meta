import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

// Import the browser ES module independently of the host project's package type.
const source = await readFile(new URL('./dist/vision.js', import.meta.url), 'utf8');
const { ChangeDetector, scorePoint } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
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
