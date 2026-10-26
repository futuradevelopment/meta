import { ChangeDetector, scorePoint } from './vision.js';
import { focusSupport, cropPointToCamera, requestPointFocus } from './focus.js';
import { normalizeCalibration, contourPoint } from './geometry.js';
import { targetPreset, guideHandles, hitTestGuide, beginGuideDrag, moveGuideDrag, adjustGuide, geometryFitsFrame } from './editor.js';
import { suggestCalibration } from './recognition.js';

const $ = id => document.getElementById(id);
const canvas = $('cameraView');
const ctx = canvas.getContext('2d');
const video = $('sourceVideo');
const raw = document.createElement('canvas');
raw.width = raw.height = 640;
const rawCtx = raw.getContext('2d', { willReadFrequently: true });
const analysis = document.createElement('canvas');
analysis.width = analysis.height = 320;
const analysisCtx = analysis.getContext('2d', { willReadFrequently: true });
const detector = new ChangeDetector(320, 320);
const DEFAULT = () => targetPreset('circle');
const state = {
  mode: 'demo', stream: null, active: false, opening: false, calibration: DEFAULT(),
  calibrated: true, calibrating: 0, pending: null, shots: [], marks: [],
  zoom: 1, nativeZoom: false, lastAnalysis: 0, holdUntil: 0, wakeLock: null,
  frameReady: false, lastStatus: '', flashUntil: 0,
  viewRevision: 0,
  alignment: { x: 0, y: 0 }, focusBusy: false, focusRequest: null,
  recoveryNoticeUntil: 0,
  geometryMismatch: false,
  editor: null, demoTarget: DEFAULT(),
};
let toastTimer;
let zoomTimer;
const phrases = ['Izvan krugova', 'jedan', 'dva', 'tri', 'četiri', 'pet', 'šest', 'sedam', 'osam', 'devet', 'deset'];

// Keep touch gestures on the app at a fixed page scale. Camera zoom remains
// controlled independently by its slider. Do not cancel single-finger input.
const preventPageGesture = event => { if (event.cancelable) event.preventDefault(); };
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, preventPageGesture, { passive: false });
}
document.addEventListener('touchmove', event => {
  if (event.touches.length > 1) preventPageGesture(event);
}, { passive: false });
document.addEventListener('selectstart', event => {
  if (!event.target.closest?.('input, textarea, [contenteditable="true"]')) preventPageGesture(event);
});

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').classList.remove('visible'); $('toast').hidden = true; }, 4200);
}

function setStatus(kind, title, detail) {
  const key = [kind, title, detail].join('|');
  if (state.lastStatus === key) return;
  state.lastStatus = key;
  $('statusBadge').dataset.state = kind;
  $('statusBadge').textContent = ({live:'AKTIVNO',idle:'PAUZA',pending:'PROVJERI',motion:'PROMJENA',error:'KAMERA',setup:'POSTAVI',ready:'SPREMNO'})[kind] || 'SPREMNO';
  $('statusText').textContent = title;
  $('statusHint').textContent = detail;
}

function currentFrame() {
  analysisCtx.drawImage(raw, 0, 0, 320, 320);
  return analysisCtx.getImageData(0, 0, 320, 320);
}

// Stored coordinates belong to the detector's reference image. Adopt a
// measured translation only when that reference is replaced.
function adoptAlignment() {
  const { x, y } = state.alignment;
  if (x || y) {
    state.calibration.cx += x;
    state.calibration.cy += y;
    for (const shot of state.shots) if (shot.viewRevision === state.viewRevision) {
      shot.x += x; shot.y += y;
    }
  }
  state.alignment = { x: 0, y: 0 };
}

function reference() {
  if (!state.frameReady) { toast('Sačekaj da se pojavi slika kamere.'); return false; }
  adoptAlignment();
  detector.setReference(currentFrame());
  state.holdUntil = performance.now() + 600;
  return true;
}

async function wake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch { /* Some devices don't support a screen wake lock. */ }
}

function pause(detail = 'Nastavi kada si spreman.') {
  state.active = false;
  $('monitorButton').textContent = 'Pokreni praćenje';
  $('monitorButton').classList.remove('is-running');
  $('monitorButton').setAttribute('aria-pressed', 'false');
  setStatus('idle', 'Praćenje pauzirano', detail);
  state.wakeLock?.release().catch(() => {});
}

function start() {
  if (state.editor) { toast('Prvo primijeni ili otkaži podešavanje linija.'); return false; }
  if (state.geometryMismatch) { calibrate(); return false; }
  if (state.calibrating) { toast('Prvo završi podešavanje krugova.'); return false; }
  if (!state.calibrated) { toast('Prvo dodirni „Podesi linije“ i poravnaj linije s metom.'); return false; }
  if (state.pending) { toast('Potvrdi ili odbaci prikazanu promjenu.'); return false; }
  if (!reference()) return false;
  state.active = true;
  $('monitorButton').textContent = 'Pauziraj praćenje';
  $('monitorButton').classList.add('is-running');
  $('monitorButton').setAttribute('aria-pressed', 'true');
  setStatus('live', 'Pratim promjene', state.mode === 'demo' ? 'Probni prikaz · dodaj trag da isprobaš očitavanje.' : 'Kamera je spremna. Rezultati se procjenjuju po centru promjene.');
  if ($('soundToggle').checked) announce('Praćenje pokrenuto.');
  wake();
  return true;
}

function populateVoices() {
  const selected = $('voiceSelect').value;
  const voices = 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
  $('voiceSelect').replaceChildren(new Option('Automatski izbor glasa', ''));
  for (const v of voices) $('voiceSelect').add(new Option(`${v.name} · ${v.lang}`, v.voiceURI));
  if (voices.some(v => v.voiceURI === selected)) $('voiceSelect').value = selected;
}

function speak(score, force = false) {
  if (!force && !$('soundToggle').checked) return;
  announce(score === 0 ? 'Izvan krugova.' : `Pogodak, ${phrases[score]}.`);
}

function announce(text) {
  if (!('speechSynthesis' in window)) { toast('Ovaj preglednik nema glasovne objave. Rezultat ostaje na ekranu.'); return; }
  const voices = speechSynthesis.getVoices();
  const voice = voices.find(v => v.voiceURI === $('voiceSelect').value)
    || voices.find(v => /^(bs|hr|sr)(-|_)/i.test(v.lang));
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice?.lang || 'hr-HR';
  if (voice) utterance.voice = voice;
  utterance.rate = .92;
  utterance.onerror = e => { if (!['interrupted', 'canceled'].includes(e.error)) toast('Glas nije dostupan. Probaj drugi glas ili dodirni „Test glasa“.'); };
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

function resetPending() {
  state.pending = null;
  $('pendingPanel').hidden = true;
}

function record(candidate, score) {
  state.shots.push({ ...candidate, score, time: new Date().toISOString(), source: state.mode, viewRevision: state.viewRevision });
  state.flashUntil = performance.now() + 1400;
  resetPending();
  renderHistory();
  speak(score);
  reference();
  setStatus(state.active ? 'live' : 'ready', 'Pogodak zabilježen', `Procjena: ${score} · ${state.active ? 'pratim sljedeću promjenu.' : 'praćenje je pauzirano.'}`);
}

function onCandidate(candidate) {
  const score = scorePoint(candidate.x, candidate.y, state.calibration);
  if ($('confirmToggle').checked) {
    state.pending = { ...candidate, score };
    $('pendingScore').value = String(score);
    $('candidateInfo').textContent = `Nova vidljiva promjena · procjena ${score} bodova. Slika je zadržana do potvrde.`;
    $('pendingPanel').hidden = false;
    setStatus('pending', 'Potvrdi očitanje', 'Provjeri označenu promjenu i vrijednost prije upisa.');
  } else record(candidate, score);
}

function renderHistory() {
  const count = state.shots.length;
  const total = state.shots.reduce((sum, s) => sum + s.score, 0);
  $('shotCount').textContent = count;
  $('totalScore').textContent = total;
  $('avgScore').textContent = count ? (total / count).toLocaleString('bs-BA', { maximumFractionDigits: 1 }) : '—';
  $('lastScore').textContent = count ? state.shots[count - 1].score : '—';
  $('lastLabel').textContent = count ? `Pogodak ${String(count).padStart(2, '0')} · procjena` : 'Čekam prvi pogodak';
  $('exportButton').disabled = !count;
  $('deleteLastButton').disabled = !count;
  $('shotList').replaceChildren();
  if (!count) {
    const li = document.createElement('li');
    li.className = 'empty-history';
    li.textContent = 'Ovdje će se pojaviti pogoci tvoje serije.';
    $('shotList').append(li);
  }
  state.shots.slice().reverse().forEach((shot, i) => {
    const li = document.createElement('li');
    li.className = 'shot-row';
    const number = document.createElement('span'); number.className = 'shot-index'; number.textContent = String(count - i).padStart(2, '0');
    const label = document.createElement('span'); label.className = 'shot-time'; label.textContent = new Date(shot.time).toLocaleTimeString('bs-BA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const badge = document.createElement('strong'); badge.className = 'shot-score'; badge.textContent = shot.score;
    if (shot.score === 10) badge.dataset.center = 'true';
    li.append(number, label, badge); $('shotList').append(li);
  });
}

function traceContour(context, calibration, ring, size) {
  const c = normalizeCalibration(calibration);
  context.beginPath();
  if (c.shape !== 'oval') {
    context.ellipse(c.cx * size, c.cy * size, c.radiusX * ring * size, c.radiusY * ring * size, c.rotation * Math.PI / 180, 0, Math.PI * 2);
    return;
  }
  for (let i = 0; i <= 128; i++) {
    const p = contourPoint(i * Math.PI / 64, ring, c);
    if (i === 0) context.moveTo(p.x * size, p.y * size);
    else context.lineTo(p.x * size, p.y * size);
  }
  context.closePath();
}

function drawDemo() {
  const w = raw.width, c = normalizeCalibration(state.demoTarget);
  rawCtx.fillStyle = '#e8e5dc'; rawCtx.fillRect(0, 0, w, w);
  rawCtx.fillStyle = '#f3f1e9'; rawCtx.fillRect(23, 23, w - 46, w - 46);
  for (let i = c.rings.length - 1; i >= 0; i--) {
    traceContour(rawCtx, c, c.rings[i], w);
    const dark = c.shape === 'circle' && i < 5;
    rawCtx.fillStyle = dark ? '#23272a' : '#f3f1e9'; rawCtx.fill();
    rawCtx.strokeStyle = dark ? '#afb0a7' : '#616864'; rawCtx.lineWidth = 2; rawCtx.stroke();
    if (i > 0) {
      const label = contourPoint(0, (c.rings[i] + c.rings[i - 1]) / 2, c);
      rawCtx.fillStyle = dark ? '#b9bbb1' : '#747b73'; rawCtx.font = '11px ui-monospace, monospace'; rawCtx.textAlign = 'center';
      rawCtx.fillText(String(10 - i), label.x * w, label.y * w + 4);
    }
  }
  rawCtx.fillStyle = c.shape === 'circle' ? '#c4c8bb' : '#747b73'; rawCtx.font = '11px ui-monospace, monospace'; rawCtx.fillText('10', c.cx * w, c.cy * w + 4);
  rawCtx.fillStyle = '#6b7267'; rawCtx.font = '10px ui-monospace, monospace'; rawCtx.textAlign = 'left'; rawCtx.fillText('META / PROBNI PRIKAZ', 43, 49);
  rawCtx.textAlign = 'right'; rawCtx.fillText('SIMULIRANA SLIKA', w - 43, w - 40);
  for (const m of state.marks) {
    rawCtx.beginPath(); rawCtx.arc(m.x * w, m.y * w, 6, 0, Math.PI * 2);
    rawCtx.fillStyle = '#d1cbb8'; rawCtx.fill();
    rawCtx.strokeStyle = '#77746c'; rawCtx.lineWidth = 2; rawCtx.stroke();
    rawCtx.beginPath(); rawCtx.arc(m.x * w, m.y * w, 3, 0, Math.PI * 2); rawCtx.fillStyle = '#101719'; rawCtx.fill();
  }
  state.frameReady = true;
}

function drawRaw() {
  if (state.mode === 'demo') { drawDemo(); return; }
  if (!state.stream || video.readyState < 2 || !video.videoWidth) { state.frameReady = false; rawCtx.fillStyle = '#101412'; rawCtx.fillRect(0, 0, 640, 640); return; }
  const zoom = state.nativeZoom ? 1 : state.zoom;
  const side = Math.min(video.videoWidth, video.videoHeight) / zoom;
  rawCtx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, 640, 640);
  state.frameReady = true;
}

function strokeTargetGuide(selected = false) {
  // The white edge separates the red guide from dark printed target lines.
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = selected ? 6 : 3.5; ctx.stroke();
  ctx.strokeStyle = '#e02020'; ctx.lineWidth = selected ? 3.5 : 2; ctx.stroke();
}

function drawOverlay(now) {
  const size = canvas.width;
  ctx.drawImage(raw, 0, 0, size, size);
  const c = state.editor?.draft || { ...state.calibration, cx: state.calibration.cx + state.alignment.x, cy: state.calibration.cy + state.alignment.y };
  if ((state.calibrated && !state.geometryMismatch) || state.editor) {
    ctx.save();
    c.rings.forEach((r, i) => { traceContour(ctx, c, r, size); strokeTargetGuide(state.editor?.selected === i); });
    ctx.beginPath(); ctx.moveTo(c.cx * size - 8, c.cy * size); ctx.lineTo(c.cx * size + 8, c.cy * size); ctx.moveTo(c.cx * size, c.cy * size - 8); ctx.lineTo(c.cx * size, c.cy * size + 8); strokeTargetGuide();
    if (state.editor) {
      const handles = guideHandles(c);
      for (const [name, p] of Object.entries(handles)) {
        ctx.beginPath(); ctx.arc(p.x * size, p.y * size, name === 'center' ? 12 : 10, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = '#e02020'; ctx.lineWidth = 3; ctx.stroke();
        ctx.fillStyle = '#b91313'; ctx.textAlign = 'center'; ctx.font = 'bold 14px sans-serif';
        ctx.fillText(({center:'+',width:'↔',height:'↕',rotation:'↻'})[name], p.x * size, p.y * size + 5);
      }
    }
    ctx.restore();
  }
  if (state.editor) return;
  for (let i = 0; i < state.shots.length; i++) {
    const s = state.shots[i];
    if (state.geometryMismatch) continue;
    if (s.viewRevision !== state.viewRevision) continue;
    marker(s.x + state.alignment.x, s.y + state.alignment.y, String(i + 1), i === state.shots.length - 1 ? '#e9ff9a' : '#f8a879');
  }
  if (state.pending) marker(state.pending.x + state.alignment.x, state.pending.y + state.alignment.y, '?', '#ffce6b');
  if (state.focusRequest && now < state.focusRequest.until) {
    const { x, y } = state.focusRequest;
    ctx.save(); ctx.strokeStyle = '#d4f87a'; ctx.lineWidth = 1.5;
    ctx.strokeRect(x * size - 18, y * size - 18, 36, 36);
    ctx.restore();
  }
  if (state.flashUntil > now) {
    ctx.strokeStyle = `rgba(215,248,121,${Math.min(.8, (state.flashUntil - now) / 1400)})`;
    ctx.lineWidth = 5; ctx.strokeRect(2, 2, size - 4, size - 4);
  }
}

function marker(x, y, label, color) {
  const px = x * canvas.width, py = y * canvas.height;
  ctx.beginPath(); ctx.arc(px, py, 11, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#101b19'; ctx.fillRect(px + 9, py - 23, 23, 21);
  ctx.fillStyle = color; ctx.font = 'bold 13px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText(label, px + 20, py - 8);
}

function frame(now) {
  // A confirmation refers to the exact displayed detection frame, not a newer
  // live frame that may have moved while the user was reviewing the result.
  if (!state.pending && !state.editor) drawRaw();
  if (state.active && !state.pending && !state.focusBusy && state.frameReady && now - state.lastAnalysis > 120 && now > state.holdUntil) {
    state.lastAnalysis = now;
    const result = detector.analyze(currentFrame(), state.calibration, { threshold: Number($('thresholdRange').value) }, now);
    if (result.alignment) state.alignment = result.alignment;
    state.geometryMismatch = result.status === 'recalibrate';
    if (result.status === 'candidate') onCandidate(result.candidate);
    else if (result.status === 'recovered') {
      adoptAlignment();
      state.recoveryNoticeUntil = now + 1800;
      setStatus('live', 'Praćenje nastavljeno', 'Slika se stabilizirala. Nejasne promjene tokom smetnje nisu bodovane.');
    } else if (result.status === 'recalibrate') {
      // Keep evaluating frames: a temporary bump can return to the calibrated
      // view without user intervention. Larger persistent changes need setup.
      setStatus('motion', 'Kadar je pomjeren', 'Praćenje je uključeno. Vrati prethodni kadar ili dodirni „Podesi linije“.');
    } else if (result.status === 'movement') {
      if (result.reason === 'ambiguous') setStatus('motion', 'Više nejasnih promjena', 'Praćenje je uključeno. Za novo početno stanje odaberi „Nova referentna slika“.');
      else if (result.reason === 'scene') setStatus('motion', 'Nejasna promjena kadra', 'Praćenje je uključeno. Ako je slika sada mirna, provjeri krugove i postavi novu referentnu sliku.');
      else setStatus('motion', 'Čekam da se slika smiri', 'Praćenje je uključeno i nastavlja se kada se slika stabilizira.');
    } else if (result.status === 'stable' && now > state.recoveryNoticeUntil) setStatus('live', 'Pratim promjene', state.mode === 'demo' ? 'Probni prikaz · dodaj trag da isprobaš očitavanje.' : 'Slika je stabilna. Čekam novu vidljivu promjenu.');
  }
  drawOverlay(now);
  requestAnimationFrame(frame);
}

function ringFields() {
  $('ringInputs').replaceChildren();
  const c = state.editor?.draft || state.calibration;
  c.rings.forEach((r, i) => {
    const label = document.createElement('label'); label.className = 'ring-field'; label.textContent = `${10 - i} bodova`;
    const input = document.createElement('input');
    input.type = 'number'; input.min = '1'; input.max = '100'; input.step = '0.5'; input.value = +(r * 100).toFixed(1);
    input.setAttribute('aria-label', `Veličina linije ${10 - i}, u procentima vanjske linije`);
    input.disabled = i === c.rings.length - 1;
    input.addEventListener('change', () => {
      if (!state.editor || state.editor.busy) return;
      const value = Number(input.value) / 100, draft = state.editor.draft;
      const previous = i ? draft.rings[i - 1] : 0, next = draft.rings[i + 1] ?? 1.01;
      if (!Number.isFinite(value) || value < previous + .015 || value > next - .015) { input.value = draft.rings[i] * 100; toast('Između susjednih linija ostavi najmanje 1,5%.'); return; }
      draft.rings[i] = value; state.editor.selected = i; syncEditor();
    });
    label.append(input); $('ringInputs').append(label);
  });
}

function syncEditor(rebuild = false) {
  const e = state.editor;
  if (!e) return;
  const c = normalizeCalibration(e.draft); e.draft = c;
  e.selected = Math.max(0, Math.min(c.rings.length - 1, e.selected));
  $('targetPreset').value = c.shape;
  $('scoreEndSelect').value = String(11 - c.rings.length);
  if (rebuild) {
    $('selectedRing').replaceChildren();
    c.rings.forEach((_r, i) => $('selectedRing').add(new Option(`${10 - i} bodova${i === c.rings.length - 1 ? ' · vanjska' : ''}`, String(i))));
    ringFields();
  }
  $('selectedRing').value = String(e.selected);
  const action = $('editorAction').value || 'size';
  const labels = {size:'Veličina odabrane linije',width:'Širina svih linija',height:'Visina svih linija',rotation:'Nagib svih linija',centerX:'Centar lijevo / desno',centerY:'Centar gore / dolje',shape:'Zaobljenost ovala'};
  $('editorParameterLabel').textContent = labels[action];
  const sizeValue = e.selected === c.rings.length - 1 ? `${(c.radiusX * 200).toFixed(1)} × ${(c.radiusY * 200).toFixed(1)}%` : `${(c.rings[e.selected] * 100).toFixed(1)}%`;
  const values = {size:sizeValue,width:`${(c.radiusX * 200).toFixed(1)}%`,height:`${(c.radiusY * 200).toFixed(1)}%`,rotation:`${c.rotation.toFixed(1)}°`,centerX:`${(c.cx * 100).toFixed(1)}%`,centerY:`${(c.cy * 100).toFixed(1)}%`,shape:c.exponent.toFixed(1)};
  $('editorValue').textContent = values[action];
  for (const id of ['autoLinesButton','applyLinesButton','targetPreset','scoreEndSelect','selectedRing','editorAction','resetCalibrationButton']) $(id).disabled = !!e.busy;
  $('minusButton').disabled = $('plusButton').disabled = !!e.busy || (action === 'shape' && c.shape !== 'oval');
}

function calibrate() {
  if (state.editor) return;
  if (!state.frameReady) return toast('Prvo uključi kameru.');
  if (state.pending) return toast('Prvo potvrdi ili odbaci prikazano očitanje.');
  if (state.focusBusy) return toast('Sačekaj završetak zahtjeva za fokus.');
  pause('Podešavanje linija je u toku.');
  state.editor = {
    draft: normalizeCalibration({ ...state.calibration, cx: state.calibration.cx + state.alignment.x, cy: state.calibration.cy + state.alignment.y }),
    selected: state.calibration.rings.length - 1, drag: null, busy: false,
    demoBefore: state.demoTarget, marksBefore: state.marks,
  };
  state.calibrating = 1; state.focusRequest = null;
  $('targetEditor').hidden = false; $('viewPanel').classList.add('is-editing');
  document.body?.classList.add('editing-target');
  $('adjustLinesButton').setAttribute('aria-expanded', 'true');
  canvas.style.cursor = 'grab'; canvas.style.touchAction = 'none';
  $('editorAction').value = 'size';
  $('editorHint').textContent = 'Odaberi oblik i bodovni raspon, pa dodirni „Prepoznaj linije“. Povuci linije za ispravku. Slika je zadržana do završetka.';
  syncEditor(true);
  $('targetPreset').focus?.();
}

function closeEditor(apply) {
  const e = state.editor;
  if (!e || (apply && e.busy)) return;
  if (apply && !geometryFitsFrame(e.draft)) {
    $('editorHint').textContent = 'Vanjska linija izlazi iz slike. Smanji ili pomjeri raspored tako da je cijela meta u kadru.';
    return;
  }
  e.worker?.terminate(); e.rejectRecognition?.(new Error('cancelled'));
  if (apply) {
    state.calibration = normalizeCalibration(e.draft); state.calibrated = true;
    state.alignment = { x: 0, y: 0 }; state.geometryMismatch = false; state.viewRevision++;
    detector.setReference(currentFrame()); state.holdUntil = performance.now() + 600;
    $('calibrationHint').textContent = `${state.calibration.rings.length} linija je podešeno. Dodirni „Podesi linije“ za izmjenu.`;
    setStatus('ready', 'Linije su podešene', 'Dodirni „Pokreni praćenje“ kada provjeriš kadar.');
  } else {
    state.demoTarget = e.demoBefore; state.marks = e.marksBefore;
    setStatus('idle', 'Podešavanje otkazano', 'Prethodne linije su sačuvane. Praćenje je pauzirano.');
  }
  state.editor = null; state.calibrating = 0;
  $('targetEditor').hidden = true; $('viewPanel').classList.remove('is-editing');
  document.body?.classList.remove('editing-target');
  $('adjustLinesButton').setAttribute('aria-expanded', 'false');
  canvas.style.cursor = 'default'; canvas.style.touchAction = 'manipulation';
  $('adjustLinesButton').focus?.();
}

function changeTargetPreset() {
  const e = state.editor;
  if (!e || e.busy) return;
  const preset = targetPreset($('targetPreset').value);
  e.draft = { ...preset, cx: e.draft.cx, cy: e.draft.cy, rotation: e.draft.rotation };
  e.selected = e.draft.rings.length - 1;
  if (state.mode === 'demo') { state.demoTarget = targetPreset(preset.shape); state.marks = []; drawDemo(); }
  $('editorHint').textContent = 'Oblik je odabran. Dodirni „Prepoznaj linije“ ili povuci crvene linije na štampane konture.';
  syncEditor(true);
}

function changeScoreRange() {
  const e = state.editor;
  if (!e || e.busy) return;
  const end = Number($('scoreEndSelect').value);
  if (!Number.isInteger(end) || end < 1 || end > 9) { syncEditor(); return; }
  const preset = targetPreset(e.draft.shape, end);
  if (e.draft.rings.length === preset.rings.length) return;
  e.draft = { ...e.draft, rings: preset.rings };
  e.selected = Math.min(e.selected, e.draft.rings.length - 1);
  if (state.mode === 'demo') { state.demoTarget = { ...state.demoTarget, rings: [...preset.rings] }; state.marks = []; drawDemo(); }
  const noun = preset.rings.length <= 4 ? 'linije' : 'linija';
  $('editorHint').textContent = `Raspon 10–${end}: ${preset.rings.length} ${noun}. Razmaci su postavljeni ravnomjerno; prepoznaj ili prilagodi linije prije potvrde.`;
  syncEditor(true);
}

function recognitionInBackground(imageData, seed, editor) {
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => suggestCalibration(imageData, seed));
  return new Promise((resolve, reject) => {
    const worker = new Worker('./recognition-worker.js', { type: 'module' }); editor.worker = worker;
    const timeout = setTimeout(() => finish(reject, new Error('timeout')), 15000);
    const finish = (fn, value) => { clearTimeout(timeout); worker.terminate(); editor.worker = null; editor.rejectRecognition = null; fn(value); };
    editor.rejectRecognition = error => finish(reject, error);
    worker.onmessage = event => event.data.error ? finish(reject, new Error(event.data.error)) : finish(resolve, event.data.result);
    worker.onerror = () => finish(reject, new Error('recognition'));
    try { worker.postMessage({ imageData, seed }, [imageData.data.buffer]); }
    catch (error) { finish(reject, error); }
  });
}

async function recognizeLines() {
  const e = state.editor;
  if (!e || e.busy) return;
  e.busy = true; syncEditor();
  $('editorHint').textContent = 'Tražim linije na zadržanoj slici…';
  try {
    const result = await recognitionInBackground(currentFrame(), e.draft, e);
    if (state.editor !== e) return;
    if (result.status === 'suggested') {
      e.draft = normalizeCalibration(result.calibration);
      $('editorHint').textContent = 'Pronađen je prijedlog linija. Provjeri preklapanje, povuci linije za ispravku, pa dodirni „Primijeni“.';
    } else $('editorHint').textContent = 'Linije nisu dovoljno jasne za automatski prijedlog. Možeš ih namjestiti povlačenjem ili ponoviti s boljim kadrom.';
  } catch {
    if (state.editor === e) $('editorHint').textContent = 'Prepoznavanje nije uspjelo. Linije možeš podesiti prstom i tipkama − / +.';
  } finally { if (state.editor === e) { e.busy = false; syncEditor(true); } }
}

function fineAdjust(direction) {
  const e = state.editor;
  if (!e || e.busy) return;
  const action = $('editorAction').value || 'size';
  const step = action === 'rotation' ? 1 : action === 'shape' ? .1 : action === 'size' ? .005 : .0025;
  e.draft = adjustGuide(e.draft, e.selected, action, direction * step); syncEditor(true);
}

function canvasPoint(event) {
  const box = canvas.getBoundingClientRect();
  return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
}
let pointerStart = null;
canvas.addEventListener('pointerdown', event => {
  if (event.isPrimary === false) return;
  const p = canvasPoint(event), e = state.editor;
  pointerStart = { x: event.clientX, y: event.clientY, time: performance.now(), id: event.pointerId };
  if (!e || e.busy) return;
  const tolerance = 16 / canvas.getBoundingClientRect().width;
  const hit = hitTestGuide(p.x, p.y, e.draft, tolerance, e.selected);
  if (!hit) { $('editorHint').textContent = 'Dodirni crvenu liniju ili bijelu ručicu. Centar pomjera sve linije.'; return; }
  if (hit.kind === 'ring') { e.selected = hit.index; $('editorAction').value = 'size'; }
  else if (hit.kind !== 'center') e.selected = e.draft.rings.length - 1;
  e.dragSnapshot = e.draft; e.drag = beginGuideDrag(hit, p, e.draft);
  canvas.setPointerCapture?.(event.pointerId); event.preventDefault?.(); canvas.style.cursor = 'grabbing';
  syncEditor();
});
canvas.addEventListener('pointermove', event => {
  const e = state.editor;
  if (!e?.drag || event.pointerId !== pointerStart?.id) return;
  e.draft = moveGuideDrag(e.drag, canvasPoint(event)); event.preventDefault?.(); syncEditor();
});
canvas.addEventListener('pointercancel', () => {
  if (state.editor?.drag) { state.editor.draft = state.editor.dragSnapshot; state.editor.drag = null; syncEditor(true); }
  pointerStart = null;
});
canvas.addEventListener('pointerup', event => {
  const down = pointerStart;
  if (down && event.pointerId !== down.id) return;
  pointerStart = null;
  if (state.editor) {
    if (state.editor.drag) { state.editor.draft = moveGuideDrag(state.editor.drag, canvasPoint(event)); state.editor.drag = null; syncEditor(true); }
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = 'grab'; return;
  }
  if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 12 || performance.now() - down.time > 800) return;
  const p = canvasPoint(event); focusAt(p.x, p.y);
});

function updateFocusUI() {
  const track = state.stream?.getVideoTracks()[0];
  const support = focusSupport(track, navigator.mediaDevices?.getSupportedConstraints?.() || {});
  $('focusButton').disabled = state.mode !== 'camera' || !support.point;
  $('focusHint').textContent = state.mode !== 'camera' ? 'Uključi kameru da provjeriš dostupnost fokusa na dodir.'
    : support.point ? 'Dodirni sliku za zahtjev fokusa na tom mjestu. Tokom podešavanja linije pomjeraš prstom.'
    : 'Ovaj preglednik ne omogućava fokusiranje dodirom; fokusom upravlja kamera.';
}

async function focusAt(x, y) {
  if (state.mode !== 'camera') return toast('Fokus je dostupan samo uz uključenu kameru.');
  if (state.calibrating) return toast('Prvo završi podešavanje krugova.');
  if (state.pending) return toast('Prvo potvrdi ili odbaci prikazanu promjenu.');
  if (state.focusBusy) return;
  const track = state.stream?.getVideoTracks()[0];
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};
  if (!focusSupport(track, supported).point) {
    updateFocusUI(); return toast('Ovaj preglednik ne omogućava fokusiranje dodirom; fokusom upravlja kamera.');
  }
  state.focusBusy = true;
  $('focusButton').disabled = true;
  $('focusHint').textContent = 'Šaljem zahtjev za fokus…';
  try {
    const point = cropPointToCamera(x, y, video.videoWidth, video.videoHeight, state.nativeZoom ? 1 : state.zoom);
    const result = await requestPointFocus(track, supported, point);
    if (state.stream?.getVideoTracks()[0] !== track) return;
    if (result.status === 'requested') {
      state.focusRequest = { x, y, until: performance.now() + 1300 };
      $('focusHint').textContent = 'Zahtjev za fokus je poslan. Provjeri oštrinu slike.';
    } else if (result.status === 'unverified') {
      $('focusHint').textContent = 'Preglednik je prihvatio zahtjev, ali ne potvrđuje postavku fokusa.';
      toast('Promjenu fokusa nije moguće potvrditi. Provjeri oštrinu slike.');
    } else {
      updateFocusUI(); toast('Kamera nije prihvatila zahtjev za fokus.');
    }
  } catch {
    updateFocusUI(); toast('Zahtjev za fokus nije uspio.');
  } finally {
    state.focusBusy = false;
    $('focusButton').disabled = !focusSupport(state.stream?.getVideoTracks()[0], navigator.mediaDevices?.getSupportedConstraints?.() || {}).point;
    // Preserve the pre-focus reference: the detector will compare/recover only
    // after the image settles, rather than discarding a possible visible mark.
    state.holdUntil = performance.now() + 900;
  }
}

function clearSeries(showToast = true) {
  if (state.editor) closeEditor(false);
  if (state.geometryMismatch) {
    pause('Kadar je promijenjen. Ponovo podesi metu.');
    state.calibrated = false;
    state.geometryMismatch = false;
    state.alignment = { x: 0, y: 0 };
  }
  state.shots = []; state.marks = []; resetPending();
  drawRaw(); reference(); renderHistory();
  if (showToast) toast('Nova serija je spremna.');
}

async function openCamera(deviceId) {
  if (state.editor) closeEditor(false);
  if (state.opening) return;
  state.opening = true; $('cameraButton').disabled = true;
  pause('Otvaram kameru…');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera je dostupna preko HTTPS linka u podržanom pregledniku.');
    state.stream?.getTracks().forEach(t => t.stop());
    state.stream = null;
    video.srcObject = null;
    state.frameReady = false;
    const constraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...constraints, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    state.mode = 'camera'; state.calibration = DEFAULT(); state.calibrated = false; state.calibrating = 0;
    state.alignment = { x: 0, y: 0 }; state.focusRequest = null; state.geometryMismatch = false;
    state.zoom = 1; state.nativeZoom = false; resetPending();
    const track = stream.getVideoTracks()[0];
    const capabilities = track.getCapabilities?.() || {};
    const zoom = capabilities.zoom;
    if (zoom && Number.isFinite(zoom.min) && Number.isFinite(zoom.max)) {
      state.nativeZoom = true;
      state.zoom = track.getSettings().zoom ?? Math.max(1, zoom.min);
      $('zoomRange').min = zoom.min; $('zoomRange').max = zoom.max; $('zoomRange').step = zoom.step || .1;
      $('zoomHelp').textContent = 'Zum koji je kamera izložila pregledniku.';
    } else {
      $('zoomRange').min = 1; $('zoomRange').max = 8; $('zoomRange').step = .1;
      $('zoomHelp').textContent = 'Digitalno uvećanje prikaza. Drugu kameru možeš izabrati iz liste.';
    }
    $('zoomRange').disabled = false; $('zoomRange').value = state.zoom;
    $('zoomValue').textContent = `${Number(state.zoom).toFixed(1)}×`;
    $('sourceBadge').textContent = 'KAMERA · UŽIVO';
    $('demoMarkButton').hidden = true;
    $('cameraButton').textContent = 'Osvježi kameru';
    $('calibrationHint').textContent = 'Namjesti kadar, pa dodirni „Podesi linije“.';
    $('cameraSelect').replaceChildren();
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    for (const [i, d] of devices.entries()) $('cameraSelect').add(new Option(d.label || `Kamera ${i + 1}`, d.deviceId));
    $('cameraSelect').value = track.getSettings().deviceId || deviceId || '';
    $('cameraSelect').hidden = devices.length < 2;
    track.addEventListener('ended', () => { if (state.mode === 'camera' && state.stream?.getVideoTracks()[0] === track) { pause('Kamera je zaustavljena. Ponovo je uključi.'); state.frameReady = false; } });
    clearSeries(false); ringFields();
    updateFocusUI();
    setStatus('ready', 'Kamera je uključena', 'Namjesti kadar i podesi bodovne krugove mete.');
  } catch (error) {
    const message = error.name === 'NotAllowedError' ? 'Dozvoli pristup kameri u postavkama preglednika, pa pokušaj ponovo.'
      : error.name === 'NotFoundError' ? 'Preglednik nije pronašao kameru.'
      : error.name === 'NotReadableError' ? 'Kameru koristi druga aplikacija. Zatvori je i pokušaj ponovo.'
      : error.message || 'Kamera nije dostupna. Pokušaj otvoriti link direktno u Safariju.';
    setStatus('error', 'Kamera nije pokrenuta', message); toast(message);
  } finally { state.opening = false; $('cameraButton').disabled = false; }
}

function demo() {
  if (state.editor) closeEditor(false);
  pause(); state.stream?.getTracks().forEach(t => t.stop()); state.stream = null; video.srcObject = null;
  state.mode = 'demo'; state.calibrating = 0; state.calibrated = true; state.calibration = DEFAULT(); state.demoTarget = DEFAULT();
  state.alignment = { x: 0, y: 0 }; state.focusRequest = null; state.geometryMismatch = false;
  state.zoom = 1; state.nativeZoom = false;
  $('zoomRange').min = 1; $('zoomRange').max = 6; $('zoomRange').value = 1; $('zoomRange').disabled = true; $('zoomValue').textContent = '1.0×';
  $('zoomHelp').textContent = 'Uvećanje je dostupno kada uključiš kameru.';
  $('sourceBadge').textContent = 'DEMO · SIMULIRANA SLIKA';
  $('demoMarkButton').hidden = false; $('cameraSelect').hidden = true;
  $('cameraButton').textContent = 'Uključi kameru';
  $('calibrationHint').textContent = 'Probna meta je već podešena. Dodaj trag da isprobaš očitavanje.';
  $('calibrationButton').textContent = 'Podesi linije';
  canvas.style.cursor = 'default';
  clearSeries(false); ringFields();
  updateFocusUI();
  setStatus('ready', 'Isprobaj bez kamere', 'Dodaj probni trag ili uključi kameru svog telefona.');
}

$('cameraButton').addEventListener('click', () => openCamera());
$('cameraSelect').addEventListener('change', () => openCamera($('cameraSelect').value));
$('demoButton').addEventListener('click', demo);
$('monitorButton').addEventListener('click', () => state.active ? pause() : start());
$('referenceButton').addEventListener('click', () => {
  if (state.calibrating) return toast('Prvo završi podešavanje mete.');
  if (state.geometryMismatch) { calibrate(); return; }
  state.viewRevision++;
  resetPending(); if (reference()) { toast('Trenutna slika je postavljena kao početno stanje.'); setStatus(state.active ? 'live' : 'ready', 'Referentna slika spremljena', state.active ? 'Pratim nove promjene.' : 'Dodirni „Pokreni praćenje“.'); }
});
$('calibrationButton').addEventListener('click', calibrate);
$('focusButton').addEventListener('click', () => focusAt(.5, .5));
$('adjustLinesButton').addEventListener('click', calibrate);
$('targetPreset').addEventListener('change', changeTargetPreset);
$('scoreEndSelect').addEventListener('change', changeScoreRange);
$('autoLinesButton').addEventListener('click', recognizeLines);
$('applyLinesButton').addEventListener('click', () => closeEditor(true));
$('cancelLinesButton').addEventListener('click', () => closeEditor(false));
$('selectedRing').addEventListener('change', () => { if (state.editor) { state.editor.selected = Number($('selectedRing').value); syncEditor(); } });
$('editorAction').addEventListener('change', () => syncEditor());
$('minusButton').addEventListener('click', () => fineAdjust(-1));
$('plusButton').addEventListener('click', () => fineAdjust(1));
$('resetCalibrationButton').addEventListener('click', () => {
  if (!state.editor || state.editor.busy) return;
  state.editor.draft = targetPreset($('targetPreset').value, 11 - state.editor.draft.rings.length); state.editor.selected = state.editor.draft.rings.length - 1;
  syncEditor(true);
});
$('zoomRange').addEventListener('input', () => {
  if (state.mode !== 'camera') return;
  state.viewRevision++;
  state.alignment = { x: 0, y: 0 };
  state.geometryMismatch = false;
  pause('Kadar je promijenjen. Ponovo podesi metu.'); resetPending(); state.calibrated = false; state.calibrating = 0;
  state.zoom = Number($('zoomRange').value); $('zoomValue').textContent = `${state.zoom.toFixed(1)}×`;
  $('calibrationHint').textContent = 'Zum je promijenjen. Ponovo dodirni „Podesi linije“.';
  if (state.nativeZoom) {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(async () => {
      try { await state.stream?.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: state.zoom }] }); }
      catch {
        state.zoom = state.stream?.getVideoTracks()[0].getSettings().zoom || 1;
        $('zoomRange').value = state.zoom;
        $('zoomValue').textContent = `${Number(state.zoom).toFixed(1)}×`;
        toast('Preglednik nije prihvatio taj nivo zuma.');
      }
    }, 160);
  }
});
$('thresholdRange').addEventListener('input', () => { $('thresholdValue').textContent = $('thresholdRange').value; });
$('testSoundButton').addEventListener('click', () => speak(9, true));
$('soundToggle').addEventListener('change', () => { if ($('soundToggle').checked) speak(10, true); else window.speechSynthesis?.cancel(); });
$('confirmButton').addEventListener('click', () => { if (state.pending) record(state.pending, Number($('pendingScore').value)); });
$('dismissButton').addEventListener('click', () => { resetPending(); reference(); setStatus(state.active ? 'live' : 'idle', 'Promjena odbačena', 'Trenutna slika je novo početno stanje.'); });
$('clearButton').addEventListener('click', () => clearSeries());
$('deleteLastButton').addEventListener('click', () => { state.shots.pop(); renderHistory(); toast('Zadnji upis je poništen.'); });
$('demoMarkButton').addEventListener('click', () => {
  if (state.demoBusy) return toast('Sačekaj očitavanje prethodnog traga.');
  if (state.pending) return toast('Prvo potvrdi ili odbaci prethodni trag.');
  if (state.calibrating) return toast('Prvo završi podešavanje mete.');
  if (!state.active && !start()) return;
  const points = [[.515,.52],[.555,.555],[.41,.54],[.66,.44],[.52,.38],[.37,.36],[.6,.68],[.31,.53],[.68,.62],[.43,.69]];
  let point = points[state.marks.length % points.length];
  if (state.marks.length >= points.length) {
    let attempts = 0;
    do { const angle = Math.random() * Math.PI * 2, r = Math.random() * .34; point = [.5 + Math.cos(angle) * r, .5 + Math.sin(angle) * r]; attempts++; }
    while (state.marks.some(m => Math.hypot(m.x - point[0], m.y - point[1]) < .04) && attempts < 80);
  }
  state.marks.push({ x: point[0], y: point[1] });
  state.demoBusy = true;
  setTimeout(() => { state.demoBusy = false; }, 1000);
  state.holdUntil = Math.max(state.holdUntil, performance.now() + 80);
});
$('exportButton').addEventListener('click', () => {
  if (!state.shots.length) return;
  const lines = ['Redni broj,Bodovi,Vrijeme,Izvor,X,Y', ...state.shots.map((s, i) => `${i + 1},${s.score},${s.time},${s.source},${s.x.toFixed(5)},${s.y.toFixed(5)}`)];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `meta-${state.mode}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && state.active) pause('Praćenje je pauzirano dok je aplikacija u pozadini.'); });
window.addEventListener('pagehide', () => { pause(); state.stream?.getTracks().forEach(t => t.stop()); });
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', populateVoices);
populateVoices(); demo(); requestAnimationFrame(frame);
