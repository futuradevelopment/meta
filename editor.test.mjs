import test from 'node:test';
import assert from 'node:assert/strict';
import { contourPoint, normalizedDistance, scorePoint } from './dist/geometry.js';
import { targetPreset, guideHandles, hitTestGuide, beginGuideDrag, moveGuideDrag, adjustGuide, geometryFitsFrame } from './dist/editor.js';

const near = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should be near ${expected}`);
const shifted = (point, x, y) => ({ x: point.x + x, y: point.y + y });
// Ellipse geometry remains supported internally without exposing a third preset.
const ellipseGeometry = () => ({ ...targetPreset('oval'), shape: 'ellipse', exponent: 2, rings: targetPreset().rings });

test('the two presets default to circle 10–1 and oval 10–6 with independent geometry', () => {
  const circle = targetPreset('circle'), oval = targetPreset('oval');
  assert.equal(circle.rings.length, 10); assert.equal(oval.rings.length, 5);
  near(circle.radiusX, .425); near(circle.radiusY, .425);
  near(oval.radiusX, .32); near(oval.radiusY, .425);
  near(oval.exponent, 2.6);
  circle.rings[0] = .15;
  near(targetPreset().rings[0], .1);
});

test('unsupported presets fall back to circle and invalid score endpoints retain shape defaults', () => {
  assert.deepEqual(targetPreset('ellipse'), targetPreset('circle'));
  assert.deepEqual(targetPreset('unknown'), targetPreset('circle'));
  assert.equal(targetPreset('ellipse', 7).rings.length, 4);
  for (const endpoint of [0, 10, 2.5, NaN]) {
    assert.equal(targetPreset('circle', endpoint).rings.length, 10);
    assert.equal(targetPreset('oval', endpoint).rings.length, 5);
  }
});

test('both shapes support chosen score endpoints including 10–7, 10–5 and both range limits', () => {
  for (const shape of ['circle', 'oval']) for (const endpoint of [1, 5, 7, 9]) {
    const c = targetPreset(shape, endpoint);
    assert.equal(c.rings.length, 11 - endpoint);
    assert.equal(c.rings.at(-1), 1);
    const outer = contourPoint(2.2, .99, c), outside = contourPoint(2.2, 1.01, c);
    assert.equal(scorePoint(c.cx, c.cy, c), 10);
    assert.equal(scorePoint(outer.x, outer.y, c), endpoint);
    assert.equal(scorePoint(outside.x, outside.y, c), 0);
  }
});

test('hit tests use actual contour distance on a rotated narrow oval', () => {
  const c = { ...targetPreset('oval'), radiusX: .08, radiusY: .4, rotation: 37, rings: [.4, 1] };
  const angle = 2.4, point = contourPoint(angle, .4, c);
  assert.deepEqual(hitTestGuide(point.x, point.y, c, .004), { kind: 'ring', index: 0 });
  // The left short-axis tip is .018 away in image space, even though its
  // normalized-radius error is much larger than on the long side.
  const tip = contourPoint(Math.PI, 1, c), radians = c.rotation * Math.PI / 180;
  const nearTip = shifted(tip, -.018 * Math.cos(radians), -.018 * Math.sin(radians));
  assert.deepEqual(hitTestGuide(nearTip.x, nearTip.y, c, .02), { kind: 'ring', index: 1 });
  const farTip = shifted(tip, -.024 * Math.cos(radians), -.024 * Math.sin(radians));
  assert.equal(hitTestGuide(farTip.x, farTip.y, c, .02), null);
});

test('visible handles win outer-contour hits and selected rings only win near ties', () => {
  const c = ellipseGeometry(), handles = guideHandles(c);
  for (const kind of ['center', 'width', 'height', 'rotation']) assert.deepEqual(hitTestGuide(handles[kind].x, handles[kind].y, c), { kind });
  const close = { ...targetPreset(), rings: [.45, .5, 1] };
  const point = contourPoint(Math.PI, .475, close);
  assert.deepEqual(hitTestGuide(point.x, point.y, close, .025, 1), { kind: 'ring', index: 1 });
  const onFirst = contourPoint(Math.PI, .45, close);
  assert.deepEqual(hitTestGuide(onFirst.x, onFirst.y, close, .025, 1), { kind: 'ring', index: 0 });
});

test('phone touch tolerance leaves the innermost ring selectable and chooses the nearest overlapping handle', () => {
  const c = targetPreset(), tolerance = 16 / 330;
  const inner = contourPoint(.8, c.rings[0], c);
  assert.deepEqual(hitTestGuide(inner.x, inner.y, c, tolerance), { kind: 'ring', index: 0 });
  assert.deepEqual(hitTestGuide(c.cx, c.cy, c, tolerance), { kind: 'center' });
  const handles = guideHandles(c);
  const closerRotation = shifted(handles.rotation, 0, .02);
  assert.deepEqual(hitTestGuide(closerRotation.x, closerRotation.y, c, tolerance), { kind: 'rotation' });
  const closerHeight = shifted(handles.height, 0, -.02);
  assert.deepEqual(hitTestGuide(closerHeight.x, closerHeight.y, c, tolerance), { kind: 'height' });
});

test('center drag preserves touch offset and moves the entire ring family without mutation', () => {
  const c = { ...targetPreset('oval'), rotation: 27 };
  const original = structuredClone(c), start = { x: .51, y: .49 };
  const drag = beginGuideDrag({ kind: 'center' }, start, c);
  const still = moveGuideDrag(drag, start);
  near(still.cx, c.cx); near(still.cy, c.cy);
  const moved = moveGuideDrag(drag, shifted(start, .15, -.2));
  near(moved.cx, .65); near(moved.cy, .3); assert.deepEqual(moved.rings, c.rings);
  near(moved.radiusX, c.radiusX); near(moved.radiusY, c.radiusY); near(moved.rotation, 27);
  assert.deepEqual(c, original); assert.notEqual(moved.rings, c.rings);
  const bounded = moveGuideDrag(drag, { x: 3, y: -3 });
  assert.equal(bounded.cx, 1); assert.equal(bounded.cy, 0);
});

test('inner ring drag preserves initial touch offset and cannot cross either neighbor', () => {
  const c = { ...targetPreset('oval'), rotation: 42 }, index = 2;
  const start = contourPoint(2.2, c.rings[index] + .035, c);
  const drag = beginGuideDrag({ kind: 'ring', index }, start, c);
  near(moveGuideDrag(drag, start).rings[index], .6);
  const moved = moveGuideDrag(drag, contourPoint(2.2, .685, c));
  near(moved.rings[index], .65);
  near(moveGuideDrag(drag, contourPoint(2.2, 3, c)).rings[index], .785);
  near(moveGuideDrag(drag, { x: c.cx, y: c.cy }).rings[index], .415);
  assert.deepEqual(moved.rings.filter((_, i) => i !== index), c.rings.filter((_, i) => i !== index));
});

test('outer contour drag scales both axes proportionally with bounded axes and unchanged ring factors', () => {
  const c = { ...ellipseGeometry(), rotation: -20 };
  const start = contourPoint(2.3, 1.03, c);
  const drag = beginGuideDrag({ kind: 'ring', index: 9 }, start, c);
  const moved = moveGuideDrag(drag, contourPoint(2.3, 1.23, c));
  near(moved.radiusX, c.radiusX * 1.2); near(moved.radiusY, c.radiusY * 1.2);
  assert.deepEqual(moved.rings, c.rings);
  const largest = moveGuideDrag(drag, contourPoint(2.3, 100, c));
  near(largest.radiusY, .75); near(largest.radiusX / largest.radiusY, c.radiusX / c.radiusY);
  const smallest = moveGuideDrag(drag, { x: c.cx, y: c.cy });
  near(smallest.radiusX, .06); near(smallest.radiusX / smallest.radiusY, c.radiusX / c.radiusY);
});

test('axis handles resize in rotated local axes while circles retain equal axes', () => {
  const c = { ...targetPreset('oval'), rotation: 90 }, handles = guideHandles(c);
  const widthDrag = beginGuideDrag({ kind: 'width' }, shifted(handles.width, .004, -.006), c);
  const wider = moveGuideDrag(widthDrag, shifted(widthDrag.point, 0, .1));
  near(wider.radiusX, .42); near(wider.radiusY, .425);
  const heightDrag = beginGuideDrag({ kind: 'height' }, handles.height, c);
  const taller = moveGuideDrag(heightDrag, shifted(heightDrag.point, .1, 0));
  near(taller.radiusX, .32); near(taller.radiusY, .525);
  const circle = targetPreset(), circleDrag = beginGuideDrag({ kind: 'width' }, guideHandles(circle).width, circle);
  const smaller = moveGuideDrag(circleDrag, shifted(circleDrag.point, -.08, 0));
  near(smaller.radiusX, .345); near(smaller.radiusY, .345); near(smaller.radius, .345);
});

test('rotation drag has no jump, crosses angle wrap, and preserves oval contour geometry', () => {
  const c = { ...targetPreset('oval'), rotation: 170 }, start = guideHandles(c).rotation;
  const drag = beginGuideDrag({ kind: 'rotation' }, start, c);
  near(moveGuideDrag(drag, start).rotation, 170);
  const a = 30 * Math.PI / 180, dx = start.x - c.cx, dy = start.y - c.cy;
  const point = { x: c.cx + dx * Math.cos(a) - dy * Math.sin(a), y: c.cy + dx * Math.sin(a) + dy * Math.cos(a) };
  const rotated = moveGuideDrag(drag, point);
  near(rotated.rotation, -160); near(rotated.exponent, c.exponent);
  const contour = contourPoint(.6, .8, rotated);
  near(normalizedDistance(contour.x, contour.y, rotated), .8);
});

test('incremental controls clamp ring gaps, dimensions, centers, exponent and rotation', () => {
  const c = targetPreset('oval');
  near(adjustGuide(c, 1, 'size', 10).rings[1], .585);
  near(adjustGuide(c, 1, 'size', -10).rings[1], .215);
  const larger = adjustGuide(c, 4, 'size', .085);
  near(larger.radiusY, .51); near(larger.radiusX, .384); assert.deepEqual(larger.rings, c.rings);
  near(adjustGuide(c, 4, 'width', -10).radiusX, .06);
  near(adjustGuide(c, 4, 'height', 10).radiusY, .75);
  near(adjustGuide(c, 4, 'centerX', -10).cx, 0);
  near(adjustGuide(c, 4, 'centerY', 10).cy, 1);
  near(adjustGuide(c, 4, 'rotation', 190).rotation, -170);
  near(adjustGuide(c, 4, 'shape', 20).exponent, 8);
  near(adjustGuide(c, 4, 'shape', -20).exponent, 1);
  near(adjustGuide(ellipseGeometry(), 9, 'shape', 2).exponent, 2);
  const circle = adjustGuide(targetPreset(), 9, 'height', .1);
  near(circle.radiusX, .525); near(circle.radiusY, .525);
});

test('frame validation checks rotated oval contour bulges, not just axis handles', () => {
  assert.equal(geometryFitsFrame(targetPreset('oval')), true);
  const c = { ...targetPreset('oval'), radiusX: .43, radiusY: .43, rotation: 45, exponent: 8 };
  const handles = guideHandles(c);
  assert.ok(handles.width.x < 1 && handles.height.x < 1 && handles.width.y < 1 && handles.height.y > 0);
  assert.equal(geometryFitsFrame(c), false);
  assert.equal(geometryFitsFrame({ ...targetPreset(), radius: .503 }), true);
  assert.equal(geometryFitsFrame({ ...targetPreset(), radius: .503 }, 0), false);
  assert.equal(geometryFitsFrame({ ...targetPreset(), radius: .507 }), false);
});
