/*
 * The architecture model: what the system is made of and how it is wired.
 * Pure data and pure functions, shared by the interface and the offline
 * renderer in tools/.
 */

export const BAND_HZ = [63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];
export const BAND_LABELS = ['63', '80', '100', '125', '160', '200', '250', '315', '400', '500',
  '630', '800', '1k', '1.25k', '1.6k', '2k', '2.5k', '3.15k', '4k', '5k', '6.3k', '8k', '10k', '12.5k'];

// Sources: what the system's eyes see. Order matches the signal engine.
export const SOURCES = [
  { code: '×', short: 'cascade', name: 'Multiplier cascade output', group: 0, node: 'm4' },
  { code: 'LOOP', short: 'loop level', name: 'Feedback loop level', group: 0, node: 'smear' },
  { code: 'OUT', short: 'output', name: 'Output level', group: 0, node: 'out' },
  { code: 'REEL', short: 'reels', name: 'Tape-loop mix level', group: 0, node: 'reels' },
  { code: 'LOW', short: 'low share', name: 'Low bands, 63–315 Hz', group: 1, node: 'bank' },
  { code: 'MID', short: 'middle share', name: 'Middle bands, 400 Hz–2 kHz', group: 1, node: 'bank' },
  { code: 'HIGH', short: 'high share', name: 'High bands, 2.5–12.5 kHz', group: 1, node: 'bank' },
  { code: 'CENT', short: 'centre', name: 'Spectral centre of gravity', group: 1, node: 'bank' },
  { code: 'FLUX', short: 'change', name: 'Rising or falling loop level', group: 2, node: 'smear' },
  { code: 'CLMP', short: 'pressure', name: 'Regulation pressure', group: 2, node: 'homeo' },
  { code: 'L1', short: 'gate 1', name: 'Logic gate 1', group: 3, node: 'l1' },
  { code: 'L2', short: 'gate 2', name: 'Logic gate 2', group: 3, node: 'l2' },
  { code: 'L3', short: 'gate 3', name: 'Logic gate 3', group: 3, node: 'l3' },
  { code: 'L4', short: 'gate 4', name: 'Logic gate 4', group: 3, node: 'l4' },
];

// Destinations: the knobs the system turns for itself.
export const DESTS = [
  { code: 'P1', name: 'Generator 1 pitch', group: 0, node: 'g1' },
  { code: 'P2', name: 'Generator 2 pitch', group: 0, node: 'g2' },
  { code: 'P3', name: 'Generator 3 pitch', group: 0, node: 'g3' },
  { code: 'P4', name: 'Generator 4 pitch', group: 0, node: 'g4' },
  { code: 'FOLD', name: 'Generator self-modulation', group: 0, node: 'gens' },
  { code: 'SYNC', name: 'Generator coupling', group: 0, node: 'gens' },
  { code: 'MULT', name: 'Multiplication depth', group: 1, node: 'mults' },
  { code: 'TAPE', name: 'Tape loop time', group: 2, node: 'tape' },
  { code: 'TILT', name: 'Bank tilt', group: 2, node: 'bank' },
  { code: 'ROT', name: 'Carving rotation', group: 2, node: 'bank' },
  { code: 'SHFT', name: 'Frequency shift', group: 2, node: 'shift' },
  { code: 'SMR', name: 'Smear', group: 2, node: 'smear' },
  { code: 'FDBK', name: 'Feedback gain', group: 2, node: 'homeo' },
  { code: 'R1', name: 'Reel 1 level', group: 3, node: 'r1' },
  { code: 'R2', name: 'Reel 2 level', group: 3, node: 'r2' },
  { code: 'R3', name: 'Reel 3 level', group: 3, node: 'r3' },
  { code: 'R4', name: 'Reel 4 level', group: 3, node: 'r4' },
  { code: 'RSPD', name: 'Reel speed', group: 3, node: 'reels' },
];

export const HELM_KEYS = ['inflow', 'bias', 'drift', 'setpoint', 'coupling', 'era', 'volume'];

export const GATE_MODES = [
  { id: 'gt', label: 'A > B' },
  { id: 'lt', label: 'A < B' },
  { id: 'flip', label: 'Flips at A > B' },
];

// Reel record sources: -1 never, 0..3 a logic gate, 4 always
export const REC_SOURCES = [
  { id: -1, label: 'Never' },
  { id: 0, label: 'While L1 open' },
  { id: 1, label: 'While L2 open' },
  { id: 2, label: 'While L3 open' },
  { id: 3, label: 'While L4 open' },
  { id: 4, label: 'Always' },
];

export function eraName(x) {
  if (x < 1) return 'Weather';
  if (x < 4) return 'Tide';
  if (x < 16) return 'Season';
  return 'Aeon';
}

/* Build a carving curve from smooth bumps: [[centreBand, width, height], ...] */
export function bumps(list, floor = 0.1) {
  const g = [];
  for (let k = 0; k < 24; k++) {
    let v = floor;
    for (const [c, w, h] of list) v += h * Math.exp(-0.5 * ((k - c) / w) ** 2);
    g.push(+Math.min(1.5, v).toFixed(3));
  }
  return g;
}

const S = Object.fromEntries(SOURCES.map((s, i) => [s.code, i]));
const D = Object.fromEntries(DESTS.map((d, i) => [d.code, i]));
const pin = (s, d, a) => [S[s], D[d], a];

export function defaultArch() {
  return {
    v: 3,
    name: 'Drift Nebula',
    gens: [{ f: 92.5, fold: 0.7 }, { f: 138.6, fold: 0.5 }, { f: 207.7, fold: 0.8 }, { f: 349.2, fold: 0.4 }],
    sync: 0.15,
    pm: 0.03,
    glide: 10,
    mult: [0.9, 0.75, 0.55, 0.2],
    drive: 1.4,
    loop: { fb: 0.9, time: 3.3, spread: 1.27, tone: 0.95, shift: 0.2, shiftSpread: 1, smear: 0.45, decay: 0.7, cross: 0.25 },
    bank: { q: 8, gains: bumps([[4, 2.5, 0.55], [11, 2.2, 0.6], [17, 1.8, 0.65], [21.5, 1.5, 0.35]], 0.15) },
    homeo: { ceil: 6, strength: 0.8, release: 2.5, breath: 0.3, depth: 3.5, metab: 1 },
    // Gentle by default: pitch is only nudged by slow spectral balance, never
    // by the breath, and the strongest pins shape timbre rather than pitch.
    matrix: [
      pin('LOW', 'P1', -0.15), pin('HIGH', 'P2', 0.12), pin('CENT', 'P3', -0.15),
      pin('FLUX', 'TAPE', 0.12), pin('CLMP', 'ROT', 0.35), pin('OUT', 'SMR', -0.3), pin('MID', 'SHFT', 0.2),
      pin('L1', 'R1', 0.5), pin('L2', 'R2', 0.5), pin('L3', 'R3', 0.45), pin('L4', 'MULT', -0.25),
      pin('REEL', 'FOLD', 0.3), pin('CLMP', 'FDBK', -0.2), pin('LOOP', 'SYNC', 0.25), pin('HIGH', 'TILT', -0.2),
      pin('×', 'RSPD', 0.1),
    ],
    gates: [
      { a: S.CENT, b: -1, mode: 'gt', h: 0.1, k: 0.2 },
      { a: S.FLUX, b: -1, mode: 'flip', h: 0.08, k: 0.3 },
      { a: S.LOW, b: S.HIGH, mode: 'gt', h: 0.1, k: 0 },
      { a: S.REEL, b: S.LOOP, mode: 'flip', h: 0.1, k: 0 },
    ],
    reels: [
      { mode: 'self', len: 7.3, level: 0.3, speed: 1, rec: 1 },
      { mode: 'self', len: 12.1, level: 0.25, speed: 0.5, rec: 2 },
      { mode: 'self', len: 19.7, level: 0.2, speed: -0.75, rec: 0 },
      { mode: 'tape', len: 8, level: 0.5, speed: 1, rec: -1 },
    ],
    reelToLoop: 0.5,
    reelToMult: 0.25,
    liveIn: 0,
    out: { loop: 0.9, dry: 0.08, reels: 0.35, space: 0.35 },
    helm: { inflow: 0.2, bias: 0, drift: 0, setpoint: -20, coupling: 0.8, era: 4, volume: 0.7 },
  };
}

function variant(name, description, edit) {
  return {
    name,
    description,
    build() {
      const a = defaultArch();
      a.name = name;
      edit(a);
      return a;
    },
  };
}

export const PRESETS = [
  variant('Drift Nebula', 'Open fifths folded through the full cascade, on a long smeared tape. Slowly evolving, wide and gently churning.', () => {}),
  variant('Iron Weather', 'Restless. Inharmonic generators, deep multiplication and narrow bands: metallic squalls that ring and clamp.', (a) => {
    a.glide = 2;
    a.gens = [{ f: 97, fold: 0.6 }, { f: 157, fold: 0.3 }, { f: 254, fold: 0.7 }, { f: 411, fold: 0.2 }];
    a.mult = [1, 1, 0.8, 0.6];
    a.drive = 1.7;
    a.loop = { fb: 1, time: 0.31, spread: 1.21, tone: 0.8, shift: 2.5, shiftSpread: 0, smear: 0.3, decay: 0.5, cross: 0.15 };
    a.bank = { q: 7, gains: bumps([[9, 2, 0.6], [14, 1.4, 0.7], [19, 1.6, 0.6]], 0.1) };
    a.homeo = { ceil: 4, strength: 1, release: 0.7, breath: 0.7, depth: 8, metab: 1 };
    a.helm.era = 1;
    a.helm.setpoint = -22;
  }),
  variant('Breathing Engine', 'Restless. Near-unison generators lock and unlock; a short loop and a fast homeostat give it a pulse.', (a) => {
    a.glide = 1.5;
    a.gens = [{ f: 61.7, fold: 0.9 }, { f: 62.1, fold: 0.8 }, { f: 123.9, fold: 0.7 }, { f: 186.3, fold: 1.0 }];
    a.sync = 0.55;
    a.pm = 0.15;
    a.loop = { fb: 1.05, time: 0.18, spread: 1.5, tone: 0.55, shift: -0.8, shiftSpread: 1, smear: 0.25, decay: 0.4, cross: 0.3 };
    a.homeo = { ceil: 5, strength: 1.1, release: 0.35, breath: 1.1, depth: 6, metab: 1 };
    a.matrix.push(pin('FLUX', 'FDBK', -0.5), pin('L1', 'SYNC', 0.5), pin('CLMP', 'P2', 0.15));
    a.helm.era = 0.5;
    a.helm.setpoint = -18;
  }),
  variant('Relay Choir', 'Logic gates hand the material between self-recording reels at different speeds.', (a) => {
    a.glide = 8;
    a.reels = [
      { mode: 'self', len: 5.1, level: 0.45, speed: 1, rec: 1 },
      { mode: 'self', len: 9.7, level: 0.4, speed: 0.5, rec: 2 },
      { mode: 'self', len: 14.3, level: 0.35, speed: -1, rec: 0 },
      { mode: 'self', len: 21.9, level: 0.3, speed: 1.5, rec: 3 },
    ];
    a.reelToLoop = 0.8;
    a.reelToMult = 0.5;
    a.out.reels = 0.6;
    a.matrix.push(pin('L4', 'R4', 0.6), pin('L1', 'RSPD', -0.4), pin('L3', 'SHFT', -0.3));
    a.helm.era = 4;
  }),
  variant('Gas Giant', 'Very low generators, a long tape and a downward-spiralling shifter inside heavy smear. The slowest.', (a) => {
    a.glide = 20;
    a.gens = [{ f: 27.5, fold: 1.2 }, { f: 41.2, fold: 1.0 }, { f: 61.7, fold: 1.1 }, { f: 92.5, fold: 0.8 }];
    a.loop = { fb: 0.94, time: 5.5, spread: 1.09, tone: 0.45, shift: -0.9, shiftSpread: 0.15, smear: 0.75, decay: 0.8, cross: 0.35 };
    a.bank = { q: 5, gains: bumps([[3, 3, 0.9], [10, 2.5, 0.6], [15.5, 2, 0.45]], 0.12) };
    a.homeo = { ceil: 8, strength: 0.8, release: 3, breath: 0.25, depth: 5, metab: 1 };
    a.out.space = 0.55;
    a.helm.era = 16;
    a.helm.setpoint = -19;
  }),
  variant('Cold Lattice', 'High, sparse and glassy. Little folding, very narrow bands, an almost still shift.', (a) => {
    a.glide = 15;
    a.gens = [{ f: 311, fold: 0 }, { f: 466, fold: 0.05 }, { f: 698, fold: 0 }, { f: 1046, fold: 0.1 }];
    a.mult = [0.8, 0.6, 0.4, 0.25];
    a.loop = { fb: 0.92, time: 2.7, spread: 1.31, tone: 0.9, shift: 0.12, shiftSpread: 1, smear: 0.55, decay: 0.7, cross: 0.2 };
    a.bank = { q: 14, gains: bumps([[13, 2, 0.6], [18, 1.5, 0.8], [22, 1.2, 0.5]], 0.05) };
    a.out.dry = 0.05;
    a.helm.era = 8;
    a.helm.setpoint = -24;
  }),
  variant('Open Web', 'Lightly patched and moderately set. A starting point for building your own architecture.', (a) => {
    a.matrix = [pin('CLMP', 'ROT', 0.4), pin('FLUX', 'TAPE', 0.2), pin('L1', 'R1', 0.5)];
    a.reels = [
      { mode: 'self', len: 8, level: 0.3, speed: 1, rec: 0 },
      { mode: 'off', len: 8, level: 0.3, speed: 1, rec: -1 },
      { mode: 'off', len: 8, level: 0.3, speed: 1, rec: -1 },
      { mode: 'tape', len: 8, level: 0.5, speed: 1, rec: -1 },
    ];
  }),
];

/* ---------- deriving a whole architecture from a name ---------- */

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function sequence(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const RATIO_SET = [1.0595, 1.125, 1.2, 1.25, 1.3333, 1.4142, 1.5, 1.6, 1.618, 1.6667, 1.75, 2, 2.414, 3];
const SPEED_SET = [1, 0.5, -1, 2, -0.5, 0.75, 1.5, -0.75];
const ERA_SET = [2, 4, 4, 4, 8, 8, 16];

/*
 * The same name always yields the same architecture. This is a design-time
 * rule set, not a noise source: the running system never draws a random number.
 */
export function deriveArch(word) {
  const name = (word || '').trim() || 'Unnamed';
  const r = sequence(hashString(name.toLowerCase()));
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const range = (a, b) => a + (b - a) * r();
  const round = (x, d = 3) => +x.toFixed(d);
  const a = defaultArch();
  a.name = name;
  let f = 27.5 * Math.pow(2, r() * 3.4);
  a.gens = [];
  for (let i = 0; i < 4; i++) {
    a.gens.push({ f: round(f, 2), fold: round(range(0, 0.9)) });
    f *= pick(RATIO_SET);
    if (f > 1800) f /= 4;
  }
  a.sync = round(range(0, 0.45));
  a.glide = round(range(6, 18), 1);
  a.pm = round(range(0, 0.2));
  a.mult = [round(range(0.5, 1)), round(range(0.3, 1)), round(range(0.2, 0.9)), round(range(0, 0.6))];
  a.drive = round(range(1, 2.2));
  a.loop = {
    fb: round(range(0.84, 1.02)),
    time: round(0.08 * Math.pow(2, r() * 6.3)),
    spread: round(range(1.02, 1.4)),
    tone: round(range(0.35, 0.9)),
    shift: round((r() < 0.5 ? -1 : 1) * 0.08 * Math.pow(2, r() * 6)),
    shiftSpread: round(r() < 0.5 ? 1 : r()),
    smear: round(range(0.2, 0.75)),
    decay: round(range(0.35, 0.85)),
    cross: round(range(0, 0.45)),
  };
  const nb = 2 + Math.floor(r() * 3);
  const list = [];
  for (let i = 0; i < nb; i++) list.push([range(1, 22), range(1, 4), range(0.3, 0.9)]);
  a.bank = { q: round(range(3, 11), 2), gains: bumps(list, round(range(0.05, 0.2))) };
  a.homeo = { ceil: Math.round(range(3, 10)), strength: round(range(0.6, 1)), release: round(range(1, 4)), breath: round(range(0.15, 0.5)), depth: round(range(2.5, 5), 1), metab: 1 };
  const pins = new Map();
  const nPins = 11 + Math.floor(r() * 9);
  for (let i = 0; i < nPins; i++) {
    const s = Math.floor(r() * SOURCES.length);
    const d = Math.floor(r() * DESTS.length);
    // pitch pins stay gentle so derived webs drift rather than swoop
    const top = d <= D.P4 || d === D.TAPE || d === D.RSPD ? 0.2 : 0.5;
    pins.set(`${s}:${d}`, [s, d, round((r() < 0.4 ? -1 : 1) * range(0.1, top), 2)]);
  }
  for (let i = 0; i < 3; i++) pins.set(`${S.L1 + i}:${D.R1 + i}`, [S.L1 + i, D.R1 + i, round(range(0.4, 0.7), 2)]);
  a.matrix = [...pins.values()];
  const eyes = [S['×'], S.LOOP, S.OUT, S.REEL, S.LOW, S.MID, S.HIGH, S.CENT, S.FLUX, S.CLMP];
  a.gates = [0, 1, 2, 3].map(() => {
    const ga = pick(eyes);
    let gb = pick(eyes);
    if (gb === ga) gb = -1;
    return { a: ga, b: gb, mode: pick(['gt', 'lt', 'flip']), h: round(range(0.02, 0.1)), k: round(range(-0.3, 0.3)) };
  });
  a.reels = [0, 1, 2].map((i) => ({
    mode: 'self', len: round(range(3, 21), 1), level: round(range(0.2, 0.4)), speed: pick(SPEED_SET), rec: i,
  }));
  a.reels.push({ mode: 'tape', len: 8, level: 0.5, speed: 1, rec: -1 });
  a.reelToLoop = round(range(0.3, 0.8));
  a.reelToMult = round(range(0, 0.45));
  a.out = { loop: 0.9, dry: round(range(0.05, 0.2)), reels: round(range(0.25, 0.5)), space: round(range(0.2, 0.5)) };
  a.helm = { inflow: round(range(0.15, 0.45)), bias: 0, drift: 0, setpoint: Math.round(range(-25, -17)), coupling: 0.8, era: pick(ERA_SET), volume: 0.7 };
  return a;
}

/* ---------- validation and sharing ---------- */

function num(v, d, lo, hi) {
  const n = typeof v === 'number' && isFinite(v) ? v : d;
  return Math.min(hi, Math.max(lo, n));
}

/* Merge anything that looks like an architecture onto the defaults, clamping every field. */
export function normalizeArch(input) {
  const d = defaultArch();
  if (!input || typeof input !== 'object') return d;
  const a = structuredClone(d);
  a.name = typeof input.name === 'string' ? input.name.slice(0, 60) : d.name;
  for (let i = 0; i < 4; i++) {
    const g = input.gens?.[i] || {};
    a.gens[i] = { f: num(g.f, d.gens[i].f, 8, 5000), fold: num(g.fold, d.gens[i].fold, 0, 2.5) };
  }
  a.sync = num(input.sync, d.sync, 0, 1);
  a.glide = num(input.glide, d.glide, 0.05, 60);
  a.pm = num(input.pm, d.pm, 0, 1);
  for (let i = 0; i < 4; i++) a.mult[i] = num(input.mult?.[i], d.mult[i], 0, 1);
  a.drive = num(input.drive, d.drive, 0.25, 4);
  const L = input.loop || {};
  a.loop = {
    fb: num(L.fb, d.loop.fb, 0, 1.3), time: num(L.time, d.loop.time, 0.01, 9), spread: num(L.spread, d.loop.spread, 0.5, 2),
    tone: num(L.tone, d.loop.tone, 0, 1), shift: num(L.shift, d.loop.shift, -60, 60), shiftSpread: num(L.shiftSpread, d.loop.shiftSpread, 0, 1),
    smear: num(L.smear, d.loop.smear, 0, 1), decay: num(L.decay, d.loop.decay, 0, 0.97), cross: num(L.cross, d.loop.cross, 0, 0.5),
  };
  a.bank = { q: num(input.bank?.q, d.bank.q, 1.5, 24), gains: d.bank.gains.map((g, k) => num(input.bank?.gains?.[k], g, 0, 1.5)) };
  const H = input.homeo || {};
  // Version 1 measured the band ceiling against the setpoint; version 2 measures
  // it against an even share of the spectrum.
  const ceil = (input.v || 1) < 2 && typeof H.ceil === 'number' ? H.ceil + 14 : H.ceil;
  a.homeo = {
    ceil: num(ceil, d.homeo.ceil, 0, 24), strength: num(H.strength, d.homeo.strength, 0, 1.5),
    release: num(H.release, d.homeo.release, 0.05, 30), breath: num(H.breath, d.homeo.breath, 0, 2),
    depth: num(H.depth, d.homeo.depth, 1, 24), metab: num(H.metab, d.homeo.metab, 0, 2),
  };
  if (Array.isArray(input.matrix)) {
    const seen = new Map();
    for (const p of input.matrix) {
      if (!Array.isArray(p)) continue;
      const s = p[0] | 0, t = p[1] | 0, v = num(p[2], 0, -1, 1);
      if (s >= 0 && s < SOURCES.length && t >= 0 && t < DESTS.length && v !== 0) seen.set(`${s}:${t}`, [s, t, v]);
    }
    a.matrix = [...seen.values()];
  }
  for (let g = 0; g < 4; g++) {
    const G = input.gates?.[g] || {};
    const mode = ['gt', 'lt', 'flip'].includes(G.mode) ? G.mode : d.gates[g].mode;
    a.gates[g] = {
      a: num(G.a, d.gates[g].a, 0, SOURCES.length - 1) | 0, b: num(G.b, d.gates[g].b, -1, SOURCES.length - 1) | 0,
      mode, h: num(G.h, d.gates[g].h, 0, 0.5), k: num(G.k, d.gates[g].k, -1, 1),
    };
  }
  for (let r = 0; r < 4; r++) {
    const R = input.reels?.[r] || {};
    a.reels[r] = {
      mode: ['self', 'tape', 'off'].includes(R.mode) ? R.mode : d.reels[r].mode,
      len: num(R.len, d.reels[r].len, 0.5, 24), level: num(R.level, d.reels[r].level, 0, 1.25),
      speed: num(R.speed, d.reels[r].speed, -4, 4), rec: num(R.rec, d.reels[r].rec, -1, 4) | 0,
    };
  }
  a.reelToLoop = num(input.reelToLoop, d.reelToLoop, 0, 1.5);
  a.reelToMult = num(input.reelToMult, d.reelToMult, 0, 1.5);
  a.liveIn = num(input.liveIn, d.liveIn, 0, 1.5);
  const O = input.out || {};
  a.out = { loop: num(O.loop, d.out.loop, 0, 1.5), dry: num(O.dry, d.out.dry, 0, 1.5), reels: num(O.reels, d.out.reels, 0, 1.5), space: num(O.space, d.out.space, 0, 1.5) };
  const h = input.helm || {};
  a.helm = {
    inflow: num(h.inflow, d.helm.inflow, 0, 1.5), bias: num(h.bias, 0, -1, 1), drift: num(h.drift, 0, -24, 24),
    setpoint: num(h.setpoint, d.helm.setpoint, -48, -3), coupling: num(h.coupling, 1, 0, 2), era: num(h.era, d.helm.era, 0.25, 64),
    volume: num(h.volume, d.helm.volume, 0, 1),
  };
  return a;
}

const CODE_PREFIX = 'KYB1.';

export function encodeArch(a) {
  const bytes = new TextEncoder().encode(JSON.stringify(a));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return CODE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeArch(code) {
  const text = String(code || '').trim();
  if (text.startsWith('{')) return normalizeArch(JSON.parse(text));
  if (!text.startsWith(CODE_PREFIX)) throw new Error('This is not an architecture code. Codes start with KYB1.');
  const b64 = text.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return normalizeArch(JSON.parse(new TextDecoder().decode(bytes)));
}

/* Path helpers for binding controls to the architecture. */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}
