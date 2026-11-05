/*
 * Kybernetes: wiring. The page holds one architecture (the web and its
 * initial conditions), hands it to the signal engine, and draws what the
 * engine reports. The helm is the steersman's: a few slow controls that
 * nudge the running system from one equilibrium toward another.
 */
import { Engine } from './engine.js';
import { PRESETS, defaultArch, deriveArch, normalizeArch, encodeArch, decodeArch, SOURCES, DESTS, eraName } from './state.js';
import { Knob, fmt } from './ui/knob.js';
import { Matrix } from './ui/matrix.js';
import { Bank } from './ui/bank.js';
import { Observatory } from './ui/observatory.js';
import { Chronicle } from './ui/chronicle.js';
import { Trace } from './ui/trace.js';
import { buildArchitecture } from './ui/architect.js';
import { EpochWatch, roman } from './epochs.js';
import { readTheme } from './ui/theme.js';

const STORE_KEY = 'kybernetes.architecture.v1';
const $ = (sel) => document.querySelector(sel);

readTheme();

/* ---------- the architecture ---------- */

function loadStored() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalizeArch(JSON.parse(raw));
  } catch { /* storage unavailable or corrupt: start from the default */ }
  return defaultArch();
}
let arch = loadStored();
const getArch = () => arch;

let saveT = 0;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(arch)); } catch { /* not persisted */ }
  }, 600);
}

const engine = new Engine();
let postPending = false;
function changed() {
  save();
  if (postPending) return;
  postPending = true;
  requestAnimationFrame(() => {
    postPending = false;
    engine.setArch(arch);
  });
}

/* ---------- logbook and notices ---------- */

const logEl = $('#log');
let elapsed = 0;
function clock(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}
function log(text, kind = 'system') {
  const li = document.createElement('li');
  li.className = `log__item log__item--${kind}`;
  const t = document.createElement('time');
  t.textContent = clock(elapsed);
  const p = document.createElement('span');
  p.textContent = text;
  li.append(t, p);
  logEl.prepend(li);
  while (logEl.children.length > 300) logEl.lastChild.remove();
}
const toast = $('#toast');
let toastT = 0;
function notify(text, kind = 'system') {
  log(text, kind === 'error' ? 'error' : 'system');
  toast.textContent = text;
  toast.dataset.kind = kind;
  toast.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { toast.hidden = true; }, kind === 'error' ? 7000 : 4000);
}

/* ---------- the helm ---------- */

const HELM = [
  { key: 'inflow', label: 'Inflow', min: 0, max: 1.5, format: fmt.pct, title: 'How much of the multiplier cascade enters the loop' },
  { key: 'bias', label: 'Bias', min: -1, max: 1, format: fmt.volt, title: 'A master voltage added to every eye before the matrix. It shifts the operating point of the whole web.' },
  { key: 'drift', label: 'Drift', min: -24, max: 24, format: fmt.st, title: 'Transposes every generator, gliding very slowly' },
  { key: 'setpoint', label: 'Setpoint', min: -40, max: -6, format: fmt.db, title: 'The level the homeostat breathes around, like a thermostat’s dial' },
  { key: 'coupling', label: 'Coupling', min: 0, max: 2, format: fmt.x, title: 'How strongly every eye turns every knob' },
  { key: 'era', label: 'Era', min: 0.25, max: 64, curve: 'log', format: (v) => `×${v < 1 ? v.toFixed(2) : v.toFixed(1)} ${eraName(v)}`, title: 'Stretches every slow process: release, breath, glide, habituation' },
];
const HELM_INDEX = { inflow: 0, bias: 1, drift: 2, setpoint: 3, coupling: 4, era: 5, volume: 6 };
const helmKnobs = {};
const helmDefaults = defaultArch().helm;

function helmChanged() {
  save();
  engine.setHelm(arch.helm);
  updateEra();
}
function helmCommitted(def, v) {
  const text = `Steersman · ${def.label} → ${def.format(v)}`;
  log(text, 'helm');
  chronicle.mark(elapsed, 'helm', def.label);
}

const helmGrid = $('#helm-knobs');
for (const def of HELM) {
  const k = new Knob({
    ...def,
    id: `helm-${def.key}`,
    size: 'lg',
    default: helmDefaults[def.key],
    value: arch.helm[def.key],
    onInput: (v) => { arch.helm[def.key] = v; helmChanged(); },
    onCommit: (v) => helmCommitted(def, v),
  });
  helmKnobs[def.key] = k;
  helmGrid.append(k.el);
}
const volDef = { key: 'volume', label: 'Level', min: 0, max: 1, format: fmt.pct };
helmKnobs.volume = new Knob({
  ...volDef,
  id: 'helm-volume',
  size: 'md',
  default: 0.7,
  value: arch.helm.volume,
  title: 'Output level. This one does not glide.',
  onInput: (v) => { arch.helm.volume = v; helmChanged(); },
});
$('#helm-level').append(helmKnobs.volume.el);

function updateEra() {
  const e = arch.helm.era;
  $('#era-read').textContent = `×${e < 1 ? e.toFixed(2) : e.toFixed(1)} ${eraName(e)}`;
}
updateEra();

/* ---------- the visible system ---------- */

const observatory = new Observatory($('#obs-back'), $('#obs-front'), { getArch });
const matrix = new Matrix($('#matrix'), $('#matrix-inspector'), { sources: SOURCES, dests: DESTS, getArch, onChange: changed });
const bank = new Bank($('#bank'), $('#bank-read'), { getArch, onChange: changed });
const chronicle = new Chronicle($('#chronicle'), $('#chronicle-cap'));
const trace = new Trace($('#trace'));
const watch = new EpochWatch();

function syncAll() {
  architecture.sync();
  for (const [key, k] of Object.entries(helmKnobs)) k.set(arch.helm[key], { silent: true });
  updateEra();
  $('#arch-name').textContent = arch.name;
}
const architecture = buildArchitecture($('#cards'), { getArch, changed, engine, notify, syncAll: () => syncAll() });
architecture.sync();
$('#arch-name').textContent = arch.name;

/* bank tools */
$('#bank-flatten').addEventListener('click', () => { arch.bank.gains = arch.bank.gains.map(() => 0.6); changed(); log('Architect · bank flattened'); });
$('#bank-invert').addEventListener('click', () => {
  const g = arch.bank.gains, mx = Math.max(...g), mn = Math.min(...g);
  arch.bank.gains = g.map((v) => +(mx + mn - v).toFixed(3));
  changed();
  log('Architect · carving inverted');
});
$('#bank-smooth').addEventListener('click', () => {
  const g = arch.bank.gains;
  arch.bank.gains = g.map((v, k) => +((g[Math.max(0, k - 1)] + 2 * v + g[Math.min(g.length - 1, k + 1)]) / 4).toFixed(3));
  changed();
});

/* chronicle span */
for (const b of document.querySelectorAll('[name="span"]')) {
  b.addEventListener('change', () => { if (b.checked) chronicle.setSpan(b.value); });
}

/* ---------- running ---------- */

const engageBtn = $('#engage');
const perturbBtns = document.querySelectorAll('[data-perturb]');
const stateChip = $('#state-chip');
let everRan = false;
let wakeLock = null;

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && engine.running) keepAwake();
});

function setRunning(on) {
  engageBtn.textContent = on ? 'Halt' : everRan ? 'Resume' : 'Engage';
  engageBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  document.body.classList.toggle('is-running', on);
  stateChip.textContent = on ? 'Running' : everRan ? 'Halted' : 'Ready';
  for (const b of perturbBtns) b.disabled = !on;
}

engageBtn.addEventListener('click', async () => {
  if (engine.running) {
    engine.halt();
    log(`System halted after ${clock(elapsed)}.`);
    wakeLock?.release?.();
    return;
  }
  engageBtn.disabled = true;
  try {
    await engine.engage(arch);
    log(everRan ? 'System resumed.' : `System engaged with “${arch.name}”. The loop is closed.`);
    everRan = true;
    keepAwake();
  } catch (err) {
    notify(`The audio engine could not start: ${err.message}`, 'error');
  } finally {
    engageBtn.disabled = false;
  }
});
engine.addEventListener('state', (e) => setRunning(e.detail.running));

function perturb() {
  if (!engine.running) return;
  engine.perturb();
  log('Steersman · perturbation struck into the loop', 'helm');
  chronicle.mark(elapsed, 'helm', 'Perturb');
}
for (const b of perturbBtns) b.addEventListener('click', perturb);

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, select, textarea, [role="slider"], canvas')) return;
  if (e.key === ' ') {
    if (t.closest?.('button, label, a, summary')) return;
    e.preventDefault();
    engageBtn.click();
  } else if (e.key === 'p' || e.key === 'P') perturb();
});

/* ---------- frames from the engine ---------- */

let frame = null;
let lastPanel = 0;
let lastClampNote = -1e9;
engine.addEventListener('frame', (e) => {
  frame = e.detail;
  elapsed = frame.el;
  chronicle.push(frame);
  trace.push(frame);
  const ev = watch.update(frame);
  if (ev) {
    log(ev.text, 'epoch');
    if (ev.type === 'settle') {
      chronicle.mark(ev.t, 'epoch', roman(ev.epoch));
      $('#epoch').textContent = `${roman(ev.epoch)} · ${ev.desc.colour}`;
    } else {
      $('#epoch').textContent = `${roman(ev.epoch)} → ?`;
    }
  }
  if (frame.stat[3] < 0.35 && elapsed - lastClampNote > 45) {
    lastClampNote = elapsed;
    log('The loop pushed past its ceiling. The homeostat clamped it hard.', 'event');
  }
  for (const [key, k] of Object.entries(helmKnobs)) k.setActual(frame.helm[HELM_INDEX[key]]);
  const now = performance.now();
  if (now - lastPanel > 100) {
    lastPanel = now;
    architecture.update(frame);
    $('#elapsed').textContent = clock(elapsed);
    const s = frame.stat;
    $('#trace-read').textContent = `loop ${s[0].toFixed(1)} dB · setpoint ${frame.helm[3].toFixed(1)} dB · ${s[13] > 0.5 ? 'inhaling' : 'exhaling'} · breath ${Math.round(s[14])}`;
  }
});
engine.addEventListener('captured', (e) => {
  arch.reels[e.detail.reel].mode = 'tape';
  syncAll();
  changed();
  notify(`Reel ${e.detail.reel + 1} captured ${e.detail.seconds.toFixed(1)} s from the microphone.`);
});

/* ---------- drawing ---------- */

function draw() {
  const scope = engine.running && engine.readScope() ? [engine.scopeL, engine.scopeR] : null;
  observatory.draw(frame, scope);
  matrix.draw(frame, frame?.helm);
  bank.draw(frame);
  trace.draw(arch.helm.setpoint);
  chronicle.draw();
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

/* ---------- architectures: load, derive, share, reset ---------- */

const presetSel = $('#arch-preset');
for (const [i, p] of PRESETS.entries()) {
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = p.name;
  presetSel.append(o);
}
const presetNote = $('#arch-preset-note');
const showPresetNote = () => { presetNote.textContent = PRESETS[+presetSel.value].description; };
presetSel.addEventListener('change', showPresetNote);
const idx = PRESETS.findIndex((p) => p.name === arch.name);
presetSel.value = String(Math.max(0, idx));
showPresetNote();

function adopt(next, how) {
  arch = next;
  save();
  engine.setArch(arch);
  syncAll();
  matrix.sel = null;
  matrix.hover = null;
  matrix.updateInspector();
  const live = engine.running ? ' The running system moves toward it.' : '';
  notify(`${how} “${arch.name}”.${live}`);
  chronicle.mark(elapsed, 'epoch', '◇');
}

$('#arch-load').addEventListener('click', () => adopt(PRESETS[+presetSel.value].build(), 'Architecture loaded:'));
$('#arch-derive-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const word = $('#arch-derive').value.trim();
  if (!word) { notify('Type a name first. The same name always gives the same architecture.', 'error'); return; }
  adopt(deriveArch(word), 'Architecture derived from');
});

const codeBox = $('#arch-code');
const codeRow = $('#arch-code-row');
$('#arch-copy').addEventListener('click', async () => {
  const code = encodeArch(arch);
  codeRow.hidden = false;
  codeBox.value = code;
  try {
    await navigator.clipboard.writeText(code);
    notify('Architecture code copied. Paste it here, or share it, to rebuild this exact web.');
  } catch {
    codeBox.focus();
    codeBox.select();
    notify('Copying is blocked here. The code is selected in the box; copy it from there.');
  }
});
$('#arch-paste').addEventListener('click', () => {
  codeRow.hidden = false;
  codeBox.value = '';
  codeBox.focus();
});
$('#arch-apply').addEventListener('click', () => {
  try {
    adopt(decodeArch(codeBox.value), 'Architecture applied:');
    codeRow.hidden = true;
  } catch (err) {
    notify(`That code could not be read. ${err.message}`, 'error');
  }
});
$('#arch-code-close').addEventListener('click', () => { codeRow.hidden = true; });

const resetConfirm = $('#reset-confirm');
$('#arch-reset').addEventListener('click', () => { resetConfirm.hidden = false; });
$('#reset-cancel').addEventListener('click', () => { resetConfirm.hidden = true; });
$('#reset-go').addEventListener('click', () => {
  resetConfirm.hidden = true;
  engine.reset();
  chronicle.reset();
  trace.reset();
  watch.reset();
  elapsed = 0;
  $('#elapsed').textContent = clock(0);
  $('#epoch').textContent = '—';
  log('Run reset. Tape and reel memory cleared, the clock restarted.');
});

/* ---------- recording ---------- */

const recBtn = architecture.live.recBtn;
const recInfo = architecture.live.recInfo;
let recTimer = 0;
recBtn.addEventListener('click', async () => {
  if (engine.recorder) {
    clearInterval(recTimer);
    const blob = await engine.stopRecording();
    recBtn.textContent = 'Record output';
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    const a = document.createElement('a');
    a.href = url;
    a.download = `kybernetes-${arch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.${ext}`;
    a.textContent = `Save recording (${(blob.size / 1048576).toFixed(1)} MB)`;
    recInfo.replaceChildren(a);
    if (window.top !== window.self) recInfo.append(' If saving does nothing in this view, open the instrument on its own page.');
    log('Recording stopped.');
    return;
  }
  if (!engine.running) { notify('Engage the system before recording.', 'error'); return; }
  try {
    engine.startRecording();
    recBtn.textContent = 'Stop recording';
    const t0 = performance.now();
    recInfo.textContent = 'Recording 00:00:00';
    recTimer = setInterval(() => { recInfo.textContent = `Recording ${clock((performance.now() - t0) / 1000)}`; }, 1000);
    log('Recording started.');
  } catch (err) {
    notify(err.message, 'error');
  }
});

/* ---------- first words ---------- */

setRunning(false);
log(`Architecture ready: “${arch.name}”. Engage to close the loop.`);
