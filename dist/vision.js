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

export class ChangeDetector {
  constructor(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8) {
      throw new RangeError('Image dimensions must be integers of at least 8 pixels.');
    }
    this.width = width;
    this.height = height;
    this._size = width * height;
    this._reference = null;
    this._gray = new Uint8Array(this._size);
    this._mask = new Uint8Array(this._size);
    this._queue = new Int32Array(this._size);
    this._histogram = new Uint32Array(511);
    this._pending = null;
    this._emitted = false;
  }

  get hasReference() {
    return this._reference !== null;
  }

  _read(imageData) {
    if (!imageData || imageData.width !== this.width || imageData.height !== this.height
      || !imageData.data || imageData.data.length < this._size * 4) {
      throw new RangeError('ImageData dimensions must match the detector.');
    }
    const data = imageData.data;
    for (let i = 0, p = 0; i < this._size; i++, p += 4) {
      this._gray[i] = (77 * data[p] + 150 * data[p + 1] + 29 * data[p + 2]) >> 8;
    }
    return this._gray;
  }

  setReference(imageData) {
    this._reference = new Uint8Array(this._read(imageData));
    this._pending = null;
    this._emitted = false;
  }

  analyze(imageData, calibration = {}, options = {}, nowMs = performance.now()) {
    const current = this._read(imageData);
    if (!this.hasReference) return { status: 'waiting', changedPixels: 0 };
    if (this._emitted) return { status: 'waiting', changedPixels: 0 };

    const threshold = Number.isFinite(options.threshold)
      ? Math.max(5, Math.min(255, options.threshold)) : 35;
    const minArea = Number.isFinite(options.minArea) ? Math.max(1, options.minArea) : 4;
    const maxArea = Number.isFinite(options.maxArea)
      ? Math.max(minArea, options.maxArea) : 250;
    const stableFrames = Number.isFinite(options.stableFrames)
      ? Math.max(1, Math.floor(options.stableFrames)) : 3;
    const { cx, cy, radius } = calibrationValues(calibration);
    const { width, height } = this;
    const minX = Math.max(0, Math.floor((cx - radius) * width));
    const maxX = Math.min(width - 1, Math.ceil((cx + radius) * width));
    const minY = Math.max(0, Math.floor((cy - radius) * height));
    const maxY = Math.min(height - 1, Math.ceil((cy + radius) * height));
    this._mask.fill(0);
    this._histogram.fill(0);

    // Median light-level shift ignores a few new marks. This compensates only
    // approximately uniform exposure changes, never shadows or physical motion.
    let samples = 0;
    for (let y = minY; y <= maxY; y += 2) {
      for (let x = minX; x <= maxX; x += 2) {
        const dx = (x + 0.5) / width - cx;
        const dy = (y + 0.5) / height - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
        const p = y * width + x;
        this._histogram[current[p] - this._reference[p] + 255]++;
        samples++;
      }
    }
    if (!samples) {
      this._pending = null;
      return { status: 'waiting', changedPixels: 0 };
    }
    let medianBin = 0;
    let cumulative = 0;
    for (; medianBin < 511; medianBin++) {
      cumulative += this._histogram[medianBin];
      if (cumulative >= Math.ceil(samples / 2)) break;
    }
    const lightShift = medianBin - 255;
    let changedPixels = 0;
    let regionPixels = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = (x + 0.5) / width - cx;
        const dy = (y + 0.5) / height - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
        regionPixels++;
        const p = y * width + x;
        if (Math.abs(current[p] - this._reference[p] - lightShift) >= threshold) {
          this._mask[p] = 1;
          changedPixels++;
        }
      }
    }

    if (changedPixels < minArea) {
      this._pending = null;
      return { status: 'stable', changedPixels };
    }
    if (changedPixels > Math.max(minArea * 3, regionPixels * 0.035)) {
      this._pending = null;
      return { status: 'movement', changedPixels };
    }

    // Eight-connected components separate isolated small changes from outlines
    // and large patches introduced by camera or paper motion.
    const components = [];
    let rejectedArea = 0;
    for (let start = 0; start < this._size; start++) {
      if (!this._mask[start]) continue;
      let head = 0;
      let tail = 1;
      this._queue[0] = start;
      this._mask[start] = 0;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let left = width;
      let right = 0;
      let top = height;
      let bottom = 0;
      while (head < tail) {
        const p = this._queue[head++];
        const x = p % width;
        const y = Math.floor(p / width);
        area++;
        sumX += x + 0.5;
        sumY += y + 0.5;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
            const neighbor = ny * width + nx;
            if (this._mask[neighbor]) {
              this._mask[neighbor] = 0;
              this._queue[tail++] = neighbor;
            }
          }
        }
      }
      const spanX = right - left + 1;
      const spanY = bottom - top + 1;
      const elongated = Math.max(spanX, spanY) > Math.min(spanX, spanY) * 5;
      if (area >= minArea && area <= maxArea && !elongated) {
        components.push({ x: sumX / area / width, y: sumY / area / height, area });
      } else if (area >= minArea) {
        rejectedArea += area;
      }
    }
    if (components.length !== 1 || rejectedArea >= minArea) {
      this._pending = null;
      return { status: components.length || rejectedArea ? 'movement' : 'stable', changedPixels };
    }

    const candidate = components[0];
    const pending = this._pending;
    const proximity = Math.max(3, Math.sqrt(candidate.area) / 2);
    const samePosition = pending && Math.hypot(
      (pending.x - candidate.x) * width,
      (pending.y - candidate.y) * height,
    ) <= proximity;
    const sameSize = pending && candidate.area / pending.area >= 0.5
      && candidate.area / pending.area <= 2;
    const contiguous = pending && Number.isFinite(nowMs)
      && nowMs >= pending.time && nowMs - pending.time < 2000;
    const frames = samePosition && sameSize && contiguous ? pending.frames + 1 : 1;
    this._pending = { ...candidate, frames, time: nowMs };
    if (frames < stableFrames) return { status: 'waiting', changedPixels };

    this._emitted = true;
    return { status: 'candidate', candidate, changedPixels };
  }
}
