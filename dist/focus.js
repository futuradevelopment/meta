/** Camera focus requests, with explicit feature detection and no stream restart. */

const clamp01 = value => Math.max(0, Math.min(1, value));

/**
 * Browser support and per-track modes are both required. A focusDistance range
 * alone is not evidence that the browser exposes writable focus controls.
 * pointsOfInterest has no standard MediaTrackCapabilities member; honor an
 * explicit false from implementations that expose one, without requiring it.
 */
export function focusSupport(track, supportedConstraints = {}) {
  const unavailable = { point: false, automatic: false, mode: null };
  if (supportedConstraints?.focusMode !== true || typeof track?.applyConstraints !== 'function') {
    return unavailable;
  }
  let capabilities;
  try { capabilities = track.getCapabilities?.() || {}; }
  catch { return unavailable; }
  const modes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
  const mode = modes.includes('single-shot') ? 'single-shot'
    : modes.includes('continuous') ? 'continuous' : null;
  return {
    point: Boolean(mode && supportedConstraints.pointsOfInterest === true
      && capabilities.pointsOfInterest !== false),
    automatic: Boolean(mode),
    mode,
  };
}

/** Map a normalized tap in a software square crop to the full camera frame. */
export function cropPointToCamera(x, y, width, height, digitalZoom = 1) {
  if (![x, y, width, height, digitalZoom].every(Number.isFinite)
    || width <= 0 || height <= 0 || digitalZoom < 1) {
    throw new RangeError('Camera dimensions must be positive and digital zoom at least 1.');
  }
  const side = Math.min(width, height) / digitalZoom;
  return {
    x: clamp01(((width - side) / 2 + clamp01(x) * side) / width),
    y: clamp01(((height - side) / 2 + clamp01(y) * side) / height),
  };
}

function cloneConstraint(value) {
  if (Array.isArray(value)) return value.map(cloneConstraint);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneConstraint(item)]));
  }
  return value;
}

/**
 * "requested" means the active settings reflect the requested mode and point.
 * It never means autofocus has converged or that the image is sharp.
 * Unsupported or silently ignored settings never produce a success claim.
 */
export async function requestPointFocus(track, supportedConstraints, point) {
  const support = focusSupport(track, supportedConstraints);
  if (!support.point) return { status: 'unsupported' };
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { status: 'failed', mode: support.mode, error: 'Invalid camera focus point.' };
  }
  const requestedPoint = { x: clamp01(point.x), y: clamp01(point.y) };
  try {
    // Read and clone existing requirements so zoom, frame rate and lens choice
    // survive this update. Only obsolete focus requests are replaced.
    const constraints = cloneConstraint(track.getConstraints?.() || {});
    if (Array.isArray(constraints.advanced)) {
      constraints.advanced = constraints.advanced.map(entry => {
        const { focusMode, pointsOfInterest, ...rest } = entry;
        return rest;
      }).filter(entry => Object.keys(entry).length);
    }
    // Required basic constraints avoid the optional-advanced-set silent skip.
    constraints.focusMode = { exact: support.mode };
    constraints.pointsOfInterest = { exact: [requestedPoint] };
    await track.applyConstraints(constraints);

    let settings;
    try { settings = track.getSettings?.() || {}; }
    catch { return { status: 'unverified', mode: support.mode }; }
    const points = settings.pointsOfInterest;
    const reportedPoint = Array.isArray(points) && points.length === 1 ? points[0] : null;
    const pointMatches = reportedPoint && Number.isFinite(reportedPoint.x) && Number.isFinite(reportedPoint.y)
      && Math.abs(reportedPoint.x - requestedPoint.x) <= 0.001
      && Math.abs(reportedPoint.y - requestedPoint.y) <= 0.001;
    return {
      status: settings.focusMode === support.mode && pointMatches ? 'requested' : 'unverified',
      mode: support.mode,
    };
  } catch (error) {
    return {
      status: 'failed',
      mode: support.mode,
      error: error?.message || 'The camera rejected the focus request.',
    };
  }
}
