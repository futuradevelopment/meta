import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { scorePoint } from './dist/vision.js';
import { focusSupport, cropPointToCamera, requestPointFocus } from './dist/focus.js';

// Contract-level controller tests: camera hardware and pixels belong to the
// separately tested focus/detector modules. This DOM/canvas stub exercises the
// app's response to their results without a browser or optional dependencies.
const html = await readFile(new URL('./dist/index.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('./dist/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');

function setup() {
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
    constructor() { this.results = []; this.referenceCount = 0; }
    setReference() { this.referenceCount++; }
    analyze() { return this.results.shift() || { status: 'stable', alignment: { x: 0, y: 0 } }; }
  }
  const navigator = { mediaDevices: { getSupportedConstraints: () => ({ zoom: true }) } };
  const sandbox = {
    document, navigator, window: { addEventListener() {} },
    performance: { now: () => now },
    Option: class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
    requestAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
    ChangeDetector: DetectorStub, scorePoint, focusSupport, cropPointToCamera, requestPointFocus,
    URL, Blob, console,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.app = { state, detector, frame, focusAt, calibrate, start, pause, reference };', context);
  return {
    ...context.app, elements, navigator, rawCanvas: created[0],
    tick(time, result) { now = time; if (result) context.app.detector.results.push(result); context.app.frame(time); },
    tap(x, y) { const c = elements.get('cameraView'); c.dispatch('pointerdown', { clientX: x, clientY: y }); c.dispatch('pointerup', { clientX: x, clientY: y }); },
  };
}

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

test('calibration taps mark geometry while a scroll-like gesture does nothing', () => {
  const app = setup();
  app.calibrate();
  const canvas = app.elements.get('cameraView');
  canvas.dispatch('pointerdown', { clientX: 100, clientY: 100 });
  canvas.dispatch('pointerup', { clientX: 100, clientY: 200 });
  assert.equal(app.state.calibrating, 1);
  app.tap(320, 320);
  assert.equal(app.state.calibrating, 2);
  app.tap(576, 320);
  assert.equal(app.state.calibrating, 0);
  assert.equal(app.state.calibrated, true);
  assert.equal(app.state.calibration.radius, .4);
  assert.equal(app.state.focusRequest, null);
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
