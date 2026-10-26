import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCalibration, normalizedDistance, contourPoint, scorePoint } from './dist/geometry.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const fiveRings = [.2, .4, .6, .8, 1];

test('legacy circle radius keeps ten-ring scores and inclusive boundaries', () => {
  const c = { cx: .5, cy: .5, radius: .4 };
  close(normalizedDistance(.5, .9, c), 1);
  assert.equal(scorePoint(.5, .54, c), 10);
  assert.equal(scorePoint(.5, .9, c), 1);
  assert.equal(scorePoint(.5, .901, c), 0);
  close(contourPoint(Math.PI / 2, .5, c).y, .7);
});

test('five elliptical rings score 10 through 6 at their actual axis boundaries', () => {
  const c = { shape: 'ellipse', cx: .5, cy: .5, radiusX: .2, radiusY: .4, rings: fiveRings };
  fiveRings.forEach((ring, i) => {
    const point = contourPoint(Math.PI / 2, ring, c);
    close(normalizedDistance(point.x, point.y, c), ring);
    assert.equal(scorePoint(point.x, point.y, c), 10 - i);
  });
  assert.equal(scorePoint(.7, .5, c), 6);
  assert.equal(scorePoint(.71, .5, c), 0);
  assert.equal(scorePoint(.5, .85, c), 6);
});

test('rotation uses degrees clockwise and respects unequal semiaxes', () => {
  const c = { shape: 'ellipse', cx: .5, cy: .5, radiusX: .2, radiusY: .4, rotation: 90, rings: fiveRings };
  const right = contourPoint(0, 1, c);
  close(right.x, .5); close(right.y, .7);
  const lower = contourPoint(Math.PI / 2, 1, c);
  close(lower.x, .1); close(lower.y, .5);
  close(normalizedDistance(.9, .5, c), 1);
  assert.ok(normalizedDistance(.5, .8, c) > 1);
});

test('rotated superellipse contours and scoring share the same geometry', () => {
  const c = { shape: 'oval', cx: .47, cy: .53, radiusX: .23, radiusY: .39, rotation: -31, exponent: 2.6, rings: fiveRings };
  for (let i = 0; i < 48; i++) {
    const angle = i * Math.PI / 24;
    for (const [index, ring] of fiveRings.entries()) {
      const point = contourPoint(angle, ring, c);
      close(normalizedDistance(point.x, point.y, c), ring);
      assert.equal(scorePoint(point.x, point.y, c), 10 - index);
    }
    const outside = contourPoint(angle, 1.01, c);
    assert.equal(scorePoint(outside.x, outside.y, c), 0);
  }
  const squareOval = { shape: 'oval', cx: .5, cy: .5, radiusX: .3, radiusY: .3, exponent: 4 };
  assert.ok(normalizedDistance(.74, .74, squareOval) < 1);
  assert.ok(normalizedDistance(.74, .74, { ...squareOval, shape: 'ellipse' }) > 1);
});

test('live geometry edits invalidate cached distance and contour trigonometry', () => {
  const c = { shape: 'ellipse', cx: .5, cy: .5, radiusX: .2, radiusY: .4, rotation: 0 };
  close(normalizedDistance(.8, .5, c), 1.5);
  c.rotation = 90;
  close(normalizedDistance(.8, .5, c), .75);
  c.radiusY = .3;
  close(normalizedDistance(.8, .5, c), 1);
  c.shape = 'oval'; c.exponent = 4;
  const point = contourPoint(Math.PI / 4, 1, c);
  close(normalizedDistance(point.x, point.y, c), 1);
  c.cx = .6;
  assert.notEqual(normalizedDistance(point.x, point.y, c), 1);
});

test('invalid inputs have finite defaults and ring data is copied', () => {
  const c = normalizeCalibration({ shape: 'oval', cx: NaN, cy: Infinity, radius: -2, radiusX: 0, radiusY: NaN, rotation: Infinity, exponent: NaN, rings: [.2, .2] });
  assert.equal(c.cx, .5); assert.equal(c.cy, .5);
  assert.equal(c.radiusX, .45); assert.equal(c.radiusY, .45);
  assert.equal(c.rotation, 0); assert.equal(c.exponent, 2.6);
  assert.equal(c.rings.length, 10);
  assert.equal(normalizedDistance(NaN, .5, c), Infinity);
  assert.equal(scorePoint(Infinity, .5, c), 0);
  assert.ok(Number.isFinite(contourPoint(NaN, NaN, null).x));
  const supplied = { rings: [.5, 1] }, output = normalizeCalibration(supplied);
  output.rings[0] = .3;
  assert.equal(supplied.rings[0], .5);
  assert.equal(normalizeCalibration({ rotation: 450 }).rotation, 90);
  assert.equal(normalizeCalibration({ shape: 'ellipse', exponent: 7 }).exponent, 2);
  assert.equal(normalizeCalibration({ rings: [.2, , 1] }).rings.length, 10);
});
