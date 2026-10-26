/**
 * Small, dependency-free image-change reader for a stationary paper surface.
 * Coordinates use normalized image space. Use a square analysis image for
 * circular calibration. This is a visible-change detector, not an event sensor.
 */

const DEFAULT_RINGS = Object.freeze(Array.from({ length: 10 }, (_, i) => (i + 1) / 10));

function calibrationValues(calibration = {}) {
  const cx = Number.isFinite(calibration.cx) ? calibration.cx : 0.5;
  const cy = Number.isFinite(calibration.cy) ? calibration.cy : 0.5;
  const radius = Number.isFinite(calibration.radius) && calibration.radius > 0
    ? calibration.radius : 0.45;
  const supplied = calibration.rings;
  const valid = Array.isArray(supplied) && supplied.length === 10
    && supplied.every((r, i) => Number.isFinite(r) && r > 0 && r <= 1
      && (i === 0 || r > supplied[i - 1]));
  return { cx, cy, radius, rings: valid ? supplied : DEFAULT_RINGS };
}

/** Score the center of a visible change, with inclusive ring boundaries. */
export function scorePoint(x, y, calibration = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  const { cx, cy, radius, rings } = calibrationValues(calibration);
  const relativeDistance = Math.hypot(x - cx, y - cy) / radius;
  const ring = rings.findIndex(r => relativeDistance <= r + 1e-9);
  return ring < 0 ? 0 : 10 - ring;
}

/**
 * Alignment is normalized CURRENT minus REFERENCE translation. Candidate
 * coordinates remain in REFERENCE space. On `recovered`, the current image
 * becomes the reference: the caller must translate its calibration/overlays
 * by the returned alignment before the next analyze call.
 */
export class ChangeDetector {
  constructor(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8) {
      throw new RangeError('Image dimensions must be integers of at least 8 pixels.');
    }
    this.width = width; this.height = height; this._size = width * height;
    this._reference = null;
    this._gray = new Uint8Array(this._size);
    this._mask = new Uint8Array(this._size);
    this._cleanMask = new Uint8Array(this._size);
    this._queue = new Int32Array(this._size);
    this._histogram = new Uint32Array(511);
    this._pending = null; this._emitted = false; this._recovery = null;
    this._pointsKey = ''; this._points = [];
  }

  get hasReference() { return this._reference !== null; }

  _read(imageData) {
    if (!imageData || imageData.width !== this.width || imageData.height !== this.height
      || !imageData.data || imageData.data.length < this._size * 4) {
      throw new RangeError('ImageData dimensions must match the detector.');
    }
    for (let i = 0, p = 0; i < this._size; i++, p += 4) {
      this._gray[i] = (77 * imageData.data[p] + 150 * imageData.data[p + 1] + 29 * imageData.data[p + 2]) >> 8;
    }
    return this._gray;
  }

  _gradients(gray) {
    const gx = new Int16Array(this._size), gy = new Int16Array(this._size);
    const w = this.width, h = this.height;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      gx[p] = gray[p + 1] - gray[p - 1];
      gy[p] = gray[p + w] - gray[p - w];
    }
    return { gx, gy };
  }

  _adopt(gray) {
    this._reference = new Uint8Array(gray);
    this._referenceGradient = this._gradients(this._reference);
    this._pending = null; this._emitted = false; this._recovery = null;
    this._pointsKey = ''; this._points = [];
  }

  setReference(imageData) { this._adopt(this._read(imageData)); }

  _align(current, calibration, maxShift) {
    const { cx, cy, radius } = calibration;
    const w = this.width, h = this.height;
    const key = [cx, cy, radius, maxShift].join('/');
    const ref = this._referenceGradient;
    if (this._pointsKey !== key) {
      this._pointsKey = key; this._points = [];
      const stride = Math.max(2, Math.round(Math.min(w, h) / 120));
      for (let y = maxShift + 2; y < h - maxShift - 2; y += stride) {
        for (let x = maxShift + 2; x < w - maxShift - 2; x += stride) {
          if (Math.hypot((x + .5) / w - cx, (y + .5) / h - cy) > radius) continue;
          const p = y * w + x;
          if (Math.abs(ref.gx[p]) + Math.abs(ref.gy[p]) >= 30) this._points.push(p);
        }
      }
    }
    // A plain sheet has no geometry to register; normal localized detection
    // still works, but it is never eligible for automatic broad-change reset.
    if (this._points.length < 12) return { dx: 0, dy: 0, confidence: 0, textured: false, edgeRatio: 1 };
    const gradient = this._gradients(current);
    let refEnergy = 0;
    for (const p of this._points) refEnergy += ref.gx[p] ** 2 + ref.gy[p] ** 2;
    let best = { dx: 0, dy: 0, confidence: -1, textured: true, edgeRatio: 1 };
    let bestRank = -Infinity;
    for (let dy = -maxShift; dy <= maxShift; dy++) for (let dx = -maxShift; dx <= maxShift; dx++) {
      const offset = dy * w + dx;
      let dot = 0, energy = 0;
      for (const p of this._points) {
        const q = p + offset, gx = gradient.gx[q], gy = gradient.gy[q];
        dot += ref.gx[p] * gx + ref.gy[p] * gy;
        energy += gx * gx + gy * gy;
      }
      const confidence = energy ? dot / Math.sqrt(refEnergy * energy) : 0;
      const rank = confidence - (Math.abs(dx) + Math.abs(dy)) * .00001;
      if (rank > bestRank) {
        bestRank = rank;
        best = { dx, dy, confidence, textured: true, edgeRatio: Math.sqrt(energy / refEnergy) };
      }
    }
    return best;
  }

  _medianShift(current, dx, dy, calibration, gain = 1) {
    this._histogram.fill(0);
    const w = this.width, h = this.height;
    let samples = 0;
    for (let y = 1; y < h - 1; y += 3) for (let x = 1; x < w - 1; x += 3) {
      if (Math.hypot((x + .5) / w - calibration.cx, (y + .5) / h - calibration.cy) > calibration.radius) continue;
      if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
      const p = y * w + x;
      const difference = Math.round(current[p + dy * w + dx] - this._reference[p] * gain);
      this._histogram[Math.max(0, Math.min(510, difference + 255))]++; samples++;
    }
    if (!samples) return 0;
    let n = 0;
    for (let bin = 0; bin < 511; bin++) {
      n += this._histogram[bin];
      if (n >= Math.ceil(samples / 2)) return bin - 255;
    }
    return 0;
  }

  _luminanceGain(current, dx, dy, calibration) {
    const w = this.width, h = this.height;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let y = 2; y < h - 2; y += 3) for (let x = 2; x < w - 2; x += 3) {
      if (Math.hypot((x + .5) / w - calibration.cx, (y + .5) / h - calibration.cy) > calibration.radius) continue;
      if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
      const p = y * w + x, a = this._reference[p], b = current[p + dy * w + dx];
      n++; sx += a; sy += b; sxx += a * a; sxy += a * b;
    }
    const variance = n ? sxx / n - (sx / n) ** 2 : 0;
    if (variance < 400) return 1;
    const gain = (sxy / n - sx * sy / (n * n)) / variance;
    // A bounded global camera exposure adjustment, not arbitrary local fitting.
    return Math.max(.6, Math.min(1.6, gain));
  }

  _nearReferenceEdge(x, y) {
    const { gx, gy } = this._referenceGradient, w = this.width, h = this.height;
    for (let yy = Math.max(1, y - 2); yy <= Math.min(h - 2, y + 2); yy++) {
      for (let xx = Math.max(1, x - 2); xx <= Math.min(w - 2, x + 2); xx++) {
        const p = yy * w + xx;
        if (Math.abs(gx[p]) + Math.abs(gy[p]) >= 30) return true;
      }
    }
    return false;
  }

  _recover(current, calibration, alignment, nowMs) {
    const previous = this._recovery;
    let stable = false;
    if (previous && Number.isFinite(nowMs) && nowMs >= previous.last && nowMs - previous.last <= 500
      && alignment.dx === previous.dx && alignment.dy === previous.dy) {
      let total = 0, difference = 0, changed = 0;
      const w = this.width, h = this.height;
      for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
        if (Math.hypot((x + .5) / w - calibration.cx, (y + .5) / h - calibration.cy) > calibration.radius) continue;
        const p = y * w + x, delta = Math.abs(current[p] - previous.anchor[p]);
        difference += delta; total++; if (delta > 10) changed++;
      }
      stable = total > 0 && difference / total <= 2 && changed / total <= .003;
    }
    if (!stable) {
      this._recovery = { anchor: new Uint8Array(current), since: nowMs, last: nowMs, frames: 1, dx: alignment.dx, dy: alignment.dy };
      return false;
    }
    previous.last = nowMs; previous.frames++;
    if (previous.frames < 7 || nowMs - previous.since < 1200) return false;
    this._adopt(current);
    return true;
  }

  analyze(imageData, calibration = {}, options = {}, nowMs = performance.now()) {
    const current = this._read(imageData);
    if (!this.hasReference || this._emitted) return { status: 'waiting', changedPixels: 0, alignment: { x: 0, y: 0 } };
    const threshold = Number.isFinite(options.threshold) ? Math.max(5, Math.min(255, options.threshold)) : 35;
    const minArea = Number.isFinite(options.minArea) ? Math.max(1, options.minArea) : 4;
    const maxArea = Number.isFinite(options.maxArea) ? Math.max(minArea, options.maxArea) : 250;
    const stableFrames = Number.isFinite(options.stableFrames) ? Math.max(1, Math.floor(options.stableFrames)) : 3;
    const c = calibrationValues(calibration), { width: w, height: h } = this;
    const maxShift = Math.min(5, Math.floor(Math.min(w, h) / 10));
    const aligned = this._align(current, c, maxShift);
    // Do not apply an arbitrary best offset if the patterns do not correspond.
    const reliable = aligned.textured && aligned.confidence >= .72;
    const dx = reliable ? aligned.dx : 0, dy = reliable ? aligned.dy : 0;
    const alignment = { x: dx / w, y: dy / h };
    const result = (status, changedPixels, extra = {}) => ({ status, changedPixels, alignment, ...extra });
    const luminanceGain = reliable ? this._luminanceGain(current, dx, dy, c) : 1;
    const lightShift = this._medianShift(current, dx, dy, c, luminanceGain);
    this._mask.fill(0); this._cleanMask.fill(0);
    let regionPixels = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      if (Math.hypot((x + .5) / w - c.cx, (y + .5) / h - c.cy) > c.radius) continue;
      if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
      const p = y * w + x; regionPixels++;
      if (Math.abs(current[p + dy * w + dx] - this._reference[p] * luminanceGain - lightShift) >= threshold) {
        this._mask[p] = 1;
      }
    }
    // Remove isolated one- and two-pixel fluctuations before counting change.
    let changedPixels = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!this._mask[p]) continue;
      let neighbors = 0;
      for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) neighbors += this._mask[yy * w + xx];
      if (neighbors >= 3) { this._cleanMask[p] = 1; changedPixels++; }
    }
    this._mask.set(this._cleanMask);
    if (changedPixels < minArea) {
      this._pending = null; this._recovery = null;
      return result('stable', changedPixels);
    }
    const widespread = changedPixels > Math.max(minArea * 3, regionPixels * .035);
    if (widespread && aligned.textured && !reliable) {
      this._pending = null; this._recovery = null;
      return result('recalibrate', changedPixels, { reason: 'geometry' });
    }

    const components = [];
    let rejectedArea = 0, edgeChanged = 0, offEdgeCandidates = 0;
    for (let start = 0; start < this._size; start++) {
      if (!this._mask[start]) continue;
      let head = 0, tail = 1, area = 0, sumX = 0, sumY = 0, edgeArea = 0;
      let left = w, right = 0, top = h, bottom = 0;
      this._queue[0] = start; this._mask[start] = 0;
      while (head < tail) {
        const p = this._queue[head++], x = p % w, y = Math.floor(p / w);
        area++; sumX += x + .5; sumY += y + .5;
        if (this._nearReferenceEdge(x, y)) edgeArea++;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const q = yy * w + xx;
          if (this._mask[q]) { this._mask[q] = 0; this._queue[tail++] = q; }
        }
      }
      edgeChanged += edgeArea;
      const sx = right - left + 1, sy = bottom - top + 1;
      const compact = Math.max(sx, sy) <= Math.min(sx, sy) * 5 && area / (sx * sy) >= .22;
      if (area >= minArea && area <= maxArea && compact) {
        components.push({ x: sumX / area / w, y: sumY / area / h, area });
        if (area - edgeArea >= minArea) offEdgeCandidates++;
      } else if (area >= minArea) rejectedArea += area;
    }

    if (!widespread && components.length === 1 && rejectedArea < minArea) {
      this._recovery = null;
      const candidate = components[0], previous = this._pending;
      const near = previous && Math.hypot((previous.x - candidate.x) * w, (previous.y - candidate.y) * h) <= Math.max(3, Math.sqrt(candidate.area) / 2);
      const sameSize = previous && candidate.area / previous.area >= .5 && candidate.area / previous.area <= 2;
      const contiguous = previous && Number.isFinite(nowMs) && nowMs >= previous.time && nowMs - previous.time < 2000;
      const frames = near && sameSize && contiguous ? previous.frames + 1 : 1;
      this._pending = { ...candidate, frames, time: nowMs };
      if (frames < stableFrames) return result('waiting', changedPixels);
      this._emitted = true;
      return result('candidate', changedPixels, { candidate });
    }
    this._pending = null;
    if (!components.length && rejectedArea < minArea) {
      this._recovery = null;
      return result('stable', changedPixels);
    }
    // Only a distributed edge-quality change with preserved geometry is safe
    // to absorb automatically. Disconnected plausible marks are not a reset.
    const qualityChange = reliable && aligned.confidence >= .82
      && (aligned.edgeRatio < .85 || aligned.edgeRatio > 1.18)
      && edgeChanged / changedPixels >= .9 && offEdgeCandidates === 0
      && (widespread || rejectedArea >= maxArea);
    if (qualityChange) {
      if (this._recover(current, c, aligned, nowMs)) return result('recovered', changedPixels, { reason: 'image-quality' });
      return result('movement', changedPixels, { reason: 'settling' });
    }
    this._recovery = null;
    return result('movement', changedPixels, { reason: components.length > 1 ? 'ambiguous' : 'scene' });
  }
}
