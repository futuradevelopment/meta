import { normalizeCalibration, normalizedDistance, contourPoint } from './geometry.js';

const MIN_AXIS = .06;
const MAX_AXIS = .75;
const RING_GAP = .015;
const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);

// Every operation returns its own calibration/ring array. Keep legacy radius in
// sync because it remains authoritative for circle geometry.
function boundedCalibration(calibration) {
  const c = normalizeCalibration(calibration);
  c.cx = clamp(c.cx, 0, 1); c.cy = clamp(c.cy, 0, 1);
  c.radiusX = clamp(c.radiusX, MIN_AXIS, MAX_AXIS);
  c.radiusY = clamp(c.radiusY, MIN_AXIS, MAX_AXIS);
  c.radius = Math.max(c.radiusX, c.radiusY);
  c.rings = c.rings.map((ring, i, rings) => clamp(ring, RING_GAP * (i + 1), 1 - RING_GAP * (rings.length - i - 1)));
  for (let i = 1; i < c.rings.length; i++) c.rings[i] = Math.max(c.rings[i], c.rings[i - 1] + RING_GAP);
  c.rings[c.rings.length - 1] = 1;
  return c;
}

export function targetPreset(shape = 'circle') {
  const kind = ['circle', 'ellipse', 'oval'].includes(shape) ? shape : 'circle';
  const count = kind === 'oval' ? 5 : 10;
  return normalizeCalibration({
    cx: .5, cy: .5, shape: kind, radius: .425,
    radiusX: kind === 'circle' ? .425 : .32, radiusY: .425,
    rotation: 0, exponent: kind === 'oval' ? 2.6 : 2,
    rings: Array.from({ length: count }, (_, i) => (i + 1) / count),
  });
}

/** Use these same positions to draw handles and to hit-test them. */
export function guideHandles(calibration) {
  const c = normalizeCalibration(calibration);
  const radians = c.rotation * Math.PI / 180;
  const height = contourPoint(-Math.PI / 2, 1, c);
  let rotation = { x: height.x + Math.sin(radians) * .065, y: height.y - Math.cos(radians) * .065 };
  // Keep the rotation grip visible when the outer line nearly fills the frame.
  if (rotation.x < .025 || rotation.y < .025 || rotation.x > .975 || rotation.y > .975) {
    rotation = { x: height.x - Math.sin(radians) * .065, y: height.y + Math.cos(radians) * .065 };
  }
  return {
    center: { x: c.cx, y: c.cy },
    width: contourPoint(0, 1, c),
    height,
    rotation,
  };
}

function squaredDistance(a, b) { return (a.x - b.x) ** 2 + (a.y - b.y) ** 2; }

// A normalized radius difference is not a screen distance on an ellipse.
// Bracket the closest actual contour point, then refine its parameter. This
// keeps touch tolerance equally useful at the short and long sides of an oval.
function contourDistance(point, ring, c) {
  const steps = 192, step = TAU / steps;
  let best = Infinity, angle = 0;
  for (let i = 0; i < steps; i++) {
    const distance = squaredDistance(point, contourPoint(i * step, ring, c));
    if (distance < best) { best = distance; angle = i * step; }
  }
  let lo = angle - step, hi = angle + step;
  for (let i = 0; i < 20; i++) {
    const left = lo + (hi - lo) / 3, right = hi - (hi - lo) / 3;
    if (squaredDistance(point, contourPoint(left, ring, c)) <= squaredDistance(point, contourPoint(right, ring, c))) hi = right;
    else lo = left;
  }
  return Math.sqrt(Math.min(best, squaredDistance(point, contourPoint((lo + hi) / 2, ring, c))));
}

/** Ring indices are zero-based; a selected ring wins only essentially tied hits. */
export function hitTestGuide(x, y, calibration, tolerance = .025, selectedIndex = null) {
  const point = { x, y };
  if (!finitePoint(point)) return null;
  const c = normalizeCalibration(calibration);
  const distanceLimit = Number.isFinite(tolerance) ? Math.max(0, tolerance) : .025;
  const handles = guideHandles(c);
  const centerLimit = Math.min(distanceLimit, Math.min(c.radiusX, c.radiusY) * c.rings[0] * .55);
  if (Math.hypot(x - c.cx, y - c.cy) <= centerLimit) return { kind: 'center' };
  const nearbyHandles = ['width', 'height', 'rotation'].map(kind => ({ kind, distance: Math.hypot(x - handles[kind].x, y - handles[kind].y) }))
    .filter(hit => hit.distance <= distanceLimit).sort((a, b) => a.distance - b.distance);
  if (nearbyHandles.length) return { kind: nearbyHandles[0].kind };
  const distances = c.rings.map(ring => contourDistance(point, ring, c));
  let index = distances.indexOf(Math.min(...distances));
  if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < distances.length
      && distances[selectedIndex] <= distanceLimit && distances[selectedIndex] <= distances[index] + .003) index = selectedIndex;
  return distances[index] <= distanceLimit ? { kind: 'ring', index } : null;
}

function localPoint(point, c) {
  const radians = c.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const dx = point.x - c.cx, dy = point.y - c.cy;
  return { x: cos * dx + sin * dy, y: -sin * dx + cos * dy };
}

export function beginGuideDrag(hit, point, calibration) {
  if (!finitePoint(point) || !hit || !['center', 'ring', 'width', 'height', 'rotation'].includes(hit.kind)) return null;
  const c = boundedCalibration(calibration);
  if (hit.kind === 'ring' && (!Number.isInteger(hit.index) || hit.index < 0 || hit.index >= c.rings.length)) return null;
  return { hit: { ...hit }, point: { ...point }, calibration: c };
}

function setAxes(c, radiusX, radiusY) {
  c.radiusX = clamp(radiusX, MIN_AXIS, MAX_AXIS);
  c.radiusY = clamp(radiusY, MIN_AXIS, MAX_AXIS);
  c.radius = Math.max(c.radiusX, c.radiusY);
  return c;
}

function scaleAxes(c, factor) {
  const lower = Math.max(MIN_AXIS / c.radiusX, MIN_AXIS / c.radiusY);
  const upper = Math.min(MAX_AXIS / c.radiusX, MAX_AXIS / c.radiusY);
  const scale = clamp(factor, lower, upper);
  return setAxes(c, c.radiusX * scale, c.radiusY * scale);
}

function resizeRing(c, index, difference) {
  const min = index ? c.rings[index - 1] + RING_GAP : RING_GAP;
  const max = c.rings[index + 1] - RING_GAP;
  c.rings[index] = clamp(c.rings[index] + difference, min, max);
  return c;
}

export function moveGuideDrag(drag, point) {
  if (!drag?.calibration) return null;
  const c = boundedCalibration(drag.calibration);
  if (!finitePoint(point)) return c;
  const original = drag.calibration, start = drag.point, { kind, index } = drag.hit;
  if (kind === 'center') {
    c.cx = clamp(original.cx + point.x - start.x, 0, 1);
    c.cy = clamp(original.cy + point.y - start.y, 0, 1);
  } else if (kind === 'ring') {
    const difference = normalizedDistance(point.x, point.y, original) - normalizedDistance(start.x, start.y, original);
    if (index === c.rings.length - 1) scaleAxes(c, 1 + difference);
    else resizeRing(c, index, difference);
  } else if (kind === 'width' || kind === 'height') {
    const current = localPoint(point, original), initial = localPoint(start, original);
    const axis = kind === 'width' ? original.radiusX + current.x - initial.x : original.radiusY - current.y + initial.y;
    if (c.shape === 'circle') setAxes(c, axis, axis);
    else setAxes(c, kind === 'width' ? axis : c.radiusX, kind === 'height' ? axis : c.radiusY);
  } else if (kind === 'rotation' && Math.hypot(point.x - c.cx, point.y - c.cy) > .000001) {
    const angle = Math.atan2(point.y - c.cy, point.x - c.cx) - Math.atan2(start.y - c.cy, start.x - c.cx);
    c.rotation = normalizeCalibration({ ...c, rotation: original.rotation + angle * 180 / Math.PI }).rotation;
  }
  return c;
}

/**
 * Deltas use normalized image units, except inner-ring size (ring factor),
 * rotation (degrees), and shape (oval exponent). Outer size scales both axes
 * proportionally; width/height alter one axis unless the target is a circle.
 */
export function adjustGuide(calibration, index, action, delta) {
  const c = boundedCalibration(calibration);
  if (!Number.isFinite(delta)) return c;
  if (action === 'size') {
    if (!Number.isInteger(index) || index < 0 || index >= c.rings.length) return c;
    if (index === c.rings.length - 1) scaleAxes(c, 1 + delta / Math.max(c.radiusX, c.radiusY));
    else resizeRing(c, index, delta);
  } else if (action === 'width' || action === 'height') {
    if (c.shape === 'circle') setAxes(c, c.radius + delta, c.radius + delta);
    else setAxes(c, c.radiusX + (action === 'width' ? delta : 0), c.radiusY + (action === 'height' ? delta : 0));
  } else if (action === 'centerX') c.cx = clamp(c.cx + delta, 0, 1);
  else if (action === 'centerY') c.cy = clamp(c.cy + delta, 0, 1);
  else if (action === 'rotation') c.rotation = normalizeCalibration({ ...c, rotation: c.rotation + delta }).rotation;
  else if (action === 'shape' && c.shape === 'oval') c.exponent = clamp(c.exponent + delta, 1, 8);
  return c;
}

/** A small positive margin permits an edge tolerance outside the image frame. */
export function geometryFitsFrame(calibration, margin = .005) {
  const c = normalizeCalibration(calibration);
  const tolerance = Number.isFinite(margin) ? margin : .005;
  for (let i = 0; i < 720; i++) {
    const point = contourPoint(TAU * i / 720, 1, c);
    if (point.x < -tolerance || point.y < -tolerance || point.x > 1 + tolerance || point.y > 1 + tolerance) return false;
  }
  return true;
}
