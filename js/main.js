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
import { History, describe } from './history.js';

const STORE_KEY = 'kybernetes.architecture.v1';
const SNAP_KEY = 'kybernetes.snapshots.v1';
const $ = (sel) => document.querySelector(sel);

readTheme();

/* ---------- the architecture ---------- */

let previousArch = null;
function loadStored() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      // Architectures saved before the calmer defaults are kept as a
      // snapshot, and the instrument starts from the new default.
      if ((stored.v || 1) < 4) { previousArch = normalizeArch(stored); return defaultArch(); }
      return normalizeArch(stored);
    }
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
let history = null;
/* Every edit lands here. A finished edit (commit) becomes one undo step. */
function changed(path, commit, label) {
  save();
  if (commit && history) history.commit(describe(path || '', label));
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
  history.commit(`Helm ${def.label}`);
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
  default: 0.85,
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
const matrix = new Matrix($('#matrix'), $('#matrix-inspector'), {
  sources: SOURCES, dests: DESTS, getArch, onChange: () => changed(), onCommit: (label) => history.commit(label),
});
const bank = new Bank($('#bank'), $('#bank-read'), { getArch, onChange: (commit) => changed('bank', commit, 'carving') });
const chronicle = new Chronicle($('#chronicle'), $('#chronicle-cap'), { onPick: (id) => recallSnapshot(id) });
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

/* ---------- undo and redo ---------- */

function restore(next) {
  arch = next;
  save();
  engine.setArch(arch);
  engine.setHelm(arch.helm);
  syncAll();
  matrix.sel = null;
  matrix.hover = null;
  matrix.updateInspector();
}
history = new History(getArch, restore);
const undoBtn = $('#undo'), redoBtn = $('#redo');
function refreshHistory() {
  undoBtn.disabled = !history.canUndo;
  redoBtn.disabled = !history.canRedo;
  const u = history.undoLabel, r = history.redoLabel;
  undoBtn.title = u ? `Undo ${u} (Ctrl+Z)` : 'Nothing to undo';
  redoBtn.title = r ? `Redo ${r} (Ctrl+Shift+Z)` : 'Nothing to redo';
  undoBtn.setAttribute('aria-label', u ? `Undo ${u}` : 'Undo');
  redoBtn.setAttribute('aria-label', r ? `Redo ${r}` : 'Redo');
}
history.addEventListener('change', refreshHistory);
function undo() {
  const label = history.undo();
  if (label) log(`Undo · ${label}`, 'helm');
}
function redo() {
  const label = history.redo();
  if (label) log(`Redo · ${label}`, 'helm');
}
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
refreshHistory();

/* bank tools */
$('#bank-flatten').addEventListener('click', () => { arch.bank.gains = arch.bank.gains.map(() => 0.6); changed('bank', true, 'flattened'); });
$('#bank-invert').addEventListener('click', () => {
  const g = arch.bank.gains, mx = Math.max(...g), mn = Math.min(...g);
  arch.bank.gains = g.map((v) => +(mx + mn - v).toFixed(3));
  changed('bank', true, 'carving inverted');
});
$('#bank-smooth').addEventListener('click', () => {
  const g = arch.bank.gains;
  arch.bank.gains = g.map((v, k) => +((g[Math.max(0, k - 1)] + 2 * v + g[Math.min(g.length - 1, k + 1)]) / 4).toFixed(3));
  changed('bank', true, 'smoothed');
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
  if (e.defaultPrevented) return;
  const t = e.target;
  const typing = t.closest?.('input[type="text"], textarea');
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !typing) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); return; }
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (t.closest?.('input, select, textarea, [role="slider"], canvas')) return;
  if (e.key === ' ') {
    if (t.closest?.('button, label, a, summary')) return;
    e.preventDefault();
    engageBtn.click();
  } else if (e.key === 'p' || e.key === 'P') perturb();
  else if (e.key === 's' || e.key === 'S') takeSnapshot();
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
      currentEpoch = roman(ev.epoch);
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
    const spEff = s.length > 21 ? s[21] : frame.helm[3];
    $('#trace-read').textContent = `loop ${s[0].toFixed(1)} dB · setpoint ${spEff.toFixed(1)} dB · ${s[13] > 0.5 ? 'inhaling' : 'exhaling'} · breath ${Math.round(s[14])}`;
    if (s.length > 21) {
      const moved = Math.abs(s[15]) + Math.abs(s[16]) + Math.abs(s[17]) > 0.1;
      $('#metab-read').textContent = arch.homeo.metab === 0 ? 'metabolism off'
        : `metabolism ${moved ? `${fmt.db(s[15])} · depth ${fmt.db(s[16])} · ceiling ${fmt.db(s[17])}` : 'resting'} · pressure ${Math.round(s[18] * 100)}%`;
    }
  }
});
engine.addEventListener('captured', (e) => {
  arch.reels[e.detail.reel].mode = 'tape';
  syncAll();
  changed(`reels.${e.detail.reel}.mode`, true, 'capture');
  notify(`Reel ${e.detail.reel + 1} captured ${e.detail.seconds.toFixed(1)} s from the microphone.`);
});
const METAB_WHY = {
  regular: 'the breathing had begun to keep time like a clock',
  unchanging: 'the breathing had not changed its pace in a long while',
  stalled: 'the loop had stopped breathing',
};
engine.addEventListener('metab', (e) => {
  const m = e.detail;
  log(`Metabolism shifts, because ${METAB_WHY[m.reason] || 'the breathing had settled'}. Setpoint ${fmt.db(m.sp)}, depth ${fmt.db(m.depth)}, ceiling ${fmt.db(m.ceil)}.`, 'event');
  chronicle.mark(m.t, 'metab', 'metabolism');
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

function adopt(next, how, mark = '◇') {
  restore(next);
  history.commit(`${how.replace(/[:]$/, '')} “${arch.name}”`);
  const live = engine.running ? ' The running system moves toward it.' : '';
  notify(`${how} “${arch.name}”.${live}`);
  chronicle.mark(elapsed, 'epoch', mark);
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
  runId = `run-${Date.now()}`;
  log('Run reset. Tape and reel memory cleared, the clock restarted.');
});

/* ---------- snapshots ---------- */

let runId = `run-${Date.now()}`;
let currentEpoch = '';
let snaps = [];
try { snaps = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]').filter((x) => x && x.arch); } catch { snaps = []; }
const snapList = $('#snaps');
const snapNote = $('#snaps-empty');

function saveSnaps() {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(snaps.slice(-40))); } catch { /* not persisted */ }
}

function renderSnaps() {
  snapList.replaceChildren();
  snapNote.hidden = snaps.length > 0;
  for (const sn of [...snaps].reverse()) {
    const li = document.createElement('li');
    li.className = 'snap';
    const tag = document.createElement('span');
    tag.className = 'snap__tag';
    tag.textContent = `S${sn.n}`;
    const what = document.createElement('span');
    what.className = 'snap__what';
    const here = sn.note || (sn.run === runId ? `at ${clock(sn.t)}` : 'earlier run');
    what.textContent = `${sn.arch.name} · ${here}${sn.epoch ? ` · epoch ${sn.epoch}` : ''}`;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn--small';
    go.textContent = 'Recall';
    go.addEventListener('click', () => recallSnapshot(sn.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn--small btn--quiet';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete snapshot S${sn.n}`);
    del.addEventListener('click', () => {
      snaps = snaps.filter((x) => x.id !== sn.id);
      chronicle.unmark(sn.id);
      saveSnaps();
      renderSnaps();
    });
    li.append(tag, what, go, del);
    snapList.append(li);
  }
}

function takeSnapshot() {
  const n = snaps.reduce((m, x) => Math.max(m, x.n), 0) + 1;
  const sn = { id: `s${Date.now()}`, n, t: elapsed, run: runId, epoch: currentEpoch, arch: structuredClone(arch) };
  snaps.push(sn);
  if (snaps.length > 40) snaps.shift();
  saveSnaps();
  chronicle.mark(elapsed, 'snap', `S${n}`, sn.id);
  renderSnaps();
  notify(`Snapshot S${n} kept: “${arch.name}” and the helm as they are now.`);
}

function recallSnapshot(id) {
  const sn = snaps.find((x) => x.id === id);
  if (!sn) return;
  const next = structuredClone(sn.arch);
  next.helm.volume = arch.helm.volume;
  adopt(next, `Recalled S${sn.n}:`, `↺S${sn.n}`);
  log('The architecture and helm return; the system’s own memory carries on, so it finds its way back rather than jumping.');
}

for (const b of document.querySelectorAll('[data-snapshot]')) b.addEventListener('click', takeSnapshot);
if (previousArch) {
  const n = snaps.reduce((m, x) => Math.max(m, x.n), 0) + 1;
  snaps.push({ id: `s${Date.now()}`, n, t: 0, run: 'earlier', epoch: '', note: 'before the steadier defaults', arch: previousArch });
  saveSnaps();
  save();
  setTimeout(() => notify(`Kybernetes has new, steadier defaults. Your previous architecture is kept as snapshot S${n}; Recall brings it back.`), 600);
}
renderSnaps();

/* ---------- recording ---------- */

const recBtn = architecture.live.recBtn;
const recInfo = architecture.live.recInfo;
const recFiles = architecture.live.recFiles;
let recTimer = 0;
const mb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`);
const dbfs = (v) => (v > 0 ? `${(20 * Math.log10(v)).toFixed(1)} dBFS` : '—');

function offerFile(file, name, multi) {
  const url = URL.createObjectURL(file.blob);
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}${multi || file.part > 1 ? `-part${file.part}` : ''}.wav`;
  a.textContent = `Save ${a.download}`;
  const what = document.createElement('span');
  what.textContent = ` · ${clock(file.seconds)} · ${mb(file.blob.size)}`;
  li.append(a, what);
  recFiles.append(li);
}

let recName = '';
engine.addEventListener('rec-file', (e) => {
  if (engine.recorder) {
    offerFile(e.detail, recName, true);
    log(`Recording part ${e.detail.part} finished at the WAV size limit; recording continues in part ${e.detail.part + 1}.`);
  }
});

recBtn.addEventListener('click', async () => {
  if (engine.recorder) {
    clearInterval(recTimer);
    const r = engine.recorder;
    recBtn.disabled = true;
    const files = await engine.stopRecording();
    recBtn.disabled = false;
    recBtn.textContent = 'Record output';
    const last = files[files.length - 1];
    if (last) offerFile(last, recName, files.length > 1);
    const clip = r.clipped ? `${r.clipped} samples clipped` : 'no samples clipped';
    recInfo.textContent = files.length
      ? `Recorded ${clock(r.seconds)} · peak ${dbfs(r.peak)} · ${clip}.`
      : 'Nothing was recorded: the system was halted the whole time.';
    if (files.length && window.top !== window.self) recInfo.append(' If saving does nothing in this view, open the instrument on its own page.');
    log(`Recording stopped: ${clock(r.seconds)}, peak ${dbfs(r.peak)}, ${clip}.`);
    return;
  }
  if (!engine.running) { notify('Engage the system before recording.', 'error'); return; }
  recName = `kybernetes-${arch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}`;
  recFiles.replaceChildren();
  engine.startRecording({
    title: `Kybernetes · ${arch.name}`,
    comment: `Architecture code: ${encodeArch(arch)}`,
  });
  recBtn.textContent = 'Stop recording';
  const show = () => {
    const r = engine.recorder;
    if (!r) return;
    const clip = r.clipped ? `${r.clipped} clipped` : 'no clipping';
    recInfo.textContent = `Recording ${clock(r.seconds)} · ${mb(r.bytes)} · peak ${dbfs(r.peak)} · ${clip}${engine.running ? '' : ' · paused while halted'}`;
  };
  show();
  recTimer = setInterval(show, 500);
  log(`Recording started: 24-bit WAV at ${(engine.ctx.sampleRate / 1000).toFixed(1)} kHz.`);
});

/* ---------- first words ---------- */

setRunning(false);
log(`Architecture ready: “${arch.name}”. Engage to close the loop.`);
