/*
 * Kybernetes signal engine (AudioWorkletProcessor).
 *
 * A closed web. Four generators feed a cascade of four multipliers. The
 * cascade feeds a tape loop whose return passes through a third-octave
 * filter bank (every band watched by its own envelope follower and held by
 * an inverted VCA), a single-sideband frequency shifter and a smearing
 * reverberator. The result comes back to the tape, to the last multiplier
 * and to the generators' phase. Envelope followers read the web and, through
 * a modulation matrix, turn its knobs. A homeostat keeps the loop near a
 * setpoint the way a thermostat keeps a room warm.
 *
 * Nothing here is random. There are no LFOs, no noise sources and no
 * sequencers: every movement comes from the system reading itself.
 */

const NB = 24;
const BAND_HZ = [63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];
const NSRC = 14;
const NDST = 22;
const CR = 32;            // control period, samples
const FRAME_BLOCKS = 12;  // analysis frame every 12 render quanta (~30 Hz)
const TWO_PI = 2 * Math.PI;
const MK = 1.1;           // make-up gain per multiplier stage
const MAKEUP = 1.25;      // output make-up before the limiter
const CEIL = 0.891;       // output ceiling: -1 dBFS, enforced by the look-ahead limiter
const GOV = 0.75;         // the output governor keeps sustained peaks below this
const REC_FRAMES = 16384; // recorder chunk, about a third of a second

// Sources (the system's eyes)
const S_CASC = 0, S_LOOP = 1, S_OUT = 2, S_REEL = 3, S_LOW = 4, S_MID = 5,
  S_HIGH = 6, S_CENT = 7, S_FLUX = 8, S_CLMP = 9, S_L1 = 10;
// Destinations (the system's hands)
const D_P1 = 0, D_FOLD = 4, D_SYNC = 5, D_MULT = 6, D_TAPE = 7, D_TILT = 8,
  D_ROT = 9, D_SHFT = 10, D_SMR = 11, D_FDBK = 12, D_R1 = 13, D_RSPD = 17, D_WARM = 18,
  D_SHAPE = 19, D_EXCT = 20, D_HARM = 21;
// Helm (the steersman's controls)
const HELM_KEYS = ['inflow', 'bias', 'drift', 'setpoint', 'coupling', 'era', 'volume', 'warmth'];
const H_INFLOW = 0, H_BIAS = 1, H_DRIFT = 2, H_SET = 3, H_COUP = 4, H_ERA = 5, H_VOL = 6, H_WARM = 7;
// Ramped parameters: set at control rate, interpolated per sample
const R_GF = 0, R_FOLD = 4, R_SYNC = 8, R_D = 9, R_DRIVE = 13, R_DL = 14,
  R_DR = 15, R_SHL = 16, R_SHR = 17, R_SMR = 18, R_FB = 19, R_IN = 20,
  R_R2L = 21, R_R2M = 22, R_RLV = 23, R_RSP = 27, R_VOL = 31, R_PM = 32,
  R_OLOOP = 33, R_ODRY = 34, R_OREEL = 35, R_OSPACE = 36, R_REC = 37,
  R_LIVE = 41, R_EXC = 42, R_HMIX = 43, R_HWIN = 44, NRAMP = 45;

const REEL_PAN_L = [0.92, 0.38, 0.8, 0.55];
const REEL_PAN_R = [0.38, 0.92, 0.55, 0.8];

// Small integer ratios the generators can lock to (p/q).
const RATIOS = [];
for (let q = 1; q <= 4; q++) {
  for (let p = 1; p <= 8; p++) RATIOS.push([p, q, Math.log(p / q)]);
}

/* The harmonic series the generators settle into as the web warms: the
 * common fundamental that needs the least retuning, preferring low harmonic
 * numbers. Every architecture so far lands within a few cents of one. */
function harmonicSeries(fs) {
  const lo = Math.min(...fs);
  let best = null;
  for (let k = 1; k <= 16; k++) {
    const n0 = fs.map((f) => Math.max(1, Math.round(f / (lo / k))));
    let lf = 0;
    for (let i = 0; i < fs.length; i++) lf += Math.log2(fs[i] / n0[i]);
    const f0 = Math.pow(2, lf / fs.length);
    const n = fs.map((f) => Math.max(1, Math.round(f / f0)));
    let cost = 0;
    for (let i = 0; i < fs.length; i++) cost += Math.abs(1200 * Math.log2(fs[i] / (n[i] * f0))) + 8 * Math.log2(n[i]);
    if (!best || cost < best.cost) best = { f0, n, cost };
  }
  return best;
}
function gcd(a, b) { return b ? gcd(b, a % b) : a; }

function sc(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
/* Soft knee: exactly linear up to t, then rounding smoothly toward m. Used
 * wherever the chain needs a safety bound but should not colour the sound
 * in normal use. */
function knee(x, t, m) {
  if (x <= t && x >= -t) return x;
  const a = x < 0 ? -x : x;
  const y = t + (m - t) * sc((a - t) / (m - t));
  return x < 0 ? -y : y;
}
function dbOf(x) { return 20 * Math.log10(x + 1e-7); }
function norm(db) { const n = (db + 60) / 54; return n < 0 ? 0 : n > 1 ? 1 : n; }
function coef(seconds, rate) { return 1 - Math.exp(-1 / Math.max(1e-6, seconds * rate)); }

function readH(buf, len, pos) {
  if (pos < 0) pos += len;
  const i = pos | 0;
  const f = pos - i;
  const im1 = i === 0 ? len - 1 : i - 1;
  const i1 = i + 1 >= len ? 0 : i + 1;
  const i2 = i1 + 1 >= len ? 0 : i1 + 1;
  const xm1 = buf[im1], x0 = buf[i], x1 = buf[i1], x2 = buf[i2];
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

class Allpass {
  constructor(n, g) { this.b = new Float32Array(n); this.n = n; this.i = 0; this.g = g; }
  run(x) {
    const b = this.b, i = this.i, d = b[i], v = x - this.g * d;
    b[i] = v;
    this.i = i + 1 === this.n ? 0 : i + 1;
    return d + this.g * v;
  }
  clear() { this.b.fill(0); }
}

/* Four-line feedback delay network with input diffusion. */
class FDN4 {
  constructor(sr, ms, diff) {
    const n = ms.map((m) => Math.max(16, Math.round(m * sr / 1000)));
    this.n0 = n[0]; this.n1 = n[1]; this.n2 = n[2]; this.n3 = n[3];
    this.l0 = new Float32Array(n[0]); this.l1 = new Float32Array(n[1]);
    this.l2 = new Float32Array(n[2]); this.l3 = new Float32Array(n[3]);
    this.i0 = 0; this.i1 = 0; this.i2 = 0; this.i3 = 0;
    this.s0 = 0; this.s1 = 0; this.s2 = 0; this.s3 = 0;
    this.aL1 = new Allpass(Math.round(sr * diff[0] / 1000), 0.62);
    this.aL2 = new Allpass(Math.round(sr * diff[1] / 1000), 0.55);
    this.aR1 = new Allpass(Math.round(sr * diff[2] / 1000), 0.62);
    this.aR2 = new Allpass(Math.round(sr * diff[3] / 1000), 0.55);
    this.g = 0.6; this.k = 0.4; this.nrm = 1;
    this.outL = 0; this.outR = 0;
  }
  set(decay, dampK) {
    this.g = decay;
    this.k = dampK;
    this.nrm = Math.sqrt(1 - decay * decay) * 1.5;
  }
  run(inL, inR) {
    const xl = this.aL2.run(this.aL1.run(inL));
    const xr = this.aR2.run(this.aR1.run(inR));
    const a = this.l0[this.i0], b = this.l1[this.i1], c = this.l2[this.i2], d = this.l3[this.i3];
    const k = this.k;
    const s0 = (this.s0 += (a - this.s0) * k);
    const s1 = (this.s1 += (b - this.s1) * k);
    const s2 = (this.s2 += (c - this.s2) * k);
    const s3 = (this.s3 += (d - this.s3) * k);
    const g = this.g * 0.5;
    this.l0[this.i0] = xl + g * (s0 + s1 + s2 + s3);
    this.l1[this.i1] = xr + g * (s0 - s1 + s2 - s3);
    this.l2[this.i2] = -xl * 0.6 + g * (s0 + s1 - s2 - s3);
    this.l3[this.i3] = xr * 0.6 + g * (s0 - s1 - s2 + s3);
    if (++this.i0 === this.n0) this.i0 = 0;
    if (++this.i1 === this.n1) this.i1 = 0;
    if (++this.i2 === this.n2) this.i2 = 0;
    if (++this.i3 === this.n3) this.i3 = 0;
    this.outL = (a - d) * this.nrm;
    this.outR = (b - c) * this.nrm;
  }
  clear() {
    this.l0.fill(0); this.l1.fill(0); this.l2.fill(0); this.l3.fill(0);
    this.s0 = this.s1 = this.s2 = this.s3 = 0;
    this.aL1.clear(); this.aL2.clear(); this.aR1.clear(); this.aR2.clear();
  }
}

/* True-peak estimate: interpolates three points between samples with a
 * windowed-sinc polyphase filter (4x oversampling), so the limiter sees the
 * peaks a converter would reconstruct, not just the sample values. */
const TP_TAPS = 12;
const TP_H = (() => {
  const h = new Float64Array(3 * TP_TAPS);
  for (let p = 1; p <= 3; p++) {
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      const t = k - (TP_TAPS / 2 - 1) - p / 4;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (TP_TAPS / 2 + 1));
      h[(p - 1) * TP_TAPS + k] = sinc * w;
      sum += sinc * w;
    }
    for (let k = 0; k < TP_TAPS; k++) h[(p - 1) * TP_TAPS + k] /= sum;
  }
  return h;
})();
class TruePeak {
  constructor() { this.b = new Float64Array(TP_TAPS * 2); this.i = 0; }
  run(x) {
    const b = this.b, i = this.i;
    b[i] = x; b[i + TP_TAPS] = x;
    this.i = i + 1 === TP_TAPS ? 0 : i + 1;
    // b[this.i .. this.i + TP_TAPS) is the last TP_TAPS samples, oldest first
    const o = this.i;
    let pk = x < 0 ? -x : x;
    for (let p = 0; p < 3; p++) {
      let y = 0;
      const hp = p * TP_TAPS;
      for (let k = 0; k < TP_TAPS; k++) y += TP_H[hp + k] * b[o + k];
      if (y < 0) y = -y;
      if (y > pk) pk = y;
    }
    return pk;
  }
  clear() { this.b.fill(0); }
}

/* Transposed direct-form II biquad (RBJ cookbook). */
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(kind, f, q, sr) {
    const w = TWO_PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    const k = kind === 'hp' ? (1 + c) / 2 : (1 - c) / 2;
    this.b0 = k / a0; this.b1 = (kind === 'hp' ? -2 * k : 2 * k) / a0; this.b2 = k / a0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  clear() { this.z1 = this.z2 = 0; }
}

/* Exciter: the band above its corner (and below 5.2 kHz) is normalised by
 * its own envelope and bent through Chebyshev polynomials, which make its
 * second and third harmonics and nothing higher, so nothing can fold back
 * past the Nyquist limit. What comes out is scaled back to the band's level
 * and high-passed, leaving only the new harmonics. The envelope looks 1 ms
 * ahead and moves smoothly, like the limiter's, so it is always above the
 * band without ever bending the result. */
class Exciter {
  constructor(sr) {
    this.sr = sr;
    this.h1 = new Biquad(); this.h2 = new Biquad();
    this.l1 = new Biquad().set('lp', 5200, 0.5412, sr);
    this.l2 = new Biquad().set('lp', 5200, 1.3066, sr);
    this.N = Math.max(8, Math.round(sr * 0.001));
    this.buf = new Float64Array(64); this.bi = 0;
    this.pk = 0; this.hold = 0; this.e1 = 0; this.env = 0;
    this.atk = 1 - Math.exp(-7 / this.N); this.rel = coef(0.05, sr); this.dec = Math.exp(-1 / (0.05 * sr));
    this.tune(1000);
  }
  tune(f) { this.h1.set('hp', f, 0.7071, this.sr); this.h2.set('hp', f * 1.6, 0.7071, this.sr); }
  run(x) {
    const b = this.l2.run(this.l1.run(this.h1.run(x)));
    const a = b < 0 ? -b : b;
    if (a >= this.pk) { this.pk = a; this.hold = this.N; }
    else if (this.hold > 0) this.hold--;
    else this.pk *= this.dec;
    this.e1 += (this.pk - this.e1) * (this.pk > this.e1 ? this.atk : this.rel);
    this.env += (this.e1 - this.env) * (this.e1 > this.env ? this.atk : this.rel);
    const bi = this.bi, bd = this.buf[(bi + 64 - this.N) & 63];
    this.buf[bi] = b; this.bi = (bi + 1) & 63;
    const e = this.env * 1.25 + 1e-7;
    let u = bd / e;
    // the look-ahead keeps |u| near 0.8 at most; a rare overshoot is rounded, never cornered
    if (u > 0.95) u = u > 1.45 ? 1.2 : 0.95 + (u - 0.95) - (u - 0.95) * (u - 0.95);
    else if (u < -0.95) u = u < -1.45 ? -1.2 : -0.95 + (u + 0.95) + (u + 0.95) * (u + 0.95);
    const u2 = u * u;
    return this.h2.run(e * (0.55 * (2 * u2 - 1) + 0.45 * u * (4 * u2 - 3)));
  }
  clear() { this.h1.clear(); this.h2.clear(); this.l1.clear(); this.l2.clear(); this.buf.fill(0); this.pk = this.e1 = this.env = 0; this.hold = 0; }
}

/* Harmonizer: two pitch-shifted voices of the loop, at just intervals.
 * Each voice reads a short delay line through three heads a third of a
 * window apart; each head sweeps its delay at the rate that gives the new
 * pitch and fades in and out on a sine-squared window, so the three always
 * sum to a steady level and no head is ever heard jumping back. What goes
 * in is low-passed below the Nyquist limit divided by the highest voice's
 * ratio, so a voice pitched up never folds its top back down as aliasing. */
const HWN = 2048;
const HWIN = new Float64Array(HWN + 2);
for (let i = 0; i <= HWN + 1; i++) { const v = Math.sin(Math.PI * Math.min(1, i / HWN)); HWIN[i] = v * v; }
const HBUF = 8192;
class Harmonizer {
  constructor(sr) {
    this.sr = sr; this.fc = 0;
    this.f = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new Biquad());
    this.limit(1);
    this.bL = new Float32Array(HBUF); this.bR = new Float32Array(HBUF);
    this.w = 0; this.pA = 0; this.pB = 0;
    this.outL = 0; this.outR = 0; this.vl = 0; this.vr = 0;
  }
  limit(ratio) {
    // eighth-order Butterworth, its corner well inside the limit
    const fc = Math.min(20000, (0.38 * this.sr) / Math.max(1, ratio));
    if (Math.abs(fc - this.fc) < 1) return;
    this.fc = fc;
    const Q = [0.5098, 0.6013, 0.9000, 2.5629];
    for (let k = 0; k < 4; k++) { this.f[k].set('lp', fc, Q[k], this.sr); this.f[k + 4].set('lp', fc, Q[k], this.sr); }
  }
  write(l, r) {
    const f = this.f;
    this.bL[this.w] = f[3].run(f[2].run(f[1].run(f[0].run(l))));
    this.bR[this.w] = f[7].run(f[6].run(f[5].run(f[4].run(r))));
    this.w = (this.w + 1) & (HBUF - 1);
  }
  voice(p, W) {
    const bL = this.bL, bR = this.bR, w = this.w;
    let l = 0, r = 0;
    for (let k = 0; k < 3; k++) {
      let q = p + k / 3;
      if (q >= 1) q -= 1;
      let pos = w - 64 - q * W;
      if (pos < 0) pos += HBUF;
      const i = pos | 0, f = pos - i, i1 = (i + 1) & (HBUF - 1);
      const t = q * HWN, ti = t | 0;
      const g = HWIN[ti] + (HWIN[ti + 1] - HWIN[ti]) * (t - ti);
      l += g * (bL[i] + (bL[i1] - bL[i]) * f);
      r += g * (bR[i] + (bR[i1] - bR[i]) * f);
    }
    this.vl = l * (2 / 3); this.vr = r * (2 / 3);
  }
  run(l, r, rA, rB, W) {
    this.write(l, r);
    this.voice(this.pA, W);
    let ol = this.vl, or = this.vr;
    this.voice(this.pB, W);
    ol += this.vl; or += this.vr;
    this.outL = ol * Math.SQRT1_2; this.outR = or * Math.SQRT1_2;
    // a delay that shrinks raises the pitch: d' = 1 - ratio
    let pa = this.pA + (1 - rA) / W; pa -= Math.floor(pa); this.pA = pa;
    let pb = this.pB + (1 - rB) / W; pb -= Math.floor(pb); this.pB = pb;
  }
  clear() { this.bL.fill(0); this.bR.fill(0); this.outL = this.outR = 0; for (const b of this.f) b.clear(); }
}

// Just intervals for the harmonizer, by semitone; anything else is equal-tempered.
const JUST = { '-24': 1 / 4, '-19': 1 / 3, '-17': 3 / 8, '-12': 1 / 2, '-9': 3 / 5, '-8': 5 / 8, '-7': 2 / 3, '-5': 3 / 4, '-4': 4 / 5, '-3': 5 / 6,
  0: 1, 3: 6 / 5, 4: 5 / 4, 5: 4 / 3, 7: 3 / 2, 8: 8 / 5, 9: 5 / 3, 12: 2, 15: 12 / 5, 16: 5 / 2, 19: 3, 24: 4 };
function ratioOf(st) {
  const k = Math.round(clamp(+st || 0, -24, 24));
  return JUST[k] !== undefined ? JUST[k] : Math.pow(2, k / 12);
}

/* Allpass-pair Hilbert transformer: i and q are 90 degrees apart. */
const HA = [0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737].map((a) => a * a);
const HB = [0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278].map((a) => a * a);
class Hilbert {
  constructor() { this.s = new Float64Array(32); this.dly = 0; this.i = 0; this.q = 0; }
  run(x) {
    const s = this.s;
    let u = x;
    for (let k = 0; k < 4; k++) {
      const o = k * 4;
      const y = HA[k] * (u + s[o + 3]) - s[o + 1];
      s[o + 1] = s[o]; s[o] = u; s[o + 3] = s[o + 2]; s[o + 2] = y;
      u = y;
    }
    let v = x;
    for (let k = 0; k < 4; k++) {
      const o = 16 + k * 4;
      const y = HB[k] * (v + s[o + 3]) - s[o + 1];
      s[o + 1] = s[o]; s[o] = v; s[o + 3] = s[o + 2]; s[o + 2] = y;
      v = y;
    }
    this.i = this.dly;
    this.dly = u;
    this.q = v;
  }
  clear() { this.s.fill(0); this.dly = this.i = this.q = 0; }
}

class KybernetesProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = sampleRate;
    this.sr = sr;
    this.invSr = 1 / sr;
    this.crHz = sr / CR;

    // Tape loop (stereo, two heads)
    this.tapeLen = Math.ceil(sr * 9.5);
    this.tapeL = new Float32Array(this.tapeLen);
    this.tapeR = new Float32Array(this.tapeLen);
    this.tw = 0;
    this.tlp = 0; this.trp = 0;
    // Record-level control at the tape head: 1 ms of look-ahead lets the gain
    // ease down before a peak is written, so the tape never saturates.
    this.alcN = Math.max(8, Math.round(sr * 0.001));
    this.alcL = new Float64Array(64); this.alcR = new Float64Array(64); this.alcI = 0;
    this.alcEnv = 0; this.alcHold = 0; this.alcG = 1;
    this.alcAtk = 1 - Math.exp(-7 / this.alcN);
    this.alcG1 = 1;
    this.tapeS = 1; this.tapeV = 0; this.spreadS = 1.1;

    // Reels: a self-recording buffer and a held-material buffer each
    this.reelMax = Math.ceil(sr * 24);
    this.selfBuf = [0, 1, 2, 3].map(() => new Float32Array(this.reelMax));
    this.heldBuf = [null, null, null, null];
    this.heldLen = new Int32Array(4);
    this.heldGen = new Uint32Array(4);
    this.reelMode = new Uint8Array(4);    // 0 off, 1 self, 2 held tape
    this.reelSelfLen = new Int32Array(4).fill(sr * 6);
    this.reelBase = new Float64Array(4);
    this.reelSpeed = new Float64Array(4).fill(1);
    this.reelRecSrc = new Int8Array(4).fill(-1);
    this.reelPos = new Float64Array(4);
    this.reelW = new Int32Array(4);
    this.reelRecS = new Float64Array(4);
    this.reelBuf = [null, null, null, null];
    this.reelLen = new Int32Array(4);
    this.capture = -1; this.captureLeft = 0; this.captureW = 0;
    this.reelFade = new Float64Array(4).fill(1);  // fades a reel out before it changes
    this.reelWant = [null, null, null, null];     // a pending change, applied once faded
    this.reelFadeT = new Float64Array(4).fill(1);
    this.reelWin = new Float64Array(4).fill(sr * 0.04);
    this.reelSig = ['', '', '', ''];
    this.reelStop = new Float64Array(4).fill(-1);   // where recording last stopped
    this.reelWrap = new Float64Array(4);            // what is left of a splice at the wrap point
    this.reelSelfPrev = new Int32Array(4);          // the loop length the tape was recorded at
    this.reelU = new Float64Array(4).fill(1);       // each head's distance from a seam, as played
    this.reelUb = new Float64Array(4).fill(1);
    this.reelSince = new Float64Array(4);
    this.reelWas = new Uint8Array(4);

    // Generators
    this.ph = new Float64Array([0, 0.25, 0.5, 0.75]);
    this.gy = new Float64Array(4);
    this.gy2 = new Float64Array(4);
    this.gBase = new Float64Array([55, 82, 138, 233]);
    this.gFold = new Float64Array(4);
    this.rp = new Float64Array([1, 1, 1, 1]);
    this.rq = new Float64Array([1, 1, 1, 1]);
    // Warmth: how far the web has settled into one harmonic series
    this.warmA = 0.3; this.warmT = 0; this.warmSpace = -1; this.tune = 0;
    this.temper = 0.6; this.tOff = 0; this.tP = 0.5; this.tDir = 1; this.tTurns = 0; this.tHold = 1;
    this.hCorr = new Float64Array(4);                // octaves to each generator's harmonic
    this.rpH = new Float64Array([1, 1, 1, 1]);       // the neighbour ratio within that series
    this.rqH = new Float64Array([1, 1, 1, 1]);

    // Filter bank
    this.b0 = new Float64Array(NB); this.a1 = new Float64Array(NB); this.a2 = new Float64Array(NB);
    this.zl1 = new Float64Array(NB); this.zl2 = new Float64Array(NB);
    this.zr1 = new Float64Array(NB); this.zr2 = new Float64Array(NB);
    this.benv = new Float64Array(NB);
    this.bg = new Float64Array(NB);      // per-sample band gain
    this.dbg = new Float64Array(NB);
    this.cg = new Float64Array(NB).fill(1);  // inverted-VCA gain per band
    this.eff = new Float64Array(NB);     // carving after tilt and rotation
    this.lvl = new Float64Array(NB);     // band level before its inverted VCA
    this.post = new Float64Array(NB);    // band energy after gain
    this.user = new Float64Array(NB).fill(0.6);
    this.bankQ = 0;
    this.bankNorm = 1;       // normalisation of the flat bank
    this.carveNorm = 1;      // normalisation of the bank as currently carved
    this.hRe = new Float64Array(NB * NB);
    this.hIm = new Float64Array(NB * NB);
    this.normTick = 0;

    // Wave shaper: per generator, the weights of harmonics 1-6 (ramped per sample)
    this.shapeBase = 0; this.shapeOdd = 0; this.shapeOn = false;
    this.sw = new Float64Array(24); this.swD = new Float64Array(24); this.swT = new Float64Array(6);
    for (let i = 0; i < 4; i++) this.sw[i * 6] = 1;
    // Exciter and harmonizer, in the loop after the shifter
    this.exL = new Exciter(sr); this.exR = new Exciter(sr); this.excBase = 0; this.excF = 1000;
    this.harm = new Harmonizer(sr); this.harmBase = 0; this.harmWin = 0.09;
    this.harmRA = 2; this.harmRB = 0.5; this.lrA = Math.log(2); this.lrB = Math.log(0.5); this.hWinS = 0.09 * sr;

    // Shifter and smear
    this.hL = new Hilbert(); this.hR = new Hilbert();
    this.shPL = 0; this.shPR = 0;
    this.smear = new FDN4(sr, [31.7, 41.3, 53.9, 67.1], [4.7, 11.3, 5.3, 12.7]);
    this.space = new FDN4(sr, [89.3, 113.1, 137.9, 167.3], [7.1, 17.9, 8.3, 19.1]);
    this.space.set(0.86, coef(1 / (TWO_PI * 5200), sr));

    // Loop state
    this.lastL = 0; this.lastR = 0;
    this.envCasc = 0; this.envLoop = 0; this.envOut = 0; this.envReel = 0;
    this.loopDb = -90; this.loopSlow = -60;
    this.trim = 0; this.fastG = 1; this.loopNorm = 1;
    this.clampAmt = 0; this.centHz = 500;
    this.mixMono = 0;
    this.recEnv = 0; this.recAlc = 1;
    this.hpL1 = 0; this.hpL2 = 0; this.hpR1 = 0; this.hpR2 = 0;
    {
      const w = TWO_PI * 32 / sr, al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
      this.hpB0 = (1 + Math.cos(w)) / 2 / a0;
      this.hpB1 = -(1 + Math.cos(w)) / a0;
      this.hpA1 = -2 * Math.cos(w) / a0;
      this.hpA2 = (1 - al) / a0;
    }
    this.limEnv = 0; this.limG = 1; this.limHold = 0;
    this.shelfL = 0; this.shelfR = 0; this.shelfG = 0; this.shelfK = coef(1 / (TWO_PI * 1800), sr);
    this.govEnv = 0; this.govG = 1;
    this.cmpEnv = 0; this.cmpG = 1; this.cmpT = 1;
    this.cascEnv = 0.25; this.cascG = 1; this.cascT = 1; this.xm1 = 0; this.xm2 = 0; this.xEdge = 0;
    this.lvlEnv = 0; this.lvlRef = 0; this.lvlG = 1; this.lvlT = 1;
    this.tpL = new TruePeak(); this.tpR = new TruePeak();
    this.recOn = false; this.recBuf = null; this.recW = 0;
    this.limN = Math.max(16, Math.round(sr * 0.0015));
    this.limBufL = new Float32Array(this.limN); this.limBufR = new Float32Array(this.limN); this.limI = 0;
    this.limAtk = 1 - Math.exp(-7 / this.limN);
    this.limG1 = 1;

    // Perturbation (the steersman's strike)
    this.pertOn = false; this.pertT = 0; this.pertPh = 0; this.pertA = 0;

    // Matrix and logic
    this.M = new Float64Array(NSRC * NDST);
    this.src = new Float64Array(NSRC);
    this.habitAvg = new Float64Array(NSRC);
    this.habitSet = new Uint8Array(NSRC);
    this.mT = new Float64Array(NDST);
    this.md = new Float64Array(NDST);
    this.mdG = new Float64Array(NDST);   // pitch-like destinations, after the glide
    this.glide = 10;
    this.hold = 0.85;
    this.gA = new Int8Array([4, 8, 2, 3]);
    this.gB = new Int8Array([6, 9, 5, 1]);
    this.gMode = new Uint8Array(4);
    this.gH = new Float64Array(4).fill(0.05);
    this.gK = new Float64Array(4);
    this.gState = new Uint8Array(4);
    this.gCmp = new Uint8Array(4);
    this.gS = new Float64Array(4);

    // Helm
    this.helmT = new Float64Array([0.5, 0, 0, -20, 1, 2, 0.7, 0.3]);
    this.helmA = new Float64Array(this.helmT);

    // Parameters from the architecture
    this.syncBase = 0.1; this.pmBase = 0.05;
    this.multBase = new Float64Array([0.9, 0.7, 0.5, 0.3]);
    this.drive = 1.4;
    this.fbBase = 0.9; this.timeBase = 1.6; this.spread = 1.1; this.toneK = 0.3;
    this.shiftBase = 0.3; this.shiftSpread = 1; this.smearBase = 0.4; this.decay = 0.6;
    this.cross = 0.2;
    this.fbCap = 4;
    this.ceil = 6; this.ceilEff = 6; this.strength = 0.85; this.release = 1.2; this.breath = 0.4; this.depth = 6;
    this.inhale = true; this.trimPeak = 0; this.breaths = 0; this.dipped = true;
    this.metab = 1;
    this.resetMetab();
    this.reelToLoop = 0.4; this.reelToMult = 0.2; this.liveIn = 0;
    this.outLoop = 0.9; this.outDry = 0.12; this.outReels = 0.35; this.outSpace = 0.35;

    this.P = new Float64Array(NRAMP);
    this.dP = new Float64Array(NRAMP);

    this.running = false;
    this.fade = 0; this.fadeTarget = 0; this.haltPending = false;
    this.elapsed = 0;
    this.blocks = 0;

    this.applyArch(options && options.processorOptions && options.processorOptions.arch);
    // start at the architecture's own helm rather than gliding in from defaults
    this.helmA.set(this.helmT);
    this.warmA = this.helmT[H_WARM];
    this.hWinS = this.harmWin * sr;
    this.lrA = Math.log(this.harmRA); this.lrB = Math.log(this.harmRB);
    // a web that leans cold first turns warm, and one that leans warm first cools
    this.tDir = this.warmA < 0.5 ? 1 : -1;
    if (this.bankQ === 0) this.setBank(4.32);
    this.primeRamps();
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  /* ---------- architecture ---------- */

  applyArch(a) {
    if (!a) return;
    const sr = this.sr;
    for (let i = 0; i < 4; i++) {
      this.gBase[i] = clamp(+a.gens[i].f || 55, 8, 5000);
      this.gFold[i] = clamp(+a.gens[i].fold || 0, 0, 2.5);
    }
    {
      const hs = harmonicSeries([...this.gBase]);
      for (let i = 0; i < 4; i++) {
        this.hCorr[i] = Math.log2(hs.n[i] * hs.f0 / this.gBase[i]);
        const j = (i + 3) & 3, g = gcd(hs.n[i], hs.n[j]);
        this.rpH[i] = hs.n[i] / g; this.rqH[i] = hs.n[j] / g;
      }
    }
    this.syncBase = clamp(+a.sync || 0, 0, 1);
    const Sh = a.shape || {};
    this.shapeBase = clamp(+Sh.amount || 0, 0, 1);
    this.shapeOdd = clamp(+Sh.odd || 0, 0, 1);
    const Ex = a.exciter || {};
    this.excBase = clamp(+Ex.amount || 0, 0, 1);
    const ef = clamp(+Ex.freq || 1000, 400, 4000);
    if (ef !== this.excF) { this.excF = ef; this.exL.tune(ef); this.exR.tune(ef); }
    const Hm = a.harm || {};
    this.harmBase = clamp(+Hm.mix || 0, 0, 1);
    this.harmRA = ratioOf(Hm.a === undefined ? 12 : Hm.a);
    this.harmRB = ratioOf(Hm.b === undefined ? -12 : Hm.b);
    this.harmWin = clamp(+Hm.window || 0.09, 0.03, 0.15);
    this.glide = a.glide === undefined ? 10 : clamp(+a.glide, 0.05, 60);
    this.hold = a.hold === undefined ? 0.85 : clamp(+a.hold, 0, 1);
    this.pmBase = clamp(+a.pm || 0, 0, 1);
    for (let i = 0; i < 4; i++) this.multBase[i] = clamp(+a.mult[i] || 0, 0, 1);
    this.drive = clamp(+a.drive || 1, 0.25, 4);
    const L = a.loop;
    this.fbBase = clamp(+L.fb, 0, 1.3);
    this.timeBase = clamp(+L.time, 0.01, 9);
    this.spread = clamp(+L.spread, 0.5, 2);
    // Tape tone: each pass through the record head loses a little top end.
    const tone = clamp(+L.tone, 0, 1);
    this.toneK = tone > 0.98 ? 1 : Math.min(1, coef(1 / (TWO_PI * (1500 * Math.pow(2, tone * 3.8))), sr));
    this.shiftBase = clamp(+L.shift, -60, 60);
    this.shiftSpread = clamp(+L.shiftSpread, 0, 1);
    this.smearBase = clamp(+L.smear, 0, 1);
    this.decay = clamp(+L.decay, 0, 0.97);
    this.smear.set(0.25 + this.decay * 0.72, Math.min(1, coef(1 / (TWO_PI * (5000 + 14000 * (1 - this.decay))), sr)));
    this.cross = clamp(+L.cross, 0, 0.5);
    const bank = a.bank;
    // The carving curve is a shape: its peak is unity, the homeostat sets the level.
    let peak = 0;
    for (let k = 0; k < NB; k++) peak = Math.max(peak, clamp(+bank.gains[k] || 0, 0, 1.5));
    for (let k = 0; k < NB; k++) this.user[k] = peak > 0.01 ? clamp(+bank.gains[k] || 0, 0, 1.5) / peak : 0;
    const q = clamp(+bank.q || 4.3, 1.5, 24);
    if (q !== this.bankQ) this.setBank(q);
    const H = a.homeo;
    this.ceil = clamp(+H.ceil, 0, 24);
    this.strength = clamp(+H.strength, 0, 1.5);
    this.release = clamp(+H.release, 0.05, 30);
    this.breath = clamp(+H.breath, 0, 2);
    this.depth = clamp(+H.depth || 6, 1, 24);
    this.metab = H.metab === undefined ? 1 : clamp(+H.metab, 0, 2);
    this.temper = H.temper === undefined ? 0.6 : clamp(+H.temper, 0, 1);
    this.M.fill(0);
    for (const p of a.matrix || []) {
      const i = p[0] | 0, j = p[1] | 0;
      if (i >= 0 && i < NSRC && j >= 0 && j < NDST) this.M[i * NDST + j] = clamp(+p[2], -1, 1);
    }
    for (let g = 0; g < 4; g++) {
      const G = a.gates[g];
      this.gA[g] = clamp(G.a | 0, 0, NSRC - 1);
      this.gB[g] = clamp(G.b | 0, -1, NSRC - 1);
      this.gMode[g] = G.mode === 'lt' ? 1 : G.mode === 'flip' ? 2 : 0;
      this.gH[g] = clamp(+G.h, 0, 0.5);
      this.gK[g] = clamp(+G.k || 0, -1, 1);
    }
    for (let r = 0; r < 4; r++) {
      const R = a.reels[r];
      this.reelMode[r] = R.mode === 'self' ? 1 : R.mode === 'tape' ? 2 : 0;
      this.reelSelfLen[r] = Math.round(clamp(+R.len || 6, 0.5, 24) * sr);
      if (this.reelSelfLen[r] > this.reelMax) this.reelSelfLen[r] = this.reelMax;
      this.reelBase[r] = clamp(+R.level, 0, 1.25);
      this.reelSpeed[r] = clamp(+R.speed, -4, 4);
      this.reelRecSrc[r] = clamp(R.rec | 0, -1, 4);
    }
    this.reelToLoop = clamp(+a.reelToLoop, 0, 1.5);
    this.reelToMult = clamp(+a.reelToMult, 0, 1.5);
    this.liveIn = clamp(+a.liveIn || 0, 0, 1.5);
    const O = a.out;
    this.outLoop = clamp(+O.loop, 0, 1.5);
    this.outDry = clamp(+O.dry, 0, 1.5);
    this.outReels = clamp(+O.reels, 0, 1.5);
    this.outSpace = clamp(+O.space, 0, 1.5);
    if (a.helm) this.setHelm(a.helm);
    this.selectReels();
  }

  setHelm(h) {
    for (let i = 0; i < HELM_KEYS.length; i++) {
      const v = h[HELM_KEYS[i]];
      if (typeof v === 'number' && isFinite(v)) this.helmT[i] = v;
    }
    const T = this.helmT;
    T[H_INFLOW] = clamp(T[H_INFLOW], 0, 1.5);
    T[H_BIAS] = clamp(T[H_BIAS], -1, 1);
    T[H_DRIFT] = clamp(T[H_DRIFT], -24, 24);
    T[H_SET] = clamp(T[H_SET], -48, -3);
    T[H_COUP] = clamp(T[H_COUP], 0, 2);
    T[H_ERA] = clamp(T[H_ERA], 0.25, 64);
    T[H_VOL] = clamp(T[H_VOL], 0, 1);
    T[H_WARM] = clamp(T[H_WARM], 0, 1);
  }

  setBank(q) {
    const sr = this.sr;
    this.bankQ = q;
    for (let k = 0; k < NB; k++) {
      const w = TWO_PI * BAND_HZ[k] / sr;
      if (w > Math.PI * 0.9) { this.b0[k] = 0; this.a1[k] = 0; this.a2[k] = 0; continue; }
      const alpha = Math.sin(w) / (2 * q);
      const a0 = 1 + alpha;
      this.b0[k] = alpha / a0;
      this.a1[k] = -2 * Math.cos(w) / a0;
      this.a2[k] = (1 - alpha) / a0;
    }
    // Normalise so the summed bank is close to unity gain across its range.
    let acc = 0, cnt = 0;
    for (let m = 0; m < 120; m++) {
      const f = 63 * Math.pow(12500 / 63, m / 119);
      const w = TWO_PI * f / sr;
      const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      let re = 0, im = 0;
      for (let k = 0; k < NB; k++) {
        const b0 = this.b0[k];
        if (b0 === 0) continue;
        const nr = b0 * (1 - c2), ni = b0 * s2;
        const dr = 1 + this.a1[k] * c1 + this.a2[k] * c2;
        const di = -this.a1[k] * s1 - this.a2[k] * s2;
        const den = dr * dr + di * di;
        re += (nr * dr + ni * di) / den;
        im += (ni * dr - nr * di) / den;
      }
      acc += Math.sqrt(re * re + im * im);
      cnt++;
    }
    this.bankNorm = cnt / Math.max(1e-6, acc);
    // Each band's response at every band centre, for normalising the carved bank.
    for (let k = 0; k < NB; k++) {
      const w = TWO_PI * BAND_HZ[k] / sr;
      const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      for (let j = 0; j < NB; j++) {
        const b0 = this.b0[j];
        const o = j * NB + k;
        if (b0 === 0) { this.hRe[o] = 0; this.hIm[o] = 0; continue; }
        const nr = b0 * (1 - c2), ni = b0 * s2;
        const dr = 1 + this.a1[j] * c1 + this.a2[j] * c2;
        const di = -this.a1[j] * s1 - this.a2[j] * s2;
        const den = dr * dr + di * di;
        this.hRe[o] = (nr * dr + ni * di) / den;
        this.hIm[o] = (ni * dr - nr * di) / den;
      }
    }
    this.normTick = 0;
  }

  /* What a reel would play now; a change of this means a fade first. */
  reelSignature(r) {
    const m = this.reelMode[r];
    if (m === 1) return `self:${this.reelSelfLen[r]}`;
    if (m === 2 && this.heldBuf[r]) return `held:${this.heldLen[r]}:${this.heldGen[r]}`;
    return 'off';
  }

  /* Ask for a reel to change; it fades out, changes, and fades back in. */
  requestReel(r, action) {
    const silent = this.reelLen[r] === 0 || this.reelFade[r] < 0.002 || !this.running;
    if (silent) {
      if (action) action();
      this.selectReel(r);
      this.reelFade[r] = 0;
      return;
    }
    const prev = this.reelWant[r];
    this.reelWant[r] = () => { if (prev) prev(); if (action) action(); };
  }

  selectReels() {
    for (let r = 0; r < 4; r++) {
      const sig = this.reelSignature(r);
      if (sig !== this.reelSig[r]) this.requestReel(r, null);
    }
  }

  selectReel(r) {
    this.reelSig[r] = this.reelSignature(r);
    {
      const m = this.reelMode[r];
      if (m === 1) {
        this.reelBuf[r] = this.selfBuf[r]; this.reelLen[r] = this.reelSelfLen[r];
        // Recording runs straight across the wrap point, so normally it is no
        // splice at all. A new loop length makes one there (and, if longer,
        // where the old loop ended) until recording has worn it away.
        const was = this.reelSelfPrev[r], len = this.reelLen[r];
        if (was > 0 && was !== len) {
          this.reelWrap[r] = Math.LN10 * len;
          if (len > was && this.reelStop[r] < 0) { this.reelStop[r] = was; this.reelSince[r] = 0; }
        }
        this.reelSelfPrev[r] = len;
      }
      else if (m === 2 && this.heldBuf[r]) { this.reelBuf[r] = this.heldBuf[r]; this.reelLen[r] = this.heldLen[r]; }
      else { this.reelBuf[r] = null; this.reelLen[r] = 0; }
      const len = this.reelLen[r];
      if (len > 0) {
        if (this.reelPos[r] >= len) this.reelPos[r] %= len;
        if (this.reelW[r] >= len) this.reelW[r] = 0;
      }
      this.reelWin[r] = Math.max(32, Math.min(this.sr * 0.04, len / 6));
    }
  }

  /* ---------- messages ---------- */

  onMessage(m) {
    switch (m.type) {
      case 'arch': this.applyArch(m.arch); break;
      case 'helm': this.setHelm(m.helm); break;
      case 'engage':
        this.running = true; this.fadeTarget = 1; this.haltPending = false;
        break;
      case 'halt': this.fadeTarget = 0; this.haltPending = true; break;
      case 'perturb':
        this.pertOn = true; this.pertT = 0; this.pertPh = 0;
        this.pertA = clamp(+m.amount || 0.9, 0, 2);
        break;
      case 'reset': this.resetState(); break;
      case 'rec-start':
        this.recBuf = new Float32Array(REC_FRAMES * 2);
        this.recW = 0;
        this.recOn = true;
        break;
      case 'rec-stop':
        if (this.recOn) {
          this.recOn = false;
          this.flushRec();
          this.recBuf = null;
          this.port.postMessage({ type: 'rec-end' });
        }
        break;
      case 'reel-load': {
        const r = m.reel | 0;
        if (r < 0 || r > 3 || !(m.data instanceof Float32Array)) break;
        const data = m.data;
        this.requestReel(r, () => {
          this.heldBuf[r] = data;
          this.heldLen[r] = data.length;
          this.heldGen[r]++;
          this.reelPos[r] = 0;
        });
        this.port.postMessage({ type: 'reel-loaded', reel: r, seconds: data.length / this.sr });
        break;
      }
      case 'reel-clear': {
        const r = m.reel | 0;
        if (r < 0 || r > 3) break;
        this.requestReel(r, () => {
          this.selfBuf[r].fill(0);
          this.reelWrap[r] = 0; this.reelStop[r] = -1;
          this.heldBuf[r] = null; this.heldLen[r] = 0; this.heldGen[r]++;
        });
        break;
      }
      case 'capture': {
        const r = m.reel | 0;
        if (r < 0 || r > 3) break;
        const n = Math.round(clamp(+m.seconds || 8, 0.5, 24) * this.sr);
        this.capture = r;
        this.captureLeft = n;
        this.captureW = 0;
        this.captureBuf = new Float32Array(n);
        break;
      }
      default: break;
    }
  }

  resetState() {
    this.tapeL.fill(0); this.tapeR.fill(0); this.tw = 0; this.tlp = this.trp = 0;
    this.alcL.fill(0); this.alcR.fill(0); this.alcEnv = 0; this.alcHold = 0; this.alcG = 1; this.alcG1 = 1;
    for (let r = 0; r < 4; r++) { this.selfBuf[r].fill(0); this.reelPos[r] = 0; this.reelW[r] = 0; this.reelRecS[r] = 0; }
    this.reelStop.fill(-1); this.reelWrap.fill(0);
    this.ph.set([0, 0.25, 0.5, 0.75]); this.gy.fill(0); this.gy2.fill(0);
    this.zl1.fill(0); this.zl2.fill(0); this.zr1.fill(0); this.zr2.fill(0);
    this.benv.fill(0); this.cg.fill(1);
    this.hL.clear(); this.hR.clear(); this.shPL = this.shPR = 0;
    this.smear.clear(); this.space.clear();
    this.shelfL = this.shelfR = 0;
    this.exL.clear(); this.exR.clear(); this.harm.clear();
    this.lastL = this.lastR = 0;
    this.envCasc = this.envLoop = this.envOut = this.envReel = 0;
    this.loopDb = -90; this.loopSlow = -60; this.trim = 0; this.fastG = 1;
    this.inhale = true; this.trimPeak = 0; this.breaths = 0; this.dipped = true;
    this.resetMetab();
    this.hpL1 = this.hpL2 = this.hpR1 = this.hpR2 = 0; this.limEnv = 0; this.limG = 1; this.limHold = 0;
    this.limBufL.fill(0); this.limBufR.fill(0); this.limG1 = 1;
    this.govEnv = 0; this.govG = 1; this.tpL.clear(); this.tpR.clear();
    this.cmpEnv = 0; this.cmpG = 1; this.cmpT = 1;
    this.cascEnv = 0.25; this.cascG = 1; this.cascT = 1; this.xm1 = 0; this.xm2 = 0; this.xEdge = 0;
    this.lvlEnv = 0; this.lvlRef = 0; this.lvlG = 1; this.lvlT = 1;
    this.md.fill(0); this.mdG.fill(0); this.gState.fill(0); this.gCmp.fill(0); this.gS.fill(0); this.habitSet.fill(0);
    this.recEnv = 0; this.recAlc = 1;
    this.elapsed = 0;
    this.primeRamps();
  }

  primeRamps() {
    this.control();
    const P = this.P, dP = this.dP;
    for (let i = 0; i < NRAMP; i++) { P[i] += dP[i] * CR; dP[i] = 0; }
    for (let k = 0; k < NB; k++) { this.bg[k] += this.dbg[k] * CR; this.dbg[k] = 0; }
    this.tapeS = this.timeBase; this.tapeV = 0;
    this.spreadS = clamp(this.timeBase * this.spread, 0.01, 9) / this.timeBase;
    P[R_DL] = this.timeBase * this.sr;
    P[R_DR] = clamp(this.timeBase * this.spread, 0.01, 9) * this.sr;
  }

  ramp(i, v) { this.dP[i] = (v - this.P[i]) / CR; }

  /* ---------- metabolism: the regulator of the regulator ----------
   * The homeostat breathes. The metabolism watches the breathing over many
   * minutes. When the breaths become clock-like, or stop, pressure builds;
   * when it is full the metabolism shifts the setpoint, breath depth and
   * ceiling the homeostat works with. It keeps a direction while its shifts
   * make the breathing more varied and turns when they do not, and the long
   * averages of level and regulation lean on each step. Without pressure
   * the offsets drift slowly home. */
  resetMetab() {
    this.mOsp = 0; this.mOdepth = 0; this.mOceil = 0;
    this.mTsp = 0; this.mTdepth = 0; this.mTceil = 0;
    this.mDir = new Float64Array([1, 1, -1]);
    this.mP = 0; this.mReg = 0; this.mRegSlow = 0; this.mRegAtShift = 1; this.mShifts = 0;
    this.mBreathN = 0; this.mLastBreathT = 0; this.mI = 0; this.mdI = 0; this.mPrevI = 0;
    this.mHold = 0; this.mLev = 0; this.mStalled = false;
    this.mTempoSet = false; this.mLS = 0; this.mLVS = 0;
    this.spEff = this.helmT ? this.helmT[H_SET] : -20;
  }

  onBreath(t) {
    this.mBreathN++;
    if (this.mBreathN >= 2) {
      const I = t - this.mLastBreathT;
      if (this.mBreathN === 2) { this.mI = I; this.mdI = 0.15 * I; }
      else { this.mdI += (Math.abs(I - this.mPrevI) - this.mdI) * 0.3; this.mI += (I - this.mI) * 0.3; }
      this.mPrevI = I;
    }
    this.mLastBreathT = t;
  }

  metabolise(dt, sEra, loopDb, sp) {
    const t = this.tSec, amt = this.metab;
    const slowK = dt / (600 * sEra);
    this.mHold += (this.clampAmt - this.mHold) * slowK;
    this.mLev += (clamp(loopDb - sp, -30, 30) - this.mLev) * slowK;
    const stallAfter = Math.max(4 * (this.mI || 30), 150 * sEra);
    const stalled = t > 60 && t - this.mLastBreathT > stallAfter;
    this.mStalled = stalled;
    // Sameness: breaths keeping time like a clock, or a tempo that has not
    // changed in the better part of an hour, or no breathing at all.
    const reg = this.mBreathN >= 4 ? 1 - clamp(this.mdI / (0.5 * this.mI + 1e-6), 0, 1) : 0;
    if (this.mI > 0) {
      const lnI = Math.log(this.mI);
      if (!this.mTempoSet) { this.mTempoSet = true; this.mLS = lnI; this.mLVS = lnI; }
      this.mLS += (lnI - this.mLS) * (dt / (900 * sEra));
      this.mLVS += (lnI - this.mLVS) * (dt / (2700 * sEra));
    }
    const still = this.mBreathN >= 8 && t > 1200 * sEra ? 1 - clamp(Math.abs(this.mLS - this.mLVS) / 0.4, 0, 1) : 0;
    const same = stalled ? 1 : Math.max(reg, 0.8 * still);
    this.mReg = same;
    const dwell = (300 * sEra) / Math.max(0.05, amt);
    this.mRegSlow += (same - this.mRegSlow) * (dt / (dwell * 0.5));
    if (amt > 0 && same > 0.55) this.mP += (dt / dwell) * Math.min(2, (same - 0.55) / 0.225);
    else this.mP = Math.max(0, this.mP - dt / (1.5 * dwell));
    if (this.mP >= 1) this.metabShift(stalled, amt, sEra);
    if (this.mP === 0) {
      const k = dt / (2700 * sEra);
      this.mTsp -= this.mTsp * k; this.mTdepth -= this.mTdepth * k; this.mTceil -= this.mTceil * k;
    }
    const kg = dt / (200 * sEra);
    this.mOsp += (this.mTsp - this.mOsp) * kg;
    this.mOdepth += (this.mTdepth - this.mOdepth) * kg;
    this.mOceil += (this.mTceil - this.mOceil) * kg;
  }

  metabShift(stalled, amt, sEra) {
    this.mP = 0;
    this.mShifts++;
    const d = this.mDir;
    const improved = this.mRegSlow < this.mRegAtShift - 0.05;
    this.mRegAtShift = this.mRegSlow;
    // Where to go next is read off the eyes at this moment, so the sequence
    // of shifts follows the system's own history and never cycles. A shift
    // that made the breathing more varied keeps most of its direction.
    const src = this.src;
    let v0 = src[S_LOW] - src[S_HIGH], v1 = src[S_FLUX] + 0.5 * src[S_CLMP], v2 = src[S_CENT];
    let nv = Math.hypot(v0, v1, v2);
    if (nv < 0.15) { v0 = -d[2]; v1 = d[0]; v2 = d[1]; nv = Math.hypot(v0, v1, v2) || 1; }
    const keep = improved ? 0.7 : 0;
    for (let i = 0; i < 3; i++) d[i] = keep * d[i] + (1 - keep) * [v0, v1, v2][i] / nv;
    const nd = Math.hypot(d[0], d[1], d[2]) || 1;
    for (let i = 0; i < 3; i++) d[i] /= nd;
    // A starving loop cannot reach its setpoint: bring it down, open the ceiling.
    if (stalled && this.inhale) { d[0] = -0.8; d[2] = 0.8; }
    // Over the long run, a bank that is rarely held gets a lower ceiling and
    // one held hard gets a higher one.
    const lean = [0, 0, this.mHold < 0.06 ? -0.4 : this.mHold > 0.3 ? 0.4 : 0];
    const lo = [-6, -4, -5], hi = [6, 8, 8];
    const T = [this.mTsp, this.mTdepth, this.mTceil];
    for (let i = 0; i < 3; i++) {
      const step = 2.5 * amt;
      let v = T[i] + step * clamp(d[i] + lean[i], -1.2, 1.2);
      if (v > hi[i] || v < lo[i]) {
        d[i] = -d[i];
        v = T[i] + step * clamp(d[i] + lean[i], -1.2, 1.2);
      }
      T[i] = clamp(v, lo[i], hi[i]);
    }
    this.mTsp = T[0]; this.mTdepth = T[1]; this.mTceil = T[2];
    this.port.postMessage({
      type: 'metab', t: this.tSec, reason: stalled ? 'stalled' : this.mReg > 0.55 && this.mBreathN >= 4 && 1 - clamp(this.mdI / (0.5 * this.mI + 1e-6), 0, 1) > 0.55 ? 'regular' : 'unchanging',
      sp: T[0], depth: T[1], ceil: T[2], shifts: this.mShifts, interval: this.mI,
    });
  }

  /* ---------- temper: the regulator of colour ----------
   * The ear tires of a colour. While the web keeps one, pressure builds,
   * faster when the web is still (every spectral eye near what it is used
   * to) and slower when it is busy. When it is full the web leans the other
   * way: warmer after a cold spell, colder after a warm one. How far it
   * leans is read off the eyes at that moment, so some warm spells are deep
   * and some barely there, and how long the new colour holds is decided by
   * the logic gates that happen to be open then, so the turns never keep
   * time. Era stretches it all. */
  temperate(sEra) {
    if (this.temper <= 0) { this.tOff = 0; return; }
    const src = this.src, dt = 1 / this.crHz;
    const busy = (Math.abs(src[S_LOW]) + Math.abs(src[S_MID]) + Math.abs(src[S_HIGH]) + Math.abs(src[S_CENT])) * 0.5;
    const still = 1 - clamp(busy, 0, 1);
    this.tP += (dt / (300 * sEra * this.tHold)) * (0.5 + still);
    if (this.tP < 1) return;
    this.tP = 0;
    this.tTurns++;
    // memory up on fresh material, and a low-leaning spectrum, lean further
    const e = clamp(0.5 + 0.4 * (src[S_REEL] - src[S_CASC] + src[S_LOW] - src[S_HIGH]), 0, 1);
    this.tOff = this.tDir * (0.35 + 0.6 * e);
    // each open gate holds the new colour longer: from about half to nearly twice
    let open = 0;
    for (let g = 0; g < 4; g++) open += this.gState[g];
    this.tHold = 0.55 + 0.33 * open;
    this.tDir = -this.tDir;
    this.port.postMessage({ type: 'temper', t: this.tSec, warmer: this.tOff > 0, target: clamp(this.helmT[H_WARM] + this.tOff * this.temper, 0, 1), turns: this.tTurns });
  }

  /* An eye that gets used to what it sees: returns deviation from its own slow average. */
  habit(i, x, range, k) {
    if (!this.habitSet[i]) { this.habitSet[i] = 1; this.habitAvg[i] = x; }
    const d = x - this.habitAvg[i];
    this.habitAvg[i] += d * k;
    return clamp(d / range, -1, 1);
  }

  /* ---------- control rate: the eyes, the matrix, the homeostat ---------- */

  control() {
    const crHz = this.crHz;
    const T = this.helmT, A = this.helmA;
    // The helm turns slowly: the steersman nudges, the system follows.
    const eraNow = A[H_ERA];
    const glide = 3 * Math.sqrt(eraNow);
    const kH = coef(glide, crHz);
    A[H_INFLOW] += (T[H_INFLOW] - A[H_INFLOW]) * kH;
    A[H_BIAS] += (T[H_BIAS] - A[H_BIAS]) * kH;
    A[H_SET] += (T[H_SET] - A[H_SET]) * kH;
    A[H_COUP] += (T[H_COUP] - A[H_COUP]) * kH;
    A[H_WARM] += (T[H_WARM] - A[H_WARM]) * kH;
    A[H_DRIFT] += (T[H_DRIFT] - A[H_DRIFT]) * coef(glide * 3, crHz);
    A[H_ERA] = Math.exp(Math.log(A[H_ERA]) + (Math.log(T[H_ERA]) - Math.log(A[H_ERA])) * coef(1.5, crHz));
    A[H_VOL] += (T[H_VOL] - A[H_VOL]) * coef(0.08, crHz);
    const era = A[H_ERA];
    const sEra = Math.sqrt(era);
    // The metabolism's offsets bend the homeostat's own settings.
    const spEff = clamp(A[H_SET] + this.mOsp, -48, -3);
    const depthEff = clamp(this.depth + this.mOdepth, 1.5, 24);
    this.ceilEff = clamp(this.ceil + this.mOceil, 0, 24);
    this.spEff = spEff;
    this.tSec = this.elapsed / this.sr;

    // ---- the eyes ----
    const src = this.src;
    const loopDb = dbOf(this.envLoop);
    this.loopDb = loopDb;
    this.loopSlow += (loopDb - this.loopSlow) * coef(3 * era, crHz);
    // Each eye reports a deviation, not a state: from the setpoint, or from
    // what that eye has grown used to seeing. Eyes habituate, so the system
    // responds to change, and zero means "as usual".
    const spNow = spEff;
    const kAd = coef(18 * sEra, crHz);
    src[S_CASC] = this.habit(S_CASC, Math.max(-80, dbOf(this.envCasc)), 4, kAd);
    src[S_LOOP] = clamp((loopDb - spNow) / 7, -1, 1);
    src[S_OUT] = this.habit(S_OUT, Math.max(-80, dbOf(this.envOut)), 4, kAd);
    src[S_REEL] = this.habit(S_REEL, Math.max(-70, dbOf(this.envReel)), 5, kAd);

    // Band energies after carving and clamping
    const benv = this.benv, post = this.post, eff = this.eff, cg = this.cg, user = this.user;
    const rot = this.mdG[D_ROT] * 5;
    const tilt = this.mdG[D_TILT];
    // First pass: the carving as bent by tilt and rotation, and each band's
    // level before its inverted VCA.
    const lvl = this.lvl;
    let emax = 0;
    for (let k = 0; k < NB; k++) {
      let x = k - rot;
      x = x < 0 ? 0 : x > NB - 1 ? NB - 1 : x;
      const i0 = x | 0, fr = x - i0, i1 = i0 < NB - 1 ? i0 + 1 : i0;
      const u = user[i0] + (user[i1] - user[i0]) * fr;
      const e = u * Math.pow(2, tilt * ((k - 11.5) / 11.5) * 1.6);
      eff[k] = e;
      lvl[k] = benv[k] * e * this.carveNorm * 0.5;
      if (e > emax) emax = e;
    }
    // A band is held once it rises the ceiling above an even share of the
    // active bands, so a few bands can never hoard the whole loop.
    let pw = 0, nact = 0;
    for (let k = 0; k < NB; k++) if (eff[k] > emax * 0.12) { pw += lvl[k] * lvl[k]; nact++; }
    const ceil = Math.sqrt(pw / Math.max(1, nact)) * Math.pow(10, this.ceilEff / 20) + 1e-9;
    const kAtt = coef(0.02, crHz), kRel = coef(this.release * era, crHz);
    let lo = 0, mi = 0, hi = 0, tot = 0, cen = 0, gsum = 0, gn = 0;
    for (let k = 0; k < NB; k++) {
      const e = eff[k];
      // inverted VCA: loud bands are held down, quiet ones slowly open again
      const level = lvl[k];
      let tg = 1;
      if (level > ceil) tg = Math.pow(ceil / level, this.strength);
      const c = cg[k];
      cg[k] = c + (tg - c) * (tg < c ? kAtt : kRel);
      const g = e * cg[k] * this.carveNorm;
      this.dbg[k] = (g - this.bg[k]) / CR;
      const p = benv[k] * g * 0.5;
      post[k] = p;
      if (k < 8) lo += p; else if (k < 16) mi += p; else hi += p;
      tot += p; cen += p * k;
      if (e > emax * 0.12) { gsum += -dbOf(cg[k]); gn++; }
    }
    // Normalise the carved bank so its loudest point passes at unity: the
    // carving decides which bands lead, the homeostat decides how loud.
    if (--this.normTick <= 0) {
      this.normTick = 8;
      let peak = 0;
      for (let k = 0; k < NB; k++) {
        let re = 0, im = 0;
        for (let j = 0; j < NB; j++) {
          const e = eff[j];
          if (e < 0.01) continue;
          re += e * this.hRe[j * NB + k];
          im += e * this.hIm[j * NB + k];
        }
        const mg = re * re + im * im;
        if (mg > peak) peak = mg;
      }
      const target = 1 / Math.max(0.05, Math.sqrt(peak));
      this.carveNorm += (Math.min(target, 4) - this.carveNorm) * 0.3;
    }
    // Spectral eyes watch each region's share of the whole.
    const totDb = dbOf(tot);
    src[S_LOW] = this.habit(S_LOW, Math.max(-40, dbOf(lo) - totDb), 2.5, kAd);
    src[S_MID] = this.habit(S_MID, Math.max(-40, dbOf(mi) - totDb), 2.5, kAd);
    src[S_HIGH] = this.habit(S_HIGH, Math.max(-40, dbOf(hi) - totDb), 2.5, kAd);
    const cIdx = tot > 1e-9 ? cen / tot : 11.5;
    this.centHz = 63 * Math.pow(2, cIdx / 3);
    src[S_CENT] = this.habit(S_CENT, cIdx, 1.2, kAd);
    src[S_FLUX] = clamp((loopDb - this.loopSlow) / 5, -1, 1);
    // Regulation pressure: mean dB held down across bands, plus the safety clamp.
    const holdDb = gn > 0 ? gsum / gn : 0;
    this.clampAmt = clamp(holdDb / 12 + (1 - this.fastG) * 0.8, 0, 1);
    src[S_CLMP] = 2 * this.clampAmt - 1;

    // ---- logic gates ----
    const kGate = coef(1.0 * sEra, crHz);
    for (let g = 0; g < 4; g++) {
      const a = src[this.gA[g]];
      const b = this.gB[g] < 0 ? this.gK[g] : src[this.gB[g]];
      const h = this.gH[g];
      let st = this.gState[g];
      const mode = this.gMode[g];
      if (mode === 0) { if (a > b + h) st = 1; else if (a < b - h) st = 0; }
      else if (mode === 1) { if (a < b - h) st = 1; else if (a > b + h) st = 0; }
      else {
        let cmp = this.gCmp[g];
        if (a > b + h) cmp = 1; else if (a < b - h) cmp = 0;
        if (cmp === 1 && this.gCmp[g] === 0) st ^= 1;
        this.gCmp[g] = cmp;
      }
      this.gState[g] = st;
      this.gS[g] += (st - this.gS[g]) * kGate;
      src[S_L1 + g] = 2 * this.gS[g] - 1;
    }

    // ---- the matrix: every eye may turn every knob ----
    const bias = A[H_BIAS], coup = A[H_COUP];
    const M = this.M, mT = this.mT, md = this.md;
    for (let j = 0; j < NDST; j++) mT[j] = 0;
    for (let i = 0; i < NSRC; i++) {
      const s = src[i] + bias;
      const o = i * NDST;
      for (let j = 0; j < NDST; j++) {
        const w = M[o + j];
        if (w !== 0) mT[j] += w * s;
      }
    }
    const kD = coef(0.3 * sEra, crHz);
    for (let j = 0; j < NDST; j++) md[j] += (clamp(mT[j] * coup, -2.5, 2.5) - md[j]) * kD;
    // Anything that changes pitch moves at the glide's pace, so the web drifts
    // rather than swoops: generator pitch, tape speed, reel speed and shift.
    const glideS = this.glide * sEra;
    const kG = coef(glideS, crHz);
    const mdG = this.mdG;
    for (let i = 0; i < 4; i++) mdG[D_P1 + i] += (md[D_P1 + i] - mdG[D_P1 + i]) * kG;
    mdG[D_TAPE] += (md[D_TAPE] - mdG[D_TAPE]) * kG;
    mdG[D_SHFT] += (md[D_SHFT] - mdG[D_SHFT]) * kG;
    mdG[D_RSPD] += (md[D_RSPD] - mdG[D_RSPD]) * kG;
    // sweeps of the bank's tilt and carving are heard like pitch, so they glide too
    const kS = coef(glideS * 0.5, crHz);
    mdG[D_TILT] += (md[D_TILT] - mdG[D_TILT]) * kS;
    mdG[D_ROT] += (md[D_ROT] - mdG[D_ROT]) * kS;

    // ---- warmth: the helm's lean, what the eyes push, what the metabolism
    // has learned. It retunes and recolours the whole web, so it moves more
    // slowly than anything else. ----
    if (this.running) this.temperate(sEra);
    this.warmT = clamp(A[H_WARM] + this.tOff * this.temper + md[D_WARM] * 0.6, 0, 1);
    this.warmA += (this.warmT - this.warmA) * coef(glideS * 1.5, crHz);
    const wm = this.warmA;
    // The generators settle into their harmonic series early (fully by 0.6),
    // since in-between tunings beat; the rest follows warmth in proportion.
    const wq = Math.min(1, wm / 0.6), tune = wq * wq * (3 - 2 * wq);
    this.tune = tune;

    // ---- map to the web ----
    const drift = A[H_DRIFT] / 12;
    const P = this.P;
    // Held ratios: the generators drift together and keep their tuning relative
    // to each other, so the beats between them hold steady instead of
    // speeding up and slowing down. Only the unheld part moves one alone.
    const common = (mdG[D_P1] + mdG[D_P1 + 1] + mdG[D_P1 + 2] + mdG[D_P1 + 3]) * 0.25;
    // In tune, the ratios are held exactly: only the common motion remains.
    for (let i = 0; i < 4; i++) {
      const own = common + (mdG[D_P1 + i] - common) * (1 - this.hold) * (1 - tune);
      const f = clamp(this.gBase[i] * Math.pow(2, drift + own * 0.4 + tune * this.hCorr[i]), 4, 9000);
      this.ramp(R_GF + i, f);
      // warm generators fold less: rounder waveforms
      this.ramp(R_FOLD + i, clamp(this.gFold[i] + md[D_FOLD] * 0.7, 0, 2.6) * (1 - 0.45 * wm));
    }
    // ---- wave shaper: each generator's sine through a polynomial curve.
    // A unit sine through the n-th Chebyshev polynomial is exactly its n-th
    // harmonic, so the shaper adds partials 2-6 and nothing else; any that
    // would pass 15 kHz fade out, so it can never alias. Odd leaves out the
    // even harmonics, for a hollower tone. ----
    {
      const sAmt = clamp(this.shapeBase + md[D_SHAPE] * 0.5, 0, 1) * (1 - 0.3 * wm);
      const odd = this.shapeOdd, sw = this.sw, swD = this.swD;
      this.shapeOn = sAmt > 0.002 || sw[1] + sw[2] + sw[7] + sw[8] + sw[13] + sw[14] + sw[19] + sw[20] > 1e-4;
      for (let i = 0; i < 4; i++) {
        const f = P[R_GF + i] + this.dP[R_GF + i] * CR;
        let e2 = 1;
        const tgt = this.swT;
        tgt[0] = 1;
        for (let n = 2; n <= 6; n++) {
          const band = clamp((15000 - n * f) / 3000, 0, 1);
          tgt[n - 1] = sAmt > 0 ? Math.pow(sAmt, 0.75 * (n - 1)) / n * (n & 1 ? 1 : 1 - odd) * band : 0;
          e2 += tgt[n - 1] * tgt[n - 1];
        }
        const nrm = 1 / Math.sqrt(e2);
        for (let n = 0; n < 6; n++) swD[i * 6 + n] = (tgt[n] * nrm - sw[i * 6 + n]) / CR;
      }
    }
    for (let i = 0; i < 4; i++) {
      const j = (i + 3) & 3;
      const lr = Math.log(P[R_GF + i] / P[R_GF + j]);
      let best = 1e9, bp = 1, bq = 1;
      for (let n = 0; n < RATIOS.length; n++) {
        const d = Math.abs(lr - RATIOS[n][2]);
        if (d < best) { best = d; bp = RATIOS[n][0]; bq = RATIOS[n][1]; }
      }
      this.rp[i] = bp; this.rq[i] = bq;
    }
    // In tune, coupling holds the series' own ratios, a little more firmly.
    this.ramp(R_SYNC, clamp(this.syncBase + md[D_SYNC] * 0.5, 0, 1.2) * 0.05 * (1 + 2 * tune) + 0.004 * tune);
    this.ramp(R_PM, this.pmBase * (1 - 0.6 * wm));
    // Warmth lightens multiplication, which is what makes a cascade clang;
    // the last stage (multiplied by the loop) only a little, since it is
    // also what keeps the passes from beating against each other.
    for (let i = 0; i < 4; i++) this.ramp(R_D + i, clamp(this.multBase[i] + md[D_MULT] * 0.5, 0, 1) * (1 - (i === 3 ? 0.3 : 0.55) * wm));
    this.ramp(R_DRIVE, this.drive);

    const tT = clamp(this.timeBase * Math.pow(2, mdG[D_TAPE] * 0.6), 0.01, 9);
    // The tape transport has inertia: delay time moves like a damped mass,
    // and the heads never change speed abruptly or by more than 45%.
    {
      // a long glide makes a heavy transport: slower to move, never bending far
      const dtc = 1 / crHz, w = clamp(5 / glideS, 0.1, 4.5);
      const vmax = clamp(0.25 / glideS, 0.003, 0.45);
      const acc = (tT - this.tapeS) * w * w - 2 * w * this.tapeV;
      this.tapeV = clamp(this.tapeV + acc * dtc, -vmax, vmax);
      this.tapeS = clamp(this.tapeS + this.tapeV * dtc, 0.01, 9);
      const rT = clamp(this.timeBase * this.spread, 0.01, 9) / this.timeBase;
      this.spreadS += (rT - this.spreadS) * coef(1.2, crHz);
    }
    this.ramp(R_DL, this.tapeS * this.sr);
    this.ramp(R_DR, clamp(this.tapeS * this.spreadS, 0.01, 9) * this.sr);

    const sh = this.shiftBase + mdG[D_SHFT] * (0.15 + Math.abs(this.shiftBase) * 0.25);
    this.ramp(R_SHL, sh);
    this.ramp(R_SHR, sh * (1 - 2 * this.shiftSpread));
    this.ramp(R_SMR, clamp(this.smearBase + md[D_SMR] * 0.4 + 0.2 * wm * (1 - this.smearBase), 0, 0.95));
    // Exciter: up to the band's own level in new harmonics; warmth lets it go.
    this.ramp(R_EXC, clamp(this.excBase + md[D_EXCT] * 0.6, 0, 1) * (1 - 0.7 * wm));
    // Harmonizer: how much of the loop passes through its two voices. The
    // intervals and window glide, so changing them never jumps.
    this.ramp(R_HMIX, clamp(this.harmBase + md[D_HARM] * 0.4, 0, 0.9));
    this.hWinS += (this.harmWin * this.sr - this.hWinS) * coef(0.4, crHz);
    this.ramp(R_HWIN, this.hWinS);
    {
      const kI = coef(0.4, crHz);
      this.lrA += (Math.log(this.harmRA) - this.lrA) * kI;
      this.lrB += (Math.log(this.harmRB) - this.lrB) * kI;
      this.harm.limit(Math.exp(Math.max(this.lrA, this.lrB)));
    }
    // Outside the loop, so it never compounds: a gentle shelf above 1.8 kHz
    // and a darker room.
    this.shelfG = 0.6 * wm;
    if (Math.abs(wm - this.warmSpace) > 0.004) {
      this.warmSpace = wm;
      this.space.k = coef(1 / (TWO_PI * 5200 * (1 - 0.35 * wm)), this.sr);
    }

    // ---- the homeostat ----
    // Inhale: while the loop is below its setpoint the gain opens slowly.
    // Exhale: once it pushes past the ceiling, the gain is pulled back until
    // the loop has fallen by the breath depth, then it opens again. The
    // period is not set anywhere; it depends on how the web responds.
    const sp = spEff;
    const dt = 1 / crHz;
    if (loopDb < sp) this.dipped = true;
    if (this.inhale) {
      const below = sp - loopDb;
      this.trim += (0.3 + 1.6 * this.breath) * (1 + 0.12 * clamp(below, 0, 30)) / era * dt;
      if (loopDb > sp + 3) {
        this.inhale = false;
        this.trimPeak = this.trim;
        // a new breath only once the loop has come back down since the last one
        if (this.dipped) { this.dipped = false; this.breaths++; this.onBreath(this.tSec); }
      }
    } else {
      this.trim -= (0.6 + 2.6 * this.breath) * (1 + 0.2 * clamp(loopDb - sp, 0, 24)) / era * dt;
      if (loopDb < sp - depthEff || this.trim < this.trimPeak - depthEff * 1.6) this.inhale = true;
    }
    this.trim = clamp(this.trim, -48, 18);
    if (this.running) this.metabolise(dt, sEra, loopDb, sp);
    const over = loopDb - (sp + 9);
    const tgF = over > 0 ? Math.pow(10, -over * 0.075) : 1;
    this.fastG += (tgF - this.fastG) * (tgF < this.fastG ? coef(0.004, crHz) : coef(1.2 * sEra, crHz));
    // Feedback 1.0 means unity gain at the loudest band: the carved bank is
    // already normalised, and this makes up the dry signal the smear and the
    // crossfeed take away on every pass.
    const smr = this.P[R_SMR];
    // (capped: a long smear gives back much of what it takes)
    const comp = Math.min(2, 1 / ((1 - 0.75 * smr) * (1 - this.cross)));
    const fb = clamp(this.fbBase * comp * Math.pow(10, this.trim / 20) * this.fastG * Math.pow(2, md[D_FDBK] * 0.6), 0, this.fbCap);
    this.ramp(R_FB, fb);
    const ln = this.envLoop * 1.57;
    this.loopNorm = ln > 0.03 ? Math.min(6, 1 / ln) : 6;

    this.ramp(R_IN, A[H_INFLOW]);
    this.ramp(R_VOL, A[H_VOL]);
    this.ramp(R_R2L, this.reelToLoop);
    this.ramp(R_R2M, this.reelToMult);
    this.ramp(R_LIVE, this.liveIn);
    this.ramp(R_OLOOP, this.outLoop);
    this.ramp(R_ODRY, this.outDry);
    this.ramp(R_OREEL, this.outReels);
    this.ramp(R_OSPACE, this.outSpace);

    // ---- reels and their record heads ----
    const rspd = Math.pow(2, mdG[D_RSPD] * 0.4);
    const alcT = clamp(0.1 / Math.max(this.recEnv, 1e-4), 0, 2.5);
    this.recAlc += (alcT - this.recAlc) * coef(0.25, crHz);
    for (let r = 0; r < 4; r++) {
      const pending = this.reelWant[r];
      this.reelFadeT[r] = pending ? 0 : 1;
      if (pending && this.reelFade[r] < 0.002) {
        this.reelWant[r] = null;
        pending();
        this.selectReel(r);
        this.reelFade[r] = 0;
      }
      const live = this.reelLen[r] > 0;
      this.ramp(R_RLV + r, live ? clamp(this.reelBase[r] + md[D_R1 + r] * 0.6, 0, 1.25) : 0);
      this.ramp(R_RSP + r, clamp(this.reelSpeed[r] * rspd, -6, 6));
      const rs = this.reelRecSrc[r];
      const want = this.reelMode[r] === 1 ? (rs === 4 ? 1 : rs >= 0 ? this.gState[rs] : 0) : 0;
      this.reelRecS[r] += (want - this.reelRecS[r]) * coef(0.03, crHz);
      this.ramp(R_REC + r, this.reelRecS[r]);
    }

    // ---- cascade level: average 0.28 before Drive, lifting a quiet cascade
    // by no more than 6 dB so a web keeps its own balance ----
    this.cascT = clamp(0.28 / Math.max(this.cascEnv, 1e-4), 0.25, 2);
    // ---- loop peak compressor target ----
    this.cmpT = this.cmpEnv > 0.5 ? Math.pow(0.5 / this.cmpEnv, 2 / 3) : 1;
    // ---- output leveler: 2:1 around the last minute's level, at most 6 dB ----
    if (this.lvlRef > 0) {
      this.lvlRef += (this.lvlEnv - this.lvlRef) * coef(60, crHz);
      this.lvlT = clamp(Math.sqrt(this.lvlRef / Math.max(this.lvlEnv, 1e-6)), 0.5, 2);
    } else if (this.lvlEnv > 1e-4) {
      this.lvlRef = this.lvlEnv;
    }

    // ---- guard ----
    if (!isFinite(this.lastL) || !isFinite(this.lastR) || !isFinite(this.smear.outL) || !isFinite(this.trim)) {
      this.resetState();
    }
  }

  /* ---------- audio rate ---------- */

  /* How far a reel head at pos is from the nearest seam, in crossfade
     windows (1 = clear). Seams: the record head of a self loop or the
     splice of held tape; for a self loop also the place recording last
     stopped, until the record head has been all the way round, and the wrap
     point after the loop length changes. */
  seamU(r, pos, len) {
    const win = this.reelWin[r];
    const self = this.reelMode[r] === 1;
    let d = pos - (self ? this.reelW[r] : 0);
    if (d < 0) d += len;
    if (d > len * 0.5) d = len - d;
    let u = d / win;
    if (self) {
      if (this.reelWrap[r] > 0) {
        const d0 = pos > len * 0.5 ? len - pos : pos;
        if (d0 / win < u) u = d0 / win;
      }
      const st = this.reelStop[r];
      if (st >= 0) {
        let d1 = pos - st;
        if (d1 < 0) d1 += len;
        if (d1 > len * 0.5) d1 = len - d1;
        if (d1 / win < u) u = d1 / win;
      }
    }
    return u < 1 ? u : 1;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    if (!this.running) {
      oL.fill(0); if (oR !== oL) oR.fill(0);
      return true;
    }
    const inp = inputs[0];
    const micL = inp && inp.length ? inp[0] : null;
    const micR = inp && inp.length > 1 ? inp[1] : micL;

    const P = this.P, dP = this.dP;
    const ph = this.ph, gy = this.gy, gy2 = this.gy2, rp = this.rp, rq = this.rq;
    const rpH = this.rpH, rqH = this.rqH, sw = this.sw, swD = this.swD;
    const exL = this.exL, exR = this.exR, harm = this.harm;
    const b0a = this.b0, a1a = this.a1, a2a = this.a2;
    const zl1 = this.zl1, zl2 = this.zl2, zr1 = this.zr1, zr2 = this.zr2;
    const benv = this.benv, bg = this.bg, dbg = this.dbg;
    const tapeL = this.tapeL, tapeR = this.tapeR, tapeLen = this.tapeLen;
    const invSr = this.invSr, sr = this.sr;
    const era = this.helmA[H_ERA];
    const bA = coef(0.003, sr), bR = coef(0.12 * Math.sqrt(era), sr);
    const eA = coef(0.004, sr), eR = coef(0.15 * Math.pow(era, 0.3), sr);
    const kFade = this.fadeTarget > this.fade ? coef(1.2, sr) : coef(0.35, sr);
    const toneK = this.toneK, cross = this.cross;
    const hL = this.hL, hR = this.hR, smear = this.smear, space = this.space;
    const reelBuf = this.reelBuf, reelLen = this.reelLen, reelPos = this.reelPos, reelW = this.reelW;
    const kReel = coef(0.012, sr);
    const kGovA = coef(0.3, sr), kGovR = coef(20, sr), kGovDown = coef(3, sr), kGovUp = coef(30, sr);
    const kCmpA = coef(0.002, sr), kCmpR = coef(0.25, sr), kCmpGA = coef(0.006, sr), kCmpGR = coef(0.35, sr);
    const kLevA = coef(0.3, sr), kLevR = coef(1.5, sr), kLevG = coef(0.5, sr);
    const kAgcA = coef(0.05, sr), kAgcR = coef(0.5, sr), kAgcG = coef(0.3, sr)
    const kRecA = coef(0.01, sr), kRecR = coef(0.6, sr);

    for (let off = 0; off < n; off += CR) {
      this.control();
      const end = off + CR < n ? off + CR : n;
      const tune = this.tune, shelfG = this.shelfG, shelfK = this.shelfK;
      const shapeOn = this.shapeOn;
      const rA = Math.exp(this.lrA), rB = Math.exp(this.lrB);
      for (let s = off; s < end; s++) {
        for (let i = 0; i < NRAMP; i++) P[i] += dP[i];

        // --- reels: playback ---
        let reelL = 0, reelR = 0;
        for (let r = 0; r < 4; r++) {
          const len = reelLen[r];
          if (len < 64) continue;
          const b = reelBuf[r];
          let pos = reelPos[r] + P[R_RSP + r];
          if (pos >= len) pos -= len; else if (pos < 0) pos += len;
          reelPos[r] = pos;
          const i = pos | 0, f = pos - i, i1 = i + 1 >= len ? 0 : i + 1;
          let v = b[i] + (b[i1] - b[i]) * f;
          // Near a seam (the record head, or a splice) a second head half a
          // loop away takes over, so nothing ever jumps.
          // A seam can vanish at once (a newer stop replaces an older one, or
          // recording finally wears a splice away); let go of it only at the
          // pace a head would move away from it.
          const step = 1 / this.reelWin[r];
          let u = this.seamU(r, pos, len);
          if (u > this.reelU[r] + step) u = this.reelU[r] + step;
          this.reelU[r] = u;
          if (u < 1) {
            let pb = pos + len * 0.5;
            if (pb >= len) pb -= len;
            const j = pb | 0, g = pb - j, j1 = j + 1 >= len ? 0 : j + 1;
            const vb = b[j] + (b[j1] - b[j]) * g;
            // Two seams can lie half a loop apart (a reversed reel meets its
            // wrap just as the record head passes the far side). If the second
            // head is near one too, lean back on the first. The blend moves no
            // faster than the heads do, so it never jumps itself.
            let ub = this.seamU(r, pb, len);
            if (ub > this.reelUb[r] + step) ub = this.reelUb[r] + step;
            this.reelUb[r] = ub;
            const a = (1 - (1 - u) * ub) * 1.5707963267948966;
            v = v * Math.sin(a) + vb * Math.cos(a);
          } else this.reelUb[r] = 1;
          const rf = (this.reelFade[r] += (this.reelFadeT[r] - this.reelFade[r]) * kReel);
          v *= P[R_RLV + r] * rf;
          reelL += v * REEL_PAN_L[r];
          reelR += v * REEL_PAN_R[r];
        }
        const reelMono = (reelL + reelR) * 0.5;
        const ra = (reelL < 0 ? -reelL : reelL) + (reelR < 0 ? -reelR : reelR);
        this.envReel += (ra * 0.5 - this.envReel) * (ra * 0.5 > this.envReel ? eA : eR);

        // --- generators: coupled, self-modulating, phase-pushed by the loop ---
        const loopMono = (this.lastL + this.lastR) * 0.5;
        const pmv = P[R_PM] * loopMono * Math.PI;
        const K = P[R_SYNC];
        let y0 = 0, y1 = 0, y2 = 0, y3 = 0;
        for (let i = 0; i < 4; i++) {
          const j = (i + 3) & 3;
          const f = P[R_GF + i];
          let c = K * f * Math.sin(TWO_PI * (rp[i] * ph[j] - rq[i] * ph[i])) / rq[i];
          if (tune > 0.001) c += tune * (K * f * Math.sin(TWO_PI * (rpH[i] * ph[j] - rqH[i] * ph[i])) / rqH[i] - c);
          let phi = ph[i] + (f + c) * invSr;
          phi -= Math.floor(phi);
          ph[i] = phi;
          let y = Math.sin(TWO_PI * phi + P[R_FOLD + i] * (gy[i] + gy2[i]) * 0.5 + pmv);
          gy2[i] = gy[i]; gy[i] = y;
          if (shapeOn) {
            // T(n+1) = 2y T(n) - T(n-1): the n-th harmonic of a unit sine
            const o = i * 6, y2 = 2 * y;
            for (let k = 0; k < 6; k++) sw[o + k] += swD[o + k];
            let t0 = 1, t1 = y, acc = sw[o] * y;
            for (let k = 1; k < 6; k++) { const t2 = y2 * t1 - t0; acc += sw[o + k] * t2; t0 = t1; t1 = t2; }
            y = acc;
          }
          if (i === 0) y0 = y; else if (i === 1) y1 = y; else if (i === 2) y2 = y; else y3 = y;
        }

        // --- multiplier cascade: products, not sums ---
        let x = y0 + P[R_R2M] * reelMono * 1.5;
        x += P[R_D] * (x * y1 * MK - x);
        x += P[R_D + 1] * (x * y2 * MK - x);
        x += P[R_D + 2] * (x * y3 * MK - x);
        const m4 = sc(loopMono * this.loopNorm);
        x += P[R_D + 3] * (x * m4 * MK - x);
        // The cascade's level rides an automatic gain control (tenths of a
        // second), so wandering products feed the loop at a steady level;
        // Drive then sets how hard that level presses into the soft knee.
        {
          const ax = x < 0 ? -x : x;
          this.cascEnv += (ax - this.cascEnv) * (ax > this.cascEnv ? kAgcA : kAgcR);
          // for the offline click report: the sharpest bend in the generators' own product
          const d2 = x - 2 * this.xm1 + this.xm2;
          this.xm2 = this.xm1; this.xm1 = x;
          const ad = (d2 < 0 ? -d2 : d2) / (this.cascEnv + 1e-6);
          if (ad > this.xEdge) this.xEdge = ad;
          this.cascG += (this.cascT - this.cascG) * kAgcG;
        }
        const casc = knee(x * this.cascG * P[R_DRIVE], 1, 2);
        const ca = casc < 0 ? -casc : casc;
        this.envCasc += (ca - this.envCasc) * (ca > this.envCasc ? eA : eR);

        // --- perturbation ---
        let pert = 0;
        if (this.pertOn) {
          const t = this.pertT * invSr;
          const fq = 48 + 1400 * Math.exp(-t / 0.035);
          this.pertPh += fq * invSr;
          pert = this.pertA * Math.exp(-t / 0.14) * Math.sin(TWO_PI * this.pertPh);
          if (++this.pertT > sr * 1.2) this.pertOn = false;
        }

        // --- the loop: inflow plus multiplied feedback ---
        let live = 0;
        if (micL) live = (micL[s] + micR[s]) * 0.5 * P[R_LIVE];
        const fbG = P[R_FB];
        const retL = this.lastL * (1 - cross) + this.lastR * cross;
        const retR = this.lastR * (1 - cross) + this.lastL * cross;
        const inj = casc * P[R_IN] + pert + live;
        let inL = inj + reelL * P[R_R2L] + fbG * retL;
        let inR = inj + reelR * P[R_R2L] + fbG * retR;
        inL = inL > 4 ? 4 : inL < -4 ? -4 : inL;
        inR = inR > 4 ? 4 : inR < -4 ? -4 : inR;
        this.tlp += (inL - this.tlp) * toneK;
        this.trp += (inR - this.trp) * toneK;
        const tw = this.tw;
        {
          const ai = this.alcI, an = this.alcN;
          this.alcL[ai] = this.tlp; this.alcR[ai] = this.trp;
          const pl = this.tlp < 0 ? -this.tlp : this.tlp, pr = this.trp < 0 ? -this.trp : this.trp;
          const pk = pl > pr ? pl : pr;
          if (pk >= this.alcEnv) { this.alcEnv = pk; this.alcHold = an; }
          else if (this.alcHold > 0) this.alcHold--;
          else this.alcEnv *= 0.99996;
          const ag = this.alcEnv > 1.5 ? 1.5 / this.alcEnv : 1;
          this.alcG1 += (ag - this.alcG1) * (ag < this.alcG1 ? this.alcAtk : 0.0002);
          this.alcG += (this.alcG1 - this.alcG) * (this.alcG1 < this.alcG ? this.alcAtk : 0.0002);
          const j = (ai + 64 - an) & 63;
          tapeL[tw] = knee(this.alcL[j] * this.alcG, 1.7, 3);
          tapeR[tw] = knee(this.alcR[j] * this.alcG, 1.7, 3);
          this.alcI = (ai + 1) & 63;
        }
        const rl = readH(tapeL, tapeLen, tw - P[R_DL]);
        const rr = readH(tapeR, tapeLen, tw - P[R_DR]);
        this.tw = tw + 1 >= tapeLen ? 0 : tw + 1;

        // --- third-octave bank, each band with eyes and an inverted VCA ---
        let sL = 0, sR = 0;
        for (let k = 0; k < NB; k++) {
          const b0 = b0a[k], a1 = a1a[k], a2 = a2a[k];
          const yl = b0 * rl + zl1[k];
          zl1[k] = zl2[k] - a1 * yl;
          zl2[k] = -b0 * rl - a2 * yl;
          const yr = b0 * rr + zr1[k];
          zr1[k] = zr2[k] - a1 * yr;
          zr2[k] = -b0 * rr - a2 * yr;
          const e = (yl < 0 ? -yl : yl) + (yr < 0 ? -yr : yr);
          const ev = benv[k];
          benv[k] = ev + (e > ev ? bA : bR) * (e - ev);
          const g = (bg[k] += dbg[k]);
          sL += yl * g;
          sR += yr * g;
        }

        // --- single-sideband shifter: re-pitched on every pass ---
        hL.run(sL); hR.run(sR);
        let p1 = this.shPL + P[R_SHL] * invSr; p1 -= Math.floor(p1); this.shPL = p1;
        let p2 = this.shPR + P[R_SHR] * invSr; p2 -= Math.floor(p2); this.shPR = p2;
        const fL = hL.i * Math.cos(TWO_PI * p1) - hL.q * Math.sin(TWO_PI * p1);
        const fR = hR.i * Math.cos(TWO_PI * p2) - hR.q * Math.sin(TWO_PI * p2);

        // --- exciter: fresh harmonics from the band above its corner ---
        let gL = fL, gR = fR;
        const exA = P[R_EXC];
        if (exA > 1e-5) { gL += exA * exL.run(fL); gR += exA * exR.run(fR); }
        // --- harmonizer: two voices at just intervals, mixed into the pass ---
        const hm = P[R_HMIX];
        if (hm > 1e-5) {
          harm.run(gL, gR, rA, rB, P[R_HWIN]);
          gL += hm * (harm.outL - gL);
          gR += hm * (harm.outR - gR);
        } else harm.write(gL, gR);

        // --- smear ---
        smear.run(gL, gR);
        const w = P[R_SMR];
        // Loop peak compressor: 3:1 above 0.5, riding the gain over
        // milliseconds rather than bending the waveform.
        const vL = gL + w * (smear.outL - gL), vR = gR + w * (smear.outR - gR);
        {
          const al = vL < 0 ? -vL : vL, ar = vR < 0 ? -vR : vR;
          const a = al > ar ? al : ar;
          this.cmpEnv += (a - this.cmpEnv) * (a > this.cmpEnv ? kCmpA : kCmpR);
          this.cmpG += (this.cmpT - this.cmpG) * (this.cmpT < this.cmpG ? kCmpGA : kCmpGR);
        }
        const xL = knee(vL * this.cmpG, 1, 2);
        const xR = knee(vR * this.cmpG, 1, 2);
        this.lastL = xL; this.lastR = xR;
        const la = ((xL < 0 ? -xL : xL) + (xR < 0 ? -xR : xR)) * 0.5;
        this.envLoop += (la - this.envLoop) * (la > this.envLoop ? eA : eR);

        // --- output ---
        let mL = (xL * P[R_OLOOP] + casc * P[R_ODRY] + reelL * P[R_OREEL]) * MAKEUP;
        let mR = (xR * P[R_OLOOP] + casc * P[R_ODRY] + reelR * P[R_OREEL]) * MAKEUP;
        this.mixMono = (mL + mR) * 0.5;
        space.run(mL, mR);
        mL += space.outL * P[R_OSPACE];
        mR += space.outR * P[R_OSPACE];
        // warmth: a first-order shelf softening everything above 1.8 kHz
        this.shelfL += (mL - this.shelfL) * shelfK;
        this.shelfR += (mR - this.shelfR) * shelfK;
        mL -= shelfG * (mL - this.shelfL);
        mR -= shelfG * (mR - this.shelfR);
        // 2nd-order high-pass at 32 Hz: difference tones below this are felt, not heard
        const hb0 = this.hpB0, hb1 = this.hpB1, ha1 = this.hpA1, ha2 = this.hpA2;
        const dl = hb0 * mL + this.hpL1;
        this.hpL1 = hb1 * mL - ha1 * dl + this.hpL2;
        this.hpL2 = hb0 * mL - ha2 * dl;
        const dr = hb0 * mR + this.hpR1;
        this.hpR1 = hb1 * mR - ha1 * dr + this.hpR2;
        this.hpR2 = hb0 * mR - ha2 * dr;
        // Output leveler: evens out swells within a minute, leaves slow evolution.
        {
          const m = ((dl < 0 ? -dl : dl) + (dr < 0 ? -dr : dr)) * 0.5;
          this.lvlEnv += (m - this.lvlEnv) * (m > this.lvlEnv ? kLevA : kLevR);
          this.lvlG += (this.lvlT - this.lvlG) * kLevG;
        }
        // Output governor: if peaks run persistently hot it lowers the mix over
        // seconds and lets it back up over half a minute, so the limiter only
        // ever has transients to catch.
        {
          const ql = (dl < 0 ? -dl : dl) * this.lvlG, qr = (dr < 0 ? -dr : dr) * this.lvlG;
          const q = ql > qr ? ql : qr;
          this.govEnv += q > this.govEnv ? (q - this.govEnv) * kGovA : -this.govEnv * kGovR;
          const gt = this.govEnv > GOV ? GOV / this.govEnv : 1;
          this.govG += (gt - this.govG) * (gt < this.govG ? kGovDown : kGovUp);
        }
        const gl = dl * this.lvlG * this.govG, gr = dr * this.lvlG * this.govG;
        // Look-ahead limiter: the signal is delayed by 1.5 ms while the gain
        // eases down ahead of each peak, so limiting never snaps.
        const al = this.tpL.run(gl), ar = this.tpR.run(gr);
        const pk = al > ar ? al : ar;
        if (pk >= this.limEnv) { this.limEnv = pk; this.limHold = this.limN; }
        else if (this.limHold > 0) this.limHold--;
        else this.limEnv *= 0.99998;
        const lt = this.limEnv > CEIL ? CEIL / this.limEnv : 1;
        // two smoothing stages: every gain change starts and ends with zero slope
        this.limG1 += (lt - this.limG1) * (lt < this.limG1 ? this.limAtk : 0.0001);
        this.limG += (this.limG1 - this.limG) * (this.limG1 < this.limG ? this.limAtk : 0.0001);
        const li = this.limI;
        const ol = this.limBufL[li], or = this.limBufR[li];
        this.limBufL[li] = gl; this.limBufR[li] = gr;
        this.limI = li + 1 === this.limN ? 0 : li + 1;
        // AUDIT-FINAL
        // linear below the ceiling; the knee only catches the limiter's residual overshoot
        const yl = knee(ol * this.limG, CEIL, 0.98);
        const yr = knee(or * this.limG, CEIL, 0.98);
        const oa = ((yl < 0 ? -yl : yl) + (yr < 0 ? -yr : yr)) * 0.5;
        this.envOut += (oa - this.envOut) * (oa > this.envOut ? eA : eR);
        this.fade += (this.fadeTarget - this.fade) * kFade;
        const gOut = P[R_VOL] * this.fade;
        oL[s] = yl * gOut;
        oR[s] = yr * gOut;
        // The recorder takes the finished signal before the listening level.
        if (this.recOn) {
          const rb = this.recBuf;
          rb[this.recW++] = yl * this.fade;
          rb[this.recW++] = yr * this.fade;
          if (this.recW >= rb.length) this.flushRec();
        }

        // --- reels: record heads take the output back into the system ---
        // The record heads take the high-passed mix through an automatic
        // level control, and the overdub gain stays below unity, so the
        // reel -> output -> reel path can never run away.
        const mono = (dl + dr) * 0.5;
        const am = mono < 0 ? -mono : mono;
        this.recEnv += (am - this.recEnv) * (am > this.recEnv ? kRecA : kRecR);
        const recIn = mono * this.recAlc;
        for (let r = 0; r < 4; r++) {
          const rl2 = P[R_REC + r];
          const live = rl2 >= 0.002 && reelBuf[r] === this.selfBuf[r];
          if (!live) {
            // recording stopped: remember where, so playback can cross it smoothly
            if (this.reelWas[r]) { this.reelWas[r] = 0; this.reelStop[r] = reelW[r]; this.reelSince[r] = 0; }
            continue;
          }
          this.reelWas[r] = 1;
          // each pass keeps 1 - 0.6 * level of what was there; count down to -20 dB
          if (this.reelWrap[r] > 0) this.reelWrap[r] += Math.log(1 - 0.6 * rl2);
          const len = reelLen[r];
          if (this.reelStop[r] >= 0 && ++this.reelSince[r] > len) this.reelStop[r] = -1;
          const b = reelBuf[r];
          const i = reelW[r];
          b[i] = sc(b[i] * (1 - 0.6 * rl2) + recIn * 0.5 * rl2);
          reelW[r] = i + 1 >= len ? 0 : i + 1;
        }
        if (this.capture >= 0 && micL) {
          this.captureBuf[this.captureW++] = (micL[s] + micR[s]) * 0.5;
          if (--this.captureLeft <= 0) this.finishCapture();
        }
      }
    }

    if (this.fadeTarget === 0 && this.haltPending && this.fade < 1e-4) {
      this.haltPending = false;
      this.running = false;
      this.port.postMessage({ type: 'halted' });
    }
    this.elapsed += n;
    if (++this.blocks >= FRAME_BLOCKS) {
      this.blocks = 0;
      this.postFrame();
    }
    return true;
  }

  /* Hand a chunk of the recording to the page and start a fresh one. */
  flushRec() {
    if (!this.recBuf || this.recW === 0) return;
    const data = this.recW === this.recBuf.length ? this.recBuf : this.recBuf.slice(0, this.recW);
    this.port.postMessage({ type: 'rec', data }, [data.buffer]);
    this.recBuf = this.recOn ? new Float32Array(REC_FRAMES * 2) : null;
    this.recW = 0;
  }

  finishCapture() {
    const r = this.capture;
    const buf = this.captureBuf.subarray(0, this.captureW);
    const fadeN = Math.min(buf.length >> 2, Math.round(this.sr * 0.01));
    for (let i = 0; i < fadeN; i++) {
      const g = i / fadeN;
      buf[i] *= g;
      buf[buf.length - 1 - i] *= g;
    }
    this.capture = -1;
    this.captureBuf = null;
    this.requestReel(r, () => {
      this.heldBuf[r] = buf;
      this.heldLen[r] = buf.length;
      this.heldGen[r]++;
      this.reelPos[r] = 0;
    });
    this.port.postMessage({ type: 'captured', reel: r, seconds: buf.length / this.sr });
  }

  postFrame() {
    const bands = new Float32Array(NB), clampA = new Float32Array(NB), eff = new Float32Array(NB);
    for (let k = 0; k < NB; k++) {
      bands[k] = norm(dbOf(this.post[k]));
      clampA[k] = this.cg[k];
      eff[k] = this.eff[k];
    }
    const reels = new Float32Array(16);
    for (let r = 0; r < 4; r++) {
      const len = this.reelLen[r];
      reels[r * 4] = len > 0 ? this.reelPos[r] / len : 0;
      reels[r * 4 + 1] = this.P[R_RLV + r];
      reels[r * 4 + 2] = this.P[R_REC + r];
      reels[r * 4 + 3] = len / this.sr;
    }
    const gens = new Float32Array(4);
    for (let i = 0; i < 4; i++) gens[i] = this.P[R_GF + i];
    this.port.postMessage({
      type: 'frame',
      el: this.elapsed / this.sr,
      running: this.running,
      bands, clamp: clampA, eff,
      src: Float32Array.from(this.src),
      dst: Float32Array.from(this.md),
      gens,
      gates: Float32Array.from(this.gS),
      gateState: Uint8Array.from(this.gState),
      reels,
      helm: Float32Array.from(this.helmA),
      stat: new Float32Array([
        this.loopDb, dbOf(this.envOut), this.trim, this.fastG, this.P[R_FB],
        this.tapeS, this.P[R_SHL], this.clampAmt, this.src[S_FLUX], this.centHz,
        dbOf(this.envCasc), this.P[R_SMR], this.capture >= 0 ? this.capture : -1,
        this.inhale ? 1 : 0, this.breaths,
        this.mOsp, this.mOdepth, this.mOceil, this.mP, this.mReg, this.mShifts, this.spEff,
        this.mStalled ? 1 : 0, this.mI, this.warmA, this.tOff * this.temper, this.tP,
      ]),
    });
  }
}

registerProcessor('kybernetes', KybernetesProcessor);
