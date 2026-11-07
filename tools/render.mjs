#!/usr/bin/env node
/*
 * Offline renderer and inspector for the signal engine. Runs the AudioWorklet
 * processor in Node with a minimal stand-in for the worklet scope, writes a
 * WAV file and reports how the system regulated itself:
 *
 *   - breathing: how regular the homeostat's breaths were, per window
 *   - headroom:  how often the feedback gain sat at its ceiling
 *   - clicks:    sample discontinuities, with what was happening at the time
 *   - motion:    how fast and how far pitch, tape speed, level and brightness move
 *
 *   node tools/render.mjs --seconds 120 --preset "Iron Weather" --out iron.wav
 *   node tools/render.mjs --derive andromeda --seconds 600 --out a.wav
 *   node tools/render.mjs --at 60:bias=0.4 --at 90:perturb
 *   node tools/render.mjs --inject 20      check that the click detector works
 *
 * Options
 *   --seconds N      length to render (default 60)
 *   --sr N           sample rate (default 48000)
 *   --preset NAME    start from a preset (default: the first one)
 *   --derive WORD    start from an architecture derived from WORD
 *   --out FILE       write a 16-bit stereo WAV
 *   --bands FILE     write the band history (one JSON row per frame)
 *   --every N        print a status line every N seconds (default 10)
 *   --window N       breathing report window in seconds (default 600)
 *   --at T:ACTION    at T seconds: key=value sets a helm value, perturb strikes,
 *                    arch:PATH=VALUE changes the architecture
 *   --set PATH=VAL   override one architecture value, e.g. --set loop.smear=0.2
 *   --ratio N        click threshold against the local level (default 9)
 *   --inject N       add N synthetic steps to the analysed signal (not the WAV)
 *   --hold R:HZ:SEC  put a raw sine of HZ, SEC long, on reel R (1-4) as held tape;
 *                    its ends don't line up, so its loop point is a hard seam
 *   --quiet          only print the summary
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { PRESETS, deriveArch, eraName, setPath } from '../js/state.js';

const args = process.argv.slice(2);
const opt = {
  seconds: 60, sr: 48000, preset: PRESETS[0].name, derive: null, out: null, bands: null,
  every: 10, window: 600, at: [], set: [], hold: [], ratio: 9, inject: 0, quiet: false,
};
for (let i = 0; i < args.length; i++) {
  const k = args[i].replace(/^--/, '');
  const v = args[i + 1];
  if (k === 'quiet') { opt.quiet = true; continue; }
  if (k === 'at' || k === 'set' || k === 'hold') { opt[k].push(v); i++; continue; }
  if (k in opt) { opt[k] = ['seconds', 'sr', 'every', 'window', 'ratio', 'inject'].includes(k) ? Number(v) : v; i++; }
}
const say = (...a) => { if (!opt.quiet) console.log(...a); };

const posted = [];
globalThis.sampleRate = opt.sr;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; }
};
let Processor = null;
globalThis.registerProcessor = (_name, cls) => { Processor = cls; };
await import('../js/dsp/processor.js');

let arch;
if (opt.derive) arch = deriveArch(opt.derive);
else {
  const p = PRESETS.find((x) => x.name.toLowerCase() === String(opt.preset).toLowerCase());
  if (!p) { console.error(`Unknown preset. Choose one of: ${PRESETS.map((x) => x.name).join(', ')}`); process.exit(1); }
  arch = p.build();
}
for (const s of opt.set) {
  const [path, val] = s.split('=');
  setPath(arch, path, Number(val));
}

const proc = new Processor({ processorOptions: { arch } });
const send = (m) => proc.port.onmessage({ data: m });
for (const h of opt.hold) {
  const [r, hz, sec] = h.split(':').map(Number);
  const data = new Float32Array(Math.round(sec * opt.sr));
  for (let i = 0; i < data.length; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * hz * i) / opt.sr);
  arch.reels[r - 1].mode = 'tape';
  send({ type: 'arch', arch });
  send({ type: 'reel-load', reel: r - 1, data });
}
posted.length = 0;
send({ type: 'engage' });

const steer = opt.at.map((s) => {
  const i = s.indexOf(':');
  return { t: Number(s.slice(0, i)), action: s.slice(i + 1), done: false };
}).sort((a, b) => a.t - b.t);

const N = 128;
const SR = opt.sr;
const total = Math.ceil(opt.seconds * SR / N);
const keep = opt.out ? new Int16Array(total * N * 2) : null;
const outL = new Float32Array(N), outR = new Float32Array(N);
const outputs = [[outL, outR]];
const inputs = [[]];
let peak = 0, sumSq = 0, count = 0, nanCount = 0, clipCount = 0;
const bandRows = [];
let lastFrame = null;

/* ---- what was happening: events the clicks can be attributed to ---- */
const events = [];
const note = (t, kind) => { events.push({ t, kind }); };
const prevPos = new Float64Array(4);
const prevW = new Int32Array(4);
const prevLen = new Int32Array(4);
let prevTape = proc.tapeS;
const prevGate = new Uint8Array(4);
let prevInhale = 0;

/* ---- click detector ----
 * A click is a second-difference spike that stands far above the local level
 * and is isolated: nothing else within 1.5 ms comes close to it, apart from
 * its immediate neighbours (a step shows as a +/- pair). Dense bright sound
 * has many large second differences and is not counted. */
const LA = Math.round(0.0015 * SR);           // look-ahead and look-behind
const RING = 4096;
const det = [0, 1].map(() => ({ x1: 0, x2: 0, e2: 1e-6, d: new Float32Array(RING), ref: new Float32Array(RING) }));
const kE = 1 / (0.004 * SR);
const clicks = [];
let lastClickN = -1e9;
function judge(c, m) {
  const d = det[c];
  const v = Math.abs(d.d[m % RING]);
  if (v < 0.012 || v < opt.ratio * d.ref[m % RING]) return;
  for (let j = m - LA; j <= m + LA; j++) {
    if (Math.abs(j - m) <= 1) continue;
    if (Math.abs(d.d[((j % RING) + RING) % RING]) > 0.5 * v) return;
  }
  if (m - lastClickN < SR * 0.02) return;
  lastClickN = m;
  clicks.push({ t: m / SR, mag: v, ratio: v / Math.max(1e-9, d.ref[m % RING]), ch: c });
}
const injectAt = new Set();
if (opt.inject > 0) {
  for (let i = 0; i < opt.inject; i++) injectAt.add(Math.round(((i + 0.5) / opt.inject) * (opt.seconds - 2) * SR + SR));
}
let injectLevel = 0;
let injected = 0, injectFound = 0;

/* ---- breathing and headroom ---- */
const breathT = [];
let fbPinned = 0, frames = 0;
const trims = [];
const metab = [];
const sec = [];          // the system averaged over each second, for the motion report
let nextSec = 1;
let acc = { n: 0, out: 0, cent: 0 };
const minutes = [];      // the band profile averaged over each minute, for the evolution report
let minAcc = null, minN = 0, nextMin = 60;

say(`Rendering "${arch.name}" for ${opt.seconds}s at ${SR} Hz`);
const t0 = performance.now();
for (let b = 0; b < total; b++) {
  const tSec = b * N / SR;
  for (const e of steer) {
    if (e.done || tSec < e.t) continue;
    e.done = true;
    if (e.action === 'perturb') { send({ type: 'perturb' }); note(tSec, 'perturb'); }
    else if (e.action.startsWith('arch:')) {
      const [path, val] = e.action.slice(5).split('=');
      setPath(arch, path, Number.isNaN(Number(val)) ? val : Number(val));
      send({ type: 'arch', arch: structuredClone(arch) });
      note(tSec, `arch ${path}`);
    } else {
      const [key, val] = e.action.split('=');
      arch.helm[key] = Number(val);
      send({ type: 'helm', helm: arch.helm });
      note(tSec, `helm ${key}`);
    }
    say(`  ${tSec.toFixed(1)}s  steer: ${e.action}`);
  }
  globalThis.currentTime = tSec;
  proc.process(inputs, outputs);

  // instrumentation from the engine's state
  for (let r = 0; r < 4; r++) {
    const len = proc.reelLen[r], pos = proc.reelPos[r], w = proc.reelW[r];
    if (len !== prevLen[r]) note(tSec, `reel ${r + 1} length or mode`);
    else if (len > 0) {
      if (Math.abs(pos - prevPos[r]) > len / 2) note(tSec, `reel ${r + 1} loop point`);
      const a = (prevPos[r] - prevW[r]) / len, c = (pos - w) / len;
      if (Math.floor(a) !== Math.floor(c) && Math.abs(pos - prevPos[r]) < len / 2) note(tSec, `reel ${r + 1} crosses record head`);
    }
    prevPos[r] = pos; prevW[r] = w; prevLen[r] = len;
  }
  const tapeRate = Math.abs(proc.tapeS - prevTape) * SR / N;
  if (tapeRate > 0.25) note(tSec, 'tape lurching (pitch bend over 25%)');
  else if (tapeRate > 0.05) note(tSec, 'tape gliding (pitch bend 5–25%)');
  prevTape = proc.tapeS;
  if (proc.limG < 0.75) note(tSec, 'limiter working hard');
  if (Math.max(proc.P[4], proc.P[5], proc.P[6], proc.P[7]) > 1.1) note(tSec, 'sharp generator edges (fold above 1.1)');

  for (let i = 0; i < N; i++) {
    const n = b * N + i;
    const l = outL[i], r = outR[i];
    if (l !== l || r !== r) nanCount++;
    const al = Math.abs(l), ar = Math.abs(r);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
    if (al > 0.999 || ar > 0.999) clipCount++;
    sumSq += l * l + r * r; count += 2;
    if (keep) {
      keep[n * 2] = Math.max(-32767, Math.min(32767, Math.round(l * 32767)));
      keep[n * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(r * 32767)));
    }
    if (injectAt.has(n)) { injectLevel = injectLevel ? 0 : 0.04; injected++; injectAt.delete(n); note(n / SR, 'synthetic step'); }
    const xs = [l + injectLevel, r + injectLevel];
    for (let c = 0; c < 2; c++) {
      const d = det[c];
      const x = xs[c];
      const d2 = x - 2 * d.x1 + d.x2;
      d.d[n % RING] = d2;
      d.ref[n % RING] = Math.sqrt(d.e2);
      d.e2 += (d2 * d2 - d.e2) * kE;
      d.x2 = d.x1; d.x1 = x;
      if (n > SR * 0.5 + LA) judge(c, n - LA);
    }
  }

  while (posted.length) {
    const m = posted.shift();
    if (m.type === 'metab') { metab.push(m); continue; }
    if (m.type !== 'frame') continue;
    lastFrame = m;
    frames++;
    acc.n++; acc.out += m.stat[1]; acc.cent += Math.log2(Math.max(20, m.stat[9]));
    if (!minAcc) minAcc = new Float64Array(m.bands.length + 1);
    for (let k = 0; k < m.bands.length; k++) minAcc[k] += m.bands[k];
    minAcc[m.bands.length] += Math.log2(Math.max(20, m.stat[9]));
    minN++;
    if (m.el >= nextMin) {
      nextMin += 60;
      minutes.push(Array.from(minAcc, (v) => v / minN));
      minAcc.fill(0); minN = 0;
    }
    if (m.el >= nextSec) {
      nextSec = Math.floor(m.el) + 1;
      sec.push({ t: m.el, gens: Array.from(m.gens), tape: m.stat[5], shift: m.stat[6], out: acc.out / acc.n, cent: 2 ** (acc.cent / acc.n) });
      acc = { n: 0, out: 0, cent: 0 };
    }
    const s = m.stat;
    if (s[4] >= proc.fbCap * 0.98) fbPinned++;
    trims.push(s[2]);
    if (s[14] > prevInhale) breathT.push(m.el);
    prevInhale = s[14];
    for (let g = 0; g < 4; g++) { if (m.gateState[g] !== prevGate[g]) note(m.el, `gate L${g + 1}`); prevGate[g] = m.gateState[g]; }
    if (opt.bands) bandRows.push(JSON.stringify({ t: +m.el.toFixed(2), b: Array.from(m.bands, (x) => +x.toFixed(3)), c: Array.from(m.clamp, (x) => +x.toFixed(3)), s: Array.from(m.stat, (x) => +x.toFixed(3)), g: Array.from(m.gateState) }));
  }
  if ((b + 1) % Math.round(opt.every * SR / N) === 0 && lastFrame) {
    const f = lastFrame;
    const rms = 10 * Math.log10(sumSq / Math.max(1, count) + 1e-12);
    const [loopDb, , trim, fastG, fb, tape, shift, clampAmt, , cent] = f.stat;
    const m = f.stat.length > 17 ? `  metab sp ${f.stat[15].toFixed(1)} dp ${f.stat[16].toFixed(1)} cl ${f.stat[17].toFixed(1)} P ${f.stat[18].toFixed(2)} reg ${f.stat[19].toFixed(2)}` : '';
    say(
      `  ${String(Math.round((b + 1) * N / SR)).padStart(5)}s  rms ${rms.toFixed(1).padStart(6)} dB  peak ${peak.toFixed(2)}  ` +
      `loop ${loopDb.toFixed(1).padStart(6)}  trim ${trim.toFixed(1).padStart(6)}  fast ${fastG.toFixed(2)}  fb ${fb.toFixed(2)}  ` +
      `tape ${tape.toFixed(2)}s  shift ${shift.toFixed(2)}  clamp ${clampAmt.toFixed(2)}  cent ${Math.round(cent)} Hz  ` +
      `gates ${Array.from(f.gateState).join('')}${m}`,
    );
    peak = 0; sumSq = 0; count = 0;
  }
}
const dt = (performance.now() - t0) / 1000;

/* ---------- report ---------- */
console.log(`\n"${arch.name}", ${opt.seconds}s, era ${arch.helm.era} (${eraName(arch.helm.era)}). Rendered at ${(opt.seconds / dt).toFixed(1)}x real time.`);
console.log(`Signal: NaN samples ${nanCount}, samples at full scale ${clipCount}.`);

const sorted = trims.slice().sort((a, b) => a - b);
const q = (p) => (sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : 0);
console.log(`Headroom: feedback at its ceiling ${((100 * fbPinned) / Math.max(1, frames)).toFixed(1)}% of the time. Trim median ${q(0.5).toFixed(1)} dB (10% ${q(0.1).toFixed(1)}, 90% ${q(0.9).toFixed(1)}).`);

const rows = [];
for (let w0 = 0; w0 < opt.seconds; w0 += opt.window) {
  const ts = breathT.filter((t) => t >= w0 && t < w0 + opt.window);
  const iv = [];
  for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
  if (iv.length < 2) { rows.push(`${String(w0).padStart(6)}s  ${ts.length} breaths`); continue; }
  const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
  const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
  rows.push(`${String(w0).padStart(6)}s  ${String(ts.length).padStart(3)} breaths, mean ${mean.toFixed(1).padStart(5)} s, variation ${((100 * sd) / mean).toFixed(0).padStart(3)}%`);
}
console.log(`Breathing (variation is the spread of breath intervals; low means clock-like):\n  ${rows.join('\n  ')}`);
if (metab.length) {
  console.log(`Metabolism shifted ${metab.length} times:`);
  for (const m of metab.slice(0, 40)) console.log(`  ${m.t.toFixed(0).padStart(6)}s  ${m.reason}: setpoint ${m.sp.toFixed(1)} dB, depth ${m.depth.toFixed(1)} dB, ceiling ${m.ceil.toFixed(1)} dB`);
}

/* Motion: rates per second and ranges, skipping the first 30 s while the web wakes. */
{
  const S = sec.filter((x) => x.t > 30);
  const pct = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(p * (a.length - 1))] : 0; };
  const pitchRate = [], tapeBend = [], shiftRate = [], levelRate = [], brightRate = [];
  let ranges = 0;
  for (let g = 0; g < 4; g++) {
    const c = S.map((x) => 1200 * Math.log2(x.gens[g]));
    for (let i = 1; i < c.length; i++) pitchRate.push(Math.abs(c[i] - c[i - 1]));
    ranges = Math.max(ranges, pct(c, 0.95) - pct(c, 0.05));
  }
  let big = 0;
  for (let i = 1; i < S.length; i++) {
    const dt = S[i].t - S[i - 1].t || 1;
    tapeBend.push((100 * Math.abs(S[i].tape - S[i - 1].tape)) / dt);
    shiftRate.push(Math.abs(S[i].shift - S[i - 1].shift) / dt);
    const dl = Math.abs(S[i].out - S[i - 1].out) / dt;
    const db = Math.abs(Math.log2(S[i].cent / S[i - 1].cent)) / dt;
    levelRate.push(dl); brightRate.push(db);
    const pr = Math.max(...[0, 1, 2, 3].map((g) => Math.abs(1200 * Math.log2(S[i].gens[g] / S[i - 1].gens[g]))));
    if (dl > 2.5 || db > 0.25 || pr > 40 || (100 * Math.abs(S[i].tape - S[i - 1].tape)) / dt > 8) big++;
  }
  const lv = S.map((x) => x.out);
  const swell = pct(lv, 0.95) - pct(lv, 0.05);
  console.log(`Motion (one-second averages; 95th percentile of the change from second to second):`);
  console.log(`  pitch      ${pct(pitchRate, 0.95).toFixed(1)} cents/s, widest generator range ${ranges.toFixed(0)} cents`);
  console.log(`  tape bend  ${pct(tapeBend, 0.95).toFixed(2)}% speed change     shift ${pct(shiftRate, 0.95).toFixed(3)} Hz/s`);
  console.log(`  level      ${pct(levelRate, 0.95).toFixed(2)} dB/s, swing ${swell.toFixed(1)} dB     brightness ${pct(brightRate, 0.95).toFixed(3)} oct/s`);
  console.log(`  abrupt moves: ${big} (${((big / Math.max(1, S.length)) * 60).toFixed(1)} per minute)`);
  // Evolution: how far the minute-long spectral picture moves over five minutes.
  const M = minutes.slice(1);
  if (M.length > 6) {
    const nb = M[0].length - 1;
    const moves = [];
    for (let i = 0; i + 5 < M.length; i++) {
      let d = 0;
      for (let k = 0; k < nb; k++) d += Math.abs(M[i + 5][k] - M[i][k]);
      moves.push((d / nb) * 54);
    }
    const cents = M.map((r) => r[nb]);
    const drift = Math.max(...cents) - Math.min(...cents);
    console.log(`  evolution: spectrum moves ${(moves.reduce((a, b) => a + b, 0) / moves.length).toFixed(2)} dB per band over five minutes; brightness wanders over ${drift.toFixed(2)} octaves`);
  }
}

const near = (t) => {
  const hits = new Set();
  for (const e of events) if (Math.abs(e.t - t) < 0.008) hits.add(e.kind);
  return [...hits].join(', ') || 'nothing logged';
};
for (const c of clicks) if (c.t !== undefined && near(c.t).includes('synthetic step')) injectFound++;
const flagged = clicks.filter((c) => !near(c.t).includes('synthetic step'));
const isEdge = (c) => near(c.t).includes('sharp generator edges');
const edges = flagged.filter(isEdge);
const real = flagged.filter((c) => !isEdge(c));
console.log(`Clicks: ${real.length} found (${((real.length / opt.seconds) * 60).toFixed(2)} per minute) at ratio ${opt.ratio}.`);
if (edges.length) console.log(`  Not counted: ${edges.length} sharp sawtooth edges while generator fold was above 1.1 (timbre, not a fault).`);
if (opt.inject) console.log(`  Detector check: ${injectFound} of ${injected} synthetic steps found.`);
const byCause = new Map();
for (const c of real) { const k = near(c.t); byCause.set(k, (byCause.get(k) || 0) + 1); }
for (const [k, v] of [...byCause.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(v).padStart(4)} near: ${k}`);
for (const c of real.sort((a, b) => b.ratio - a.ratio).slice(0, 6)) console.log(`  worst ${c.t.toFixed(3)}s  step ${c.mag.toFixed(3)}  ${c.ratio.toFixed(0)}x local  near: ${near(c.t)}`);

if (opt.out) {
  const data = Buffer.from(keep.buffer);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(opt.out, Buffer.concat([h, data]));
  console.log(`Wrote ${opt.out}`);
}
if (opt.bands) {
  writeFileSync(opt.bands, bandRows.join('\n'));
  console.log(`Wrote ${opt.bands}`);
}
