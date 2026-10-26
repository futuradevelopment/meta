import { normalizeCalibration, contourPoint } from './geometry.js';

// This is a contour proposal, never an applied calibration. All fitted rings
// must have image evidence; a missing ring is not filled from a preset.
const LIMIT = 240;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function prepare(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width < 32 || image.height < 32 || !image.data
    || image.data.length < image.width * image.height * 4) return null;
  const scale = Math.min(1, LIMIT / Math.max(image.width, image.height));
  const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * image.width / w), x1 = Math.ceil((x + 1) * image.width / w);
    const y0 = Math.floor(y * image.height / h), y1 = Math.ceil((y + 1) * image.height / h);
    let total = 0, count = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const p = (yy * image.width + xx) * 4;
      total += (77 * image.data[p] + 150 * image.data[p + 1] + 29 * image.data[p + 2]) / 256; count++;
    }
    gray[y * w + x] = total / count;
  }
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x]; integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  function average(x, y, radius) {
    const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1), stride = w + 1;
    return (integral[y1 * stride + x1] - integral[y0 * stride + x1]
      - integral[y1 * stride + x0] + integral[y0 * stride + x0]) / ((x1 - x0) * (y1 - y0));
  }
  const field = new Float32Array(w * h);
  let energy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // Both dark lines on paper and light lines inside a dark bullseye count.
    // Local ridges reject gradual lighting gradients; capped strength keeps
    // a few dark holes/printed digits from dominating an entire contour.
    const value = clamp(Math.abs(average(x, y, 5) - average(x, y, 1)), 0, 45);
    field[y * w + x] = value; energy += value;
  }
  return { w, h, field, energy: energy / (w * h) };
}

function sample(image, x, y) {
  x = x * image.w - .5; y = y * image.h - .5;
  if (x < 0 || y < 0 || x >= image.w - 1 || y >= image.h - 1) return -1;
  const xx = Math.floor(x), yy = Math.floor(y), fx = x - xx, fy = y - yy;
  const p = yy * image.w + xx, a = image.field;
  return (a[p] * (1 - fx) + a[p + 1] * fx) * (1 - fy)
    + (a[p + image.w] * (1 - fx) + a[p + image.w + 1] * fx) * fy;
}

function directions(calibration, count, phase = 0) {
  const origin = { ...calibration, cx: 0, cy: 0 };
  return Array.from({ length: count }, (_, i) => contourPoint((i + phase) * Math.PI * 2 / count, 1, origin));
}

function profile(image, c, count, detailed = false) {
  const bins = detailed ? 168 : 112, angles = detailed ? 64 : 32;
  const start = .065, step = 1.35 / bins, dirs = directions(c, angles);
  const values = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const r = start + i * step;
    const quadrants = [0, 0, 0, 0], seen = [0, 0, 0, 0];
    for (let a = 0; a < angles; a++) {
      const value = sample(image, c.cx + dirs[a].x * r, c.cy + dirs[a].y * r);
      if (value >= 0) { const q = Math.floor(a * 4 / angles); quadrants[q] += value; seen[q]++; }
    }
    if (seen.some(n => n < angles / 8)) continue;
    const q = quadrants.map((v, index) => v / seen[index]);
    values[i] = q.reduce((a, b) => a + b, 0) / 4 * .65 + Math.min(...q) * .35;
  }
  const minGap = Math.max(3, Math.round((count >= 8 ? .052 : .095) / step));
  const peaks = [];
  for (let i = 2; i < bins - 2; i++) {
    if (values[i] < values[i - 1] || values[i] <= values[i + 1]) continue;
    peaks.push({ index: i, r: start + i * step, value: values[i] });
  }
  peaks.sort((a, b) => b.value - a.value);
  const selected = [];
  for (const peak of peaks) {
    if (selected.every(p => Math.abs(p.index - peak.index) >= minGap)) selected.push(peak);
    if (selected.length === count) break;
  }
  selected.sort((a, b) => a.r - b.r);
  if (selected.length !== count) return { score: 0, peaks: selected };
  // A frame-filling set of nested outlines, rather than tiny concentric texture.
  const outer = selected[count - 1].r;
  const maxInnerRatio = count === 2 ? .75 : .48;
  if (outer * Math.max(c.radiusX, c.radiusY) < .23 || selected[0].r / outer > maxInnerRatio) return { score: 0, peaks: selected };
  const strengths = selected.map(p => p.value).sort((a, b) => a - b);
  const mean = strengths.reduce((a, b) => a + b, 0) / count;
  return { score: mean * .7 + strengths[0] * .3, peaks: selected };
}

function fit(image, seed) {
  const count = seed.rings.length, circle = seed.shape === 'circle';
  const ratio = circle ? 1 : seed.radiusX / seed.radiusY;
  const basis = .41;
  const make = (cx, cy, aspect, rotation, exponent = seed.exponent) => ({ ...seed, cx, cy, radius: basis, exponent,
    radiusX: circle ? basis : basis * Math.sqrt(aspect),
    radiusY: circle ? basis : basis / Math.sqrt(aspect), rotation: circle ? 0 : rotation });
  const beam = [];
  function consider(c, detailed = false) {
    if (c.cx < .16 || c.cx > .84 || c.cy < .16 || c.cy > .84
      || c.radiusX / c.radiusY < .35 || c.radiusX / c.radiusY > 2.85) return null;
    const result = { c, ...profile(image, c, count, detailed) };
    return result;
  }
  const centers = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    centers.push([clamp(seed.cx, .32, .68) + dx * .04, clamp(seed.cy, .32, .68) + dy * .04]);
  }
  for (const [cx, cy] of centers) {
    for (const factor of circle ? [1] : [.72, .85, 1, 1.18, 1.39]) {
      for (const angle of circle ? [0] : [-30, -15, 0, 15, 30]) {
        const result = consider(make(cx, cy, ratio * factor, seed.rotation + angle));
        if (result && result.score > (beam[4]?.score ?? 0)) {
          beam.push(result); beam.sort((a, b) => b.score - a.score); beam.length = Math.min(5, beam.length);
        }
      }
    }
  }
  if (!beam.length) return null;
  // A slightly misplaced coarse sample can straddle a narrow printed line.
  // Always refine the user's central seed as an independent starting point.
  const seedStart = consider(make(clamp(seed.cx, .16, .84), clamp(seed.cy, .16, .84), ratio, seed.rotation), true);
  if (seedStart) beam.push(seedStart);
  let best = null;
  for (const start of beam) {
    let current = consider(start.c, true);
    for (const step of [.02, .01, .005, .0025]) {
      for (let pass = 0; pass < 4; pass++) {
        let improved = current;
        const edits = [{ cx: step }, { cx: -step }, { cy: step }, { cy: -step }];
        if (!circle) edits.push({ aspect: step * 5 }, { aspect: -step * 5 }, { rotation: step * 400 }, { rotation: -step * 400 });
        if (seed.shape === 'oval') edits.push({ exponent: step * 10 }, { exponent: -step * 10 });
        for (const edit of edits) {
          const c = current.c;
          const aspect = c.radiusX / c.radiusY * Math.exp(edit.aspect || 0);
          const exponent = seed.shape === 'oval' ? clamp(c.exponent + (edit.exponent || 0), 2, 4) : c.exponent;
          const candidate = consider(make(c.cx + (edit.cx || 0), c.cy + (edit.cy || 0), aspect, c.rotation + (edit.rotation || 0), exponent), true);
          if (candidate && candidate.score > improved.score) improved = candidate;
        }
        if (improved === current) break;
        current = improved;
      }
    }
    if (!best || current.score > best.score) best = current;
  }
  return best;
}

function validate(image, fit) {
  const { c, peaks } = fit;
  const dirs = directions(c, 96, .5), evidence = [];
  for (let ring = 0; ring < peaks.length; ring++) {
    const r = peaks[ring].r;
    const gap = Math.min(ring ? r - peaks[ring - 1].r : r,
      ring + 1 < peaks.length ? peaks[ring + 1].r - r : .13);
    const offset = Math.min(.032, gap * .32);
    const sectors = Array.from({ length: 12 }, () => []);
    for (let a = 0; a < dirs.length; a++) {
      const d = dirs[a];
      const at = sample(image, c.cx + d.x * r, c.cy + d.y * r);
      const inside = sample(image, c.cx + d.x * (r - offset), c.cy + d.y * (r - offset));
      const outside = sample(image, c.cx + d.x * (r + offset), c.cy + d.y * (r + offset));
      if (at < 0 || inside < 0 || outside < 0) continue;
      sectors[Math.floor(a / 8)].push(at - (inside + outside) / 2);
    }
    const means = sectors.map(values => values.length >= 4 ? values.reduce((a, b) => a + b, 0) / values.length : -Infinity);
    const visible = means.filter(Number.isFinite);
    const supported = means.filter(v => v > 2.4).length;
    const quadrants = [0, 1, 2, 3].filter(q => means.slice(q * 3, q * 3 + 3).filter(v => v > 2.4).length >= 2).length;
    const mean = visible.reduce((a, b) => a + b, 0) / Math.max(1, visible.length);
    if (visible.length < 9 || supported < 8 || quadrants < 3 || mean < 3.4) return null;
    evidence.push(Math.min(supported / 12, clamp(mean / 14, 0, 1)));
  }
  return evidence.reduce((a, b) => a + b, 0) / evidence.length;
}

/**
 * Return a measured draft only; the caller must require review before apply.
 * Confidence is a contour-support heuristic, not a probability of correctness.
 * The preset supplies shape/ring count; printed score labels are not read.
 */
export function suggestCalibration(imageData, seedCalibration = {}) {
  const image = prepare(imageData), seed = normalizeCalibration(seedCalibration);
  const no = reason => ({ status: 'not-found', confidence: 0, reason });
  if (!image) return no('invalid-image');
  if (seed.rings.length < 2) return no('insufficient-ring-count');
  if (image.energy < .18) return no('insufficient-lines');
  const fitted = fit(image, seed);
  if (!fitted || fitted.score < 3.5) return no('insufficient-lines');
  const confidence = validate(image, fitted);
  if (confidence === null) return no('uncertain-contours');
  const outer = fitted.peaks.at(-1).r;
  const calibration = normalizeCalibration({ ...fitted.c,
    radius: fitted.c.radius * outer,
    radiusX: fitted.c.radiusX * outer, radiusY: fitted.c.radiusY * outer,
    rings: fitted.peaks.map(peak => peak.r / outer),
  });
  return { status: 'suggested', calibration, confidence: Math.round(confidence * 100) / 100 };
}
