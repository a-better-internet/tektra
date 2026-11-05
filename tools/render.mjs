#!/usr/bin/env node
/*
 * Offline renderer for the signal engine. Runs the AudioWorklet processor in
 * Node with a minimal stand-in for the worklet scope, writes a WAV file and
 * prints how the system regulated itself along the way.
 *
 *   node tools/render.mjs --seconds 120 --preset "Iron Weather" --out iron.wav
 *   node tools/render.mjs --derive andromeda --seconds 600 --out a.wav
 *   node tools/render.mjs --at 60:bias=0.4 --at 90:perturb
 *
 * Options
 *   --seconds N      length to render (default 60)
 *   --sr N           sample rate (default 48000)
 *   --preset NAME    start from a preset (default: the first one)
 *   --derive WORD    start from an architecture derived from WORD
 *   --out FILE       write a 16-bit stereo WAV
 *   --bands FILE     write the band history (one JSON row per frame)
 *   --every N        print a status line every N seconds (default 10)
 *   --at T:ACTION    at T seconds: key=value sets a helm value, perturb strikes
 *   --set PATH=VAL   override one architecture value, e.g. --set loop.smear=0.2
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { PRESETS, deriveArch, eraName, setPath } from '../js/state.js';

const args = process.argv.slice(2);
const opt = { seconds: 60, sr: 48000, preset: PRESETS[0].name, derive: null, out: null, bands: null, every: 10, at: [], set: [] };
for (let i = 0; i < args.length; i++) {
  const k = args[i].replace(/^--/, '');
  const v = args[i + 1];
  if (k === 'at' || k === 'set') { opt[k].push(v); i++; continue; }
  if (k in opt) { opt[k] = ['seconds', 'sr', 'every'].includes(k) ? Number(v) : v; i++; }
}

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
send({ type: 'engage' });

const events = opt.at.map((s) => {
  const [t, action] = s.split(':');
  return { t: Number(t), action, done: false };
}).sort((a, b) => a.t - b.t);

const N = 128;
const total = Math.ceil(opt.seconds * opt.sr / N);
const keep = opt.out ? new Int16Array(total * N * 2) : null;
const outL = new Float32Array(N), outR = new Float32Array(N);
const outputs = [[outL, outR]];
const inputs = [[]];
let peak = 0, sumSq = 0, count = 0, nanCount = 0, clipCount = 0;
const bandRows = [];
const history = [];

console.log(`Rendering "${arch.name}" for ${opt.seconds}s at ${opt.sr} Hz`);
const t0 = performance.now();
for (let b = 0; b < total; b++) {
  const tSec = b * N / opt.sr;
  for (const e of events) {
    if (!e.done && tSec >= e.t) {
      e.done = true;
      if (e.action === 'perturb') send({ type: 'perturb' });
      else {
        const [key, val] = e.action.split('=');
        arch.helm[key] = Number(val);
        send({ type: 'helm', helm: arch.helm });
      }
      console.log(`  ${tSec.toFixed(1)}s  steer: ${e.action}`);
    }
  }
  globalThis.currentTime = tSec;
  proc.process(inputs, outputs);
  for (let i = 0; i < N; i++) {
    const l = outL[i], r = outR[i];
    if (l !== l || r !== r) nanCount++;
    const al = Math.abs(l), ar = Math.abs(r);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
    if (al > 0.999 || ar > 0.999) clipCount++;
    sumSq += l * l + r * r; count += 2;
    if (keep) {
      keep[(b * N + i) * 2] = Math.max(-32767, Math.min(32767, Math.round(l * 32767)));
      keep[(b * N + i) * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(r * 32767)));
    }
  }
  while (posted.length) {
    const m = posted.shift();
    if (m.type !== 'frame') continue;
    history.push(m);
    if (opt.bands) bandRows.push(JSON.stringify({ t: +m.el.toFixed(2), b: Array.from(m.bands, (x) => +x.toFixed(3)), c: Array.from(m.clamp, (x) => +x.toFixed(3)), s: Array.from(m.stat, (x) => +x.toFixed(3)), g: Array.from(m.gateState) }));
  }
  if ((b + 1) % Math.round(opt.every * opt.sr / N) === 0) {
    const f = history[history.length - 1];
    const rms = 10 * Math.log10(sumSq / Math.max(1, count) + 1e-12);
    const [loopDb, outDb, trim, fastG, fb, tape, shift, clampAmt, flux, cent] = f.stat;
    console.log(
      `  ${String(Math.round((b + 1) * N / opt.sr)).padStart(5)}s  rms ${rms.toFixed(1).padStart(6)} dB  peak ${peak.toFixed(2)}  ` +
      `loop ${loopDb.toFixed(1).padStart(6)}  trim ${trim.toFixed(1).padStart(6)}  fast ${fastG.toFixed(2)}  fb ${fb.toFixed(2)}  ` +
      `tape ${tape.toFixed(2)}s  shift ${shift.toFixed(2)}  clamp ${clampAmt.toFixed(2)}  cent ${Math.round(cent)} Hz  ` +
      `gates ${Array.from(f.gateState).join('')}  gens ${Array.from(f.gens, (x) => x.toFixed(1)).join('/')}`,
    );
    peak = 0; sumSq = 0; count = 0;
  }
}
const dt = (performance.now() - t0) / 1000;
console.log(`Done in ${dt.toFixed(1)}s, ${(opt.seconds / dt).toFixed(1)}x real time. NaN samples: ${nanCount}. Samples at full scale: ${clipCount}. Era ${arch.helm.era} (${eraName(arch.helm.era)}).`);

if (opt.out) {
  const data = Buffer.from(keep.buffer);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(opt.sr, 24); h.writeUInt32LE(opt.sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(opt.out, Buffer.concat([h, data]));
  console.log(`Wrote ${opt.out}`);
}
if (opt.bands) {
  writeFileSync(opt.bands, bandRows.join('\n'));
  console.log(`Wrote ${opt.bands}`);
}
