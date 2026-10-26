/** Shared normalized geometry for drawing, scoring and image-change masks. */

const DEFAULT_RINGS = Object.freeze(Array.from({ length: 10 }, (_, i) => (i + 1) / 10));
const metricCache = new WeakMap();
const EMPTY = Object.freeze({});
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Return a sanitized, mutable calibration without changing the caller's object.
 * Radius values are normalized semiaxes. Rotation is clockwise canvas degrees.
 * The legacy radius remains authoritative for a circle and is an axis fallback
 * for ellipse/oval. Rings are ascending factors of the outer contour.
 */
export function normalizeCalibration(calibration = {}) {
  const input = calibration && typeof calibration === 'object' ? calibration : EMPTY;
  const shape = ['circle', 'ellipse', 'oval'].includes(input.shape) ? input.shape : 'circle';
  const radius = positive(input.radius, .45);
  const radiusX = shape === 'circle' ? radius : positive(input.radiusX, radius);
  const radiusY = shape === 'circle' ? radius : positive(input.radiusY, radius);
  const supplied = input.rings;
  const validRings = Array.isArray(supplied) && supplied.length >= 1 && supplied.length <= 10
    && Array.from(supplied).every((r, i) => Number.isFinite(r) && r > 0 && r <= 1
      && (i === 0 || r > supplied[i - 1]));
  const rotation = Number.isFinite(input.rotation)
    ? ((input.rotation % 360) + 540) % 360 - 180 : 0;
  return {
    cx: Number.isFinite(input.cx) ? input.cx : .5,
    cy: Number.isFinite(input.cy) ? input.cy : .5,
    radius, shape, radiusX, radiusY, rotation,
    exponent: shape === 'oval' ? Math.max(1, Math.min(8, positive(input.exponent, 2.6))) : 2,
    rings: [...(validRings ? supplied : DEFAULT_RINGS)],
  };
}

// Analyze() calls normalizedDistance for each pixel. Cache the trigonometry but
// compare every mutable geometry field so live slider edits take effect at once.
function metric(calibration) {
  const input = calibration && typeof calibration === 'object' ? calibration : EMPTY;
  const cached = metricCache.get(input);
  if (cached && cached.inputCx === input.cx && cached.inputCy === input.cy
    && cached.inputRadius === input.radius && cached.inputShape === input.shape
    && cached.inputRadiusX === input.radiusX && cached.inputRadiusY === input.radiusY
    && cached.inputRotation === input.rotation && cached.inputExponent === input.exponent) return cached;
  const c = normalizeCalibration(input);
  const radians = c.rotation * Math.PI / 180;
  const prepared = {
    ...c, cos: Math.cos(radians), sin: Math.sin(radians),
    inputCx: input.cx, inputCy: input.cy, inputRadius: input.radius, inputShape: input.shape,
    inputRadiusX: input.radiusX, inputRadiusY: input.radiusY,
    inputRotation: input.rotation, inputExponent: input.exponent,
  };
  metricCache.set(input, prepared);
  return prepared;
}

/** Distance is 0 at the center and 1 on the outer contour; outside is > 1. */
export function normalizedDistance(x, y, calibration = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
  const c = metric(calibration), dx = x - c.cx, dy = y - c.cy;
  if (c.shape === 'circle') return Math.hypot(dx, dy) / c.radius;
  const u = (c.cos * dx + c.sin * dy) / c.radiusX;
  const v = (-c.sin * dx + c.cos * dy) / c.radiusY;
  if (c.exponent === 2) return Math.hypot(u, v);
  return (Math.abs(u) ** c.exponent + Math.abs(v) ** c.exponent) ** (1 / c.exponent);
}

/** Parametric contour: angle in radians, ring as a normalized radius factor. */
export function contourPoint(angle, ring = 1, calibration = {}) {
  const c = metric(calibration);
  const t = Number.isFinite(angle) ? angle : 0;
  const factor = Number.isFinite(ring) ? Math.max(0, ring) : 1;
  const cos = Math.cos(t), sin = Math.sin(t), power = 2 / c.exponent;
  const u = c.radiusX * factor * Math.sign(cos) * Math.abs(cos) ** power;
  const v = c.radiusY * factor * Math.sign(sin) * Math.abs(sin) ** power;
  return { x: c.cx + c.cos * u - c.sin * v, y: c.cy + c.sin * u + c.cos * v };
}

/** Score the change center. A five-ring calibration spans scores 10 through 6. */
export function scorePoint(x, y, calibration = {}) {
  const c = normalizeCalibration(calibration);
  const distance = normalizedDistance(x, y, c);
  const index = c.rings.findIndex(radius => distance <= radius + 1e-9);
  return index < 0 ? 0 : 10 - index;
}
