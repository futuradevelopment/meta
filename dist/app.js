import { ChangeDetector, scorePoint } from './vision.js';

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
const DEFAULT = () => ({ cx: .5, cy: .5, radius: .425, rings: Array.from({ length: 10 }, (_, i) => (i + 1) / 10) });
const state = {
  mode: 'demo', stream: null, active: false, opening: false, calibration: DEFAULT(),
  calibrated: true, calibrating: 0, pending: null, shots: [], marks: [],
  zoom: 1, nativeZoom: false, lastAnalysis: 0, holdUntil: 0, wakeLock: null,
  frameReady: false, lastStatus: '', flashUntil: 0,
  viewRevision: 0,
};
let toastTimer;
let zoomTimer;
const phrases = ['Izvan krugova', 'jedan', 'dva', 'tri', 'četiri', 'pet', 'šest', 'sedam', 'osam', 'devet', 'deset'];

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

function reference() {
  if (!state.frameReady) { toast('Sačekaj da se pojavi slika kamere.'); return false; }
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
  if (state.calibrating) { toast('Prvo završi podešavanje krugova.'); return false; }
  if (!state.calibrated) { toast('Prvo dodirni „Podesi metu“ i označi krugove.'); return false; }
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
    $('candidateInfo').textContent = `Nova vidljiva promjena · procjena ${score} bodova.`;
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

function drawDemo() {
  const w = raw.width;
  rawCtx.fillStyle = '#e8e5dc'; rawCtx.fillRect(0, 0, w, w);
  rawCtx.fillStyle = '#f3f1e9'; rawCtx.fillRect(23, 23, w - 46, w - 46);
  const { cx, cy, radius } = DEFAULT();
  for (let i = 10; i >= 1; i--) {
    rawCtx.beginPath(); rawCtx.arc(cx * w, cy * w, radius * w * i / 10, 0, Math.PI * 2);
    rawCtx.fillStyle = i <= 5 ? '#23272a' : '#f3f1e9'; rawCtx.fill();
    rawCtx.strokeStyle = i <= 5 ? '#afb0a7' : '#616864'; rawCtx.lineWidth = 1; rawCtx.stroke();
    if (i > 1) {
      rawCtx.fillStyle = i <= 5 ? '#b9bbb1' : '#747b73'; rawCtx.font = '11px ui-monospace, monospace'; rawCtx.textAlign = 'center';
      rawCtx.fillText(String(11 - i), w / 2, w / 2 - radius * w * (i - .5) / 10 + 4);
      rawCtx.fillText(String(11 - i), w / 2 + radius * w * (i - .5) / 10, w / 2 + 4);
    }
  }
  rawCtx.fillStyle = '#c4c8bb'; rawCtx.font = '10px ui-monospace, monospace'; rawCtx.fillText('10', w / 2, w / 2 + 4);
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

function drawOverlay(now) {
  const size = canvas.width;
  ctx.drawImage(raw, 0, 0, size, size);
  const c = state.calibration;
  if (state.calibrated || state.calibrating) {
    ctx.save();
    ctx.strokeStyle = state.calibrating ? '#d7f879' : 'rgba(132,178,158,.58)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash(state.calibrating ? [5, 5] : []);
    if (state.calibrating !== 2) for (const r of c.rings) {
      ctx.beginPath(); ctx.arc(c.cx * size, c.cy * size, c.radius * r * size, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = '#d7f879'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(c.cx * size - 8, c.cy * size); ctx.lineTo(c.cx * size + 8, c.cy * size); ctx.moveTo(c.cx * size, c.cy * size - 8); ctx.lineTo(c.cx * size, c.cy * size + 8); ctx.stroke();
    ctx.restore();
  }
  for (let i = 0; i < state.shots.length; i++) {
    const s = state.shots[i];
    if (s.viewRevision !== state.viewRevision) continue;
    marker(s.x, s.y, String(i + 1), i === state.shots.length - 1 ? '#e9ff9a' : '#f8a879');
  }
  if (state.pending) marker(state.pending.x, state.pending.y, '?', '#ffce6b');
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
  drawRaw();
  if (state.active && !state.pending && state.frameReady && now - state.lastAnalysis > 120 && now > state.holdUntil) {
    state.lastAnalysis = now;
    const result = detector.analyze(currentFrame(), state.calibration, { threshold: Number($('thresholdRange').value) }, now);
    if (result.status === 'candidate') onCandidate(result.candidate);
    else if (result.status === 'movement') setStatus('motion', 'Slika se promijenila', 'Sačekaj stabilnu sliku. Ako je kadar pomjeren, postavi novu referentnu sliku.');
    else if (result.status === 'stable') setStatus('live', 'Pratim promjene', state.mode === 'demo' ? 'Probni prikaz · dodaj trag da isprobaš očitavanje.' : 'Slika je stabilna. Čekam novu vidljivu promjenu.');
  }
  drawOverlay(now);
  requestAnimationFrame(frame);
}

function ringFields() {
  $('ringInputs').replaceChildren();
  state.calibration.rings.forEach((r, i) => {
    const label = document.createElement('label');
    label.className = 'ring-field';
    label.textContent = `${10 - i} bodova`;
    const input = document.createElement('input');
    input.type = 'number'; input.min = '1'; input.max = '100'; input.step = '0.5'; input.value = +(r * 100).toFixed(1); input.setAttribute('aria-label', `Poluprečnik kruga ${10 - i}, u procentima vanjskog kruga`);
    if (i === 9) input.disabled = true;
    input.addEventListener('change', () => {
      const value = Number(input.value) / 100;
      const previous = i ? state.calibration.rings[i - 1] : 0;
      const next = state.calibration.rings[i + 1] ?? 1.01;
      if (!Number.isFinite(value) || value <= previous || value >= next) { input.value = r * 100; toast('Krug mora biti između susjednih krugova.'); return; }
      pause('Krugovi su izmijenjeni. Pokreni praćenje kada završiš.');
      resetPending(); state.calibration.rings[i] = value; r = value; reference();
    });
    label.append(input); $('ringInputs').append(label);
  });
}

function calibrate() {
  if (!state.frameReady) return toast('Prvo uključi kameru.');
  pause('Podešavanje mete je u toku.'); resetPending();
  state.viewRevision++;
  state.calibrating = 1;
  canvas.style.cursor = 'crosshair';
  $('calibrationHint').textContent = '1 / 2 · Dodirni tačan centar mete na slici.';
  $('calibrationButton').textContent = 'Ponovi podešavanje';
  setStatus('setup', 'Označi centar', 'Dodirni centar mete, zatim vanjski rub kruga koji vrijedi 1 bod.');
}

canvas.addEventListener('pointerdown', e => {
  if (!state.calibrating) return;
  const box = canvas.getBoundingClientRect();
  const x = (e.clientX - box.left) / box.width, y = (e.clientY - box.top) / box.height;
  if (state.calibrating === 1) {
    state.calibration.cx = x; state.calibration.cy = y; state.calibrating = 2;
    $('calibrationHint').textContent = '2 / 2 · Dodirni vanjski rub bodovnog kruga 1.';
    setStatus('setup', 'Označi vanjski krug', 'Dodirni vanjsku liniju kruga koji vrijedi 1 bod.');
  } else {
    const radius = Math.hypot(x - state.calibration.cx, y - state.calibration.cy);
    if (radius < .08) return toast('Odaberi vanjski krug, dalje od centra.');
    const edge = Math.min(state.calibration.cx, 1 - state.calibration.cx, state.calibration.cy, 1 - state.calibration.cy);
    if (radius > edge + .015) return toast('Cijela bodovna meta treba biti unutar kadra. Prilagodi kadar i ponovi podešavanje.');
    state.calibration.radius = radius; state.calibrating = 0; state.calibrated = true;
    canvas.style.cursor = 'default';
    $('calibrationHint').textContent = 'Krugovi su podešeni. Provjeri preklapanje linija; razmake možeš prilagoditi ispod.';
    $('calibrationButton').textContent = 'Podesi metu';
    reference(); setStatus('ready', 'Meta je spremna', 'Dodirni „Pokreni praćenje“.');
  }
});

function clearSeries(showToast = true) {
  state.shots = []; state.marks = []; resetPending();
  drawRaw(); reference(); renderHistory();
  if (showToast) toast('Nova serija je spremna.');
}

async function openCamera(deviceId) {
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
    $('calibrationHint').textContent = 'Namjesti kadar, pa dodirni „Podesi metu“.';
    $('cameraSelect').replaceChildren();
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    for (const [i, d] of devices.entries()) $('cameraSelect').add(new Option(d.label || `Kamera ${i + 1}`, d.deviceId));
    $('cameraSelect').value = track.getSettings().deviceId || deviceId || '';
    $('cameraSelect').hidden = devices.length < 2;
    track.addEventListener('ended', () => { if (state.mode === 'camera' && state.stream?.getVideoTracks()[0] === track) { pause('Kamera je zaustavljena. Ponovo je uključi.'); state.frameReady = false; } });
    clearSeries(false); ringFields();
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
  pause(); state.stream?.getTracks().forEach(t => t.stop()); state.stream = null; video.srcObject = null;
  state.mode = 'demo'; state.calibrating = 0; state.calibrated = true; state.calibration = DEFAULT();
  state.zoom = 1; state.nativeZoom = false;
  $('zoomRange').min = 1; $('zoomRange').max = 6; $('zoomRange').value = 1; $('zoomRange').disabled = true; $('zoomValue').textContent = '1.0×';
  $('zoomHelp').textContent = 'Uvećanje je dostupno kada uključiš kameru.';
  $('sourceBadge').textContent = 'DEMO · SIMULIRANA SLIKA';
  $('demoMarkButton').hidden = false; $('cameraSelect').hidden = true;
  $('cameraButton').textContent = 'Uključi kameru';
  $('calibrationHint').textContent = 'Probna meta je već podešena. Dodaj trag da isprobaš očitavanje.';
  $('calibrationButton').textContent = 'Podesi metu';
  canvas.style.cursor = 'default';
  clearSeries(false); ringFields();
  setStatus('ready', 'Isprobaj bez kamere', 'Dodaj probni trag ili uključi kameru svog telefona.');
}

$('cameraButton').addEventListener('click', () => openCamera());
$('cameraSelect').addEventListener('change', () => openCamera($('cameraSelect').value));
$('demoButton').addEventListener('click', demo);
$('monitorButton').addEventListener('click', () => state.active ? pause() : start());
$('referenceButton').addEventListener('click', () => {
  if (state.calibrating) return toast('Prvo završi podešavanje mete.');
  state.viewRevision++;
  resetPending(); if (reference()) { toast('Trenutna slika je postavljena kao početno stanje.'); setStatus(state.active ? 'live' : 'ready', 'Referentna slika spremljena', state.active ? 'Pratim nove promjene.' : 'Dodirni „Pokreni praćenje“.'); }
});
$('calibrationButton').addEventListener('click', calibrate);
$('resetCalibrationButton').addEventListener('click', () => {
  pause(); state.calibration = DEFAULT(); state.calibrated = state.mode === 'demo'; state.calibrating = 0; resetPending(); ringFields();
  $('calibrationHint').textContent = state.calibrated ? 'Vraćeni su krugovi probne mete.' : 'Dodirni „Podesi metu“ da označiš stvarnu metu.';
  canvas.style.cursor = 'default'; $('calibrationButton').textContent = 'Podesi metu'; reference();
});
$('zoomRange').addEventListener('input', () => {
  if (state.mode !== 'camera') return;
  state.viewRevision++;
  pause('Kadar je promijenjen. Ponovo podesi metu.'); resetPending(); state.calibrated = false; state.calibrating = 0;
  state.zoom = Number($('zoomRange').value); $('zoomValue').textContent = `${state.zoom.toFixed(1)}×`;
  $('calibrationHint').textContent = 'Zum je promijenjen. Ponovo dodirni „Podesi metu“.';
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
