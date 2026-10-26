import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { scorePoint } from './dist/vision.js';
import { focusSupport, cropPointToCamera, requestPointFocus } from './dist/focus.js';
import { normalizeCalibration, contourPoint } from './dist/geometry.js';
import { targetPreset, guideHandles, hitTestGuide, beginGuideDrag, moveGuideDrag, adjustGuide, geometryFitsFrame } from './dist/editor.js';

// Contract-level controller tests: camera hardware and pixels belong to the
// separately tested focus/detector modules. This DOM/canvas stub exercises the
// app's response to their results without a browser or optional dependencies.
const html = await readFile(new URL('./dist/index.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('./dist/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');

function setup(options = {}) {
  let now = 0;
  class Element {
    constructor() {
      this.value = ''; this.checked = false; this.hidden = false;
      this.disabled = false; this.dataset = {}; this.style = {}; this.children = [];
      this.listeners = new Map(); this.textContent = ''; this.width = this.height = 640;
      this.calls = {};
      this.classList = { add() {}, remove() {} };
      this.context = new Proxy({}, {
        get: (target, key) => key === 'getImageData'
          ? (_x, _y, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })
          : target[key] ?? (() => { this.calls[key] = (this.calls[key] || 0) + 1; }),
      });
    }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    dispatch(name, event = {}) { return this.listeners.get(name)?.(event); }
    getContext() { return this.context; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 640 }; }
    append(...nodes) { this.children.push(...nodes); }
    add(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    setAttribute(name, value) { this[name] = value; }
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
  elements.get('thresholdRange').value = '35';
  const created = [];
  const document = {
    hidden: false, visibilityState: 'visible',
    getElementById: id => elements.get(id), createElement: () => { const e = new Element(); created.push(e); return e; },
    addEventListener() {},
  };
  class DetectorStub {
    constructor() { this.results = []; this.referenceCount = 0; this.analysisCount = 0; }
    setReference() { this.referenceCount++; }
    analyze() { this.analysisCount++; return this.results.shift() || { status: 'stable', alignment: { x: 0, y: 0 } }; }
  }
  const navigator = { mediaDevices: { getSupportedConstraints: () => ({ zoom: true }) } };
  const sandbox = {
    document, navigator, window: { addEventListener() {} },
    performance: { now: () => now },
    Option: class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
    requestAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
    ChangeDetector: DetectorStub, scorePoint, focusSupport, cropPointToCamera, requestPointFocus,
    normalizeCalibration, contourPoint, targetPreset, guideHandles, hitTestGuide,
    beginGuideDrag, moveGuideDrag, adjustGuide, geometryFitsFrame,
    suggestCalibration: options.recognize || (() => ({ status: 'uncertain' })),
    URL, Blob, console,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.app = { state, detector, frame, focusAt, calibrate, start, pause, reference };', context);
  return {
    ...context.app, elements, navigator, rawCanvas: created[0],
    tick(time, result) { now = time; if (result) context.app.detector.results.push(result); context.app.frame(time); },
    tap(x, y) { const c = elements.get('cameraView'); c.dispatch('pointerdown', { clientX: x, clientY: y }); c.dispatch('pointerup', { clientX: x, clientY: y }); },
    drag(start, end) {
      const c = elements.get('cameraView');
      c.dispatch('pointerdown', { clientX: start.x * 640, clientY: start.y * 640, pointerId: 1, isPrimary: true });
      c.dispatch('pointermove', { clientX: end.x * 640, clientY: end.y * 640, pointerId: 1, isPrimary: true });
      c.dispatch('pointerup', { clientX: end.x * 640, clientY: end.y * 640, pointerId: 1, isPrimary: true });
    },
  };
}

const snapshot = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should be near ${expected}`);

test('automatic candidate uses reference coordinates and adopts alignment once', () => {
  const app = setup();
  app.state.shots.push({ x: .6, y: .5, score: 8, time: new Date().toISOString(), viewRevision: 0 });
  app.start();
  app.tick(1000, { status: 'candidate', candidate: { x: .54, y: .5, area: 10 }, alignment: { x: .02, y: -.01 } });
  assert.equal(app.state.active, true);
  assert.equal(app.state.shots.length, 2);
  assert.equal(app.state.shots[1].score, 10);
  assert.equal(app.state.calibration.cx, .52);
  assert.equal(app.state.calibration.cy, .49);
  assert.equal(app.state.shots[0].x, .62);
  assert.equal(app.state.shots[1].x, .56);
  app.tick(2000, { status: 'stable', alignment: { x: 0, y: 0 } });
  assert.equal(app.state.calibration.cx, .52);
  assert.equal(app.state.shots[1].x, .56);
});

test('automatic recovery retains tracking and history without replacing the new detector reference again', () => {
  const app = setup();
  app.state.shots.push({ x: .6, y: .5, score: 8, time: new Date().toISOString(), viewRevision: 0 });
  app.start();
  const references = app.detector.referenceCount;
  app.tick(1000, { status: 'movement', alignment: { x: .01, y: 0 } });
  assert.equal(app.state.active, true);
  app.tick(2500, { status: 'recovered', alignment: { x: .01, y: 0 } });
  assert.equal(app.state.active, true);
  assert.equal(app.state.shots.length, 1);
  assert.equal(app.state.calibration.cx, .51);
  assert.equal(app.state.shots[0].x, .61);
  assert.equal(app.detector.referenceCount, references);
  assert.equal(app.elements.get('statusText').textContent, 'Praćenje nastavljeno');
});

test('transient large displacement keeps analyzing, while manual rebase requires calibration', () => {
  const app = setup();
  app.start();
  const references = app.detector.referenceCount;
  app.tick(1000, { status: 'recalibrate', alignment: { x: .08, y: 0 } });
  assert.equal(app.state.active, true);
  assert.equal(app.state.geometryMismatch, true);
  assert.equal(app.state.shots.length, 0);
  assert.equal(app.detector.referenceCount, references);
  app.tick(2000, { status: 'stable', alignment: { x: 0, y: 0 } });
  assert.equal(app.state.geometryMismatch, false);
  assert.equal(app.state.active, true);
  app.tick(3000, { status: 'recalibrate', alignment: { x: .08, y: 0 } });
  app.elements.get('referenceButton').dispatch('click');
  assert.equal(app.state.active, false);
  assert.equal(app.state.calibrating, 1);
  assert.equal(app.detector.referenceCount, references);
});

test('manual confirmation retains the exact raw detection frame until resolved', () => {
  const app = setup();
  app.elements.get('confirmToggle').checked = true;
  app.start();
  app.tick(1000, { status: 'candidate', candidate: { x: .54, y: .5, area: 10 }, alignment: { x: .01, y: 0 } });
  const drawings = app.rawCanvas.calls.fillRect;
  app.state.marks.push({ x: .7, y: .7 });
  app.tick(2000);
  assert.equal(app.rawCanvas.calls.fillRect, drawings);
  app.elements.get('confirmButton').dispatch('click');
  assert.equal(app.state.shots[0].x, .55);
  assert.equal(app.state.calibration.cx, .51);
  app.tick(3000);
  assert.ok(app.rawCanvas.calls.fillRect > drawings);
});

test('unsupported touch focus keeps tracking running and never claims a focus change', async () => {
  const app = setup();
  let applications = 0;
  const track = { getCapabilities: () => ({ focusDistance: { min: 0, max: 10 } }), applyConstraints: async () => { applications++; } };
  app.state.mode = 'camera'; app.state.stream = { getVideoTracks: () => [track] }; app.state.active = true;
  await app.focusAt(.5, .5);
  assert.equal(applications, 0);
  assert.equal(app.state.active, true);
  assert.equal(app.state.focusBusy, false);
  assert.equal(app.state.focusRequest, null);
  assert.match(app.elements.get('focusHint').textContent, /ne omogućava fokusiranje/);
});

test('opening the line editor pauses tracking and freezes its source image until closing', () => {
  const app = setup();
  app.start();
  app.tick(1000);
  const references = app.detector.referenceCount, analyses = app.detector.analysisCount;
  app.calibrate();
  const drawings = app.rawCanvas.calls.fillRect;
  assert.equal(app.state.active, false);
  assert.equal(app.elements.get('targetEditor').hidden, false);
  assert.equal(app.start(), false);
  app.tick(2000);
  assert.equal(app.rawCanvas.calls.fillRect, drawings);
  assert.equal(app.detector.analysisCount, analyses);
  assert.equal(app.detector.referenceCount, references);
  app.elements.get('cancelLinesButton').dispatch('click');
  app.tick(3000);
  assert.ok(app.rawCanvas.calls.fillRect > drawings);
  assert.equal(app.elements.get('targetEditor').hidden, true);
});

test('dragging the center changes only a draft until Apply commits the whole ring family', () => {
  const app = setup(), original = snapshot(app.state.calibration);
  app.calibrate();
  app.drag({ x: .505, y: .495 }, { x: .535, y: .515 });
  near(app.state.editor.draft.cx, .53); near(app.state.editor.draft.cy, .52);
  assert.deepEqual(snapshot(app.state.calibration), original);
  assert.deepEqual(app.state.editor.draft.rings, original.rings);
  const references = app.detector.referenceCount;
  app.elements.get('applyLinesButton').dispatch('click');
  assert.equal(app.state.editor, null);
  near(app.state.calibration.cx, .53); near(app.state.calibration.cy, .52);
  assert.deepEqual(app.state.calibration.rings, original.rings);
  assert.equal(app.state.calibrated, true);
  assert.equal(app.state.active, false);
  assert.equal(app.detector.referenceCount, references + 1);
  assert.equal(app.state.focusRequest, null);
});

test('touching and resizing a ring keeps neighbors unchanged and connects to selected-ring controls', () => {
  const app = setup(); app.calibrate();
  const c = app.state.editor.draft;
  app.drag(contourPoint(Math.PI, .4, c), contourPoint(Math.PI, .43, c));
  near(app.state.editor.draft.rings[3], .43);
  near(app.state.editor.draft.rings[2], .3); near(app.state.editor.draft.rings[4], .5);
  assert.equal(app.elements.get('selectedRing').value, '3');
  app.elements.get('plusButton').dispatch('click');
  near(app.state.editor.draft.rings[3], .435);
  near(app.state.calibration.rings[3], .4);
});

test('Cancel preserves prior calibration, mismatch, alignment, history and demo image', () => {
  const app = setup();
  app.state.shots.push({ x: .6, y: .5, score: 8, time: new Date().toISOString(), viewRevision: 0 });
  app.state.marks.push({ x: .6, y: .5 });
  app.start();
  app.tick(1000, { status: 'recalibrate', alignment: { x: .025, y: -.015 } });
  const original = snapshot({ calibration: app.state.calibration, alignment: app.state.alignment, geometryMismatch: app.state.geometryMismatch, shots: app.state.shots, demoTarget: app.state.demoTarget, marks: app.state.marks });
  const references = app.detector.referenceCount;
  app.calibrate();
  near(app.state.editor.draft.cx, .525); near(app.state.editor.draft.cy, .485);
  app.elements.get('targetPreset').value = 'oval';
  app.elements.get('targetPreset').dispatch('change');
  app.elements.get('plusButton').dispatch('click');
  app.elements.get('cancelLinesButton').dispatch('click');
  assert.deepEqual(snapshot({ calibration: app.state.calibration, alignment: app.state.alignment, geometryMismatch: app.state.geometryMismatch, shots: app.state.shots, demoTarget: app.state.demoTarget, marks: app.state.marks }), original);
  assert.equal(app.detector.referenceCount, references);
  assert.equal(app.state.active, false);
});

test('applying the five-line oval preset preserves historical scores and scores future changes with the new shape', () => {
  const app = setup();
  app.state.shots.push({ x: .6, y: .5, score: 8, time: new Date().toISOString(), viewRevision: 0 });
  const oldShot = snapshot(app.state.shots[0]);
  app.calibrate();
  app.elements.get('targetPreset').value = 'oval'; app.elements.get('targetPreset').dispatch('change');
  assert.equal(app.state.editor.draft.rings.length, 5);
  assert.equal(app.elements.get('selectedRing').children.length, 5);
  assert.equal(app.state.calibration.shape, 'circle');
  app.elements.get('applyLinesButton').dispatch('click');
  assert.equal(app.state.calibration.shape, 'oval');
  assert.equal(app.state.calibration.rings.length, 5);
  assert.deepEqual(snapshot(app.state.shots[0]), oldShot);
  assert.notEqual(app.state.shots[0].viewRevision, app.state.viewRevision);
  app.start();
  const p = contourPoint(2.2, .9, app.state.calibration);
  app.tick(2000, { status: 'candidate', candidate: { ...p, area: 10 }, alignment: { x: 0, y: 0 } });
  assert.equal(app.state.shots.length, 2);
  assert.equal(app.state.shots[0].score, 8);
  assert.equal(app.state.shots[1].score, 6);
});

test('automatic recognition proposes draft geometry and requires Apply before it affects scoring', async () => {
  const proposed = { ...targetPreset('ellipse'), cx: .48, cy: .51, radiusX: .3, radiusY: .39, rotation: 12 };
  let calls = 0;
  const app = setup({ recognize: (image, seed) => { calls++; assert.equal(image.width, 320); assert.equal(seed.shape, 'circle'); return { status: 'suggested', calibration: proposed }; } });
  const original = snapshot(app.state.calibration), references = app.detector.referenceCount;
  app.calibrate();
  const job = app.elements.get('autoLinesButton').dispatch('click');
  assert.equal(app.elements.get('applyLinesButton').disabled, true);
  await job;
  assert.equal(calls, 1);
  assert.deepEqual(snapshot(app.state.calibration), original);
  assert.equal(app.state.editor.draft.shape, 'ellipse');
  near(app.state.editor.draft.cx, .48);
  assert.equal(app.detector.referenceCount, references);
  assert.equal(app.elements.get('applyLinesButton').disabled, false);
  app.elements.get('applyLinesButton').dispatch('click');
  assert.equal(app.state.calibration.shape, 'ellipse');
  near(app.state.calibration.cx, .48);
});

test('a pending detection blocks opening the editor and remains available for confirmation', () => {
  const app = setup();
  app.elements.get('confirmToggle').checked = true;
  app.start();
  app.tick(1000, { status: 'candidate', candidate: { x: .54, y: .5, area: 10 }, alignment: { x: 0, y: 0 } });
  const pending = snapshot(app.state.pending), references = app.detector.referenceCount;
  app.elements.get('adjustLinesButton').dispatch('click');
  assert.equal(app.state.editor, null);
  assert.deepEqual(snapshot(app.state.pending), pending);
  assert.equal(app.elements.get('pendingPanel').hidden, false);
  assert.equal(app.detector.referenceCount, references);
  app.elements.get('confirmButton').dispatch('click');
  assert.equal(app.state.shots.length, 1);
  assert.equal(app.state.shots[0].score, 10);
});

test('a late recognition result cannot overwrite a newly opened editor after Cancel', async () => {
  let finish;
  const app = setup({ recognize: () => new Promise(resolve => { finish = resolve; }) });
  app.calibrate();
  const job = app.elements.get('autoLinesButton').dispatch('click');
  await Promise.resolve();
  app.elements.get('cancelLinesButton').dispatch('click');
  app.calibrate();
  app.elements.get('targetPreset').value = 'oval'; app.elements.get('targetPreset').dispatch('change');
  const draft = snapshot(app.state.editor.draft);
  finish({ status: 'suggested', calibration: { ...targetPreset('circle'), cx: .3 } });
  await job;
  assert.deepEqual(snapshot(app.state.editor.draft), draft);
  assert.equal(app.state.calibration.shape, 'circle');
  assert.equal(app.state.editor.busy, false);
});

test('a contour outside the captured image must be corrected before Apply', () => {
  const app = setup();
  app.calibrate();
  const before = snapshot(app.state.calibration), references = app.detector.referenceCount;
  app.drag({ x: .5, y: .5 }, { x: .9, y: .5 });
  app.elements.get('applyLinesButton').dispatch('click');
  assert.ok(app.state.editor);
  assert.deepEqual(snapshot(app.state.calibration), before);
  assert.equal(app.detector.referenceCount, references);
  assert.match(app.elements.get('editorHint').textContent, /izlazi iz slike/);
});

test('confirming a pending result after pausing does not claim live tracking', () => {
  const app = setup();
  app.elements.get('confirmToggle').checked = true;
  app.start();
  app.tick(1000, { status: 'candidate', candidate: { x: .54, y: .5, area: 10 }, alignment: { x: 0, y: 0 } });
  app.pause();
  app.elements.get('confirmButton').dispatch('click');
  assert.equal(app.state.active, false);
  assert.equal(app.state.shots.length, 1);
  assert.match(app.elements.get('statusHint').textContent, /pauzirano/);
});
