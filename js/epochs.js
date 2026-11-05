/*
 * Watches the band energies for the system settling into a stable state and
 * leaving it again, so long runs can be read as a sequence of epochs.
 * Pure logic with no DOM, so it can be tested offline.
 */

export function roman(n) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s || '0';
}

const STEP = 0.5;        // seconds between observations
const HI = 0.07;         // distance that counts as departure
const LO = 0.04;         // distance that counts as settled

export class EpochWatch {
  constructor() { this.reset(); }

  reset() {
    this.fast = null;
    this.slow = null;
    this.next = 0;
    this.state = 'forming';
    this.epoch = 0;
    this.above = 0;
    this.below = 0;
    this.d = 0;
    this.win = [];
    this.since = 0;
  }

  /* Feed one analysis frame. Returns an event object when something changes. */
  update(frame) {
    const t = frame.el;
    if (t < this.next) return null;
    this.next = t + STEP;
    const b = frame.bands;
    const era = frame.helm ? frame.helm[5] : 2;
    if (!this.fast) {
      this.fast = Float32Array.from(b);
      this.slow = Float32Array.from(b);
      return null;
    }
    const kf = 1 - Math.exp(-STEP / 3);
    const ks = 1 - Math.exp(-STEP / (40 * Math.sqrt(era)));
    let d = 0;
    for (let k = 0; k < b.length; k++) {
      this.fast[k] += (b[k] - this.fast[k]) * kf;
      this.slow[k] += (b[k] - this.slow[k]) * ks;
      d += Math.abs(this.fast[k] - this.slow[k]);
    }
    d /= b.length;
    this.d = d;
    const s = frame.stat;
    this.win.push({ loop: s[0], clamp: s[7], cent: s[9], bands: Array.from(this.fast) });
    if (this.win.length > 60) this.win.shift();

    if (d > HI) { this.above += STEP; this.below = 0; } else if (d < LO) { this.below += STEP; this.above = 0; } else { this.above = Math.max(0, this.above - STEP); }

    const settleNeed = 8 * Math.sqrt(Math.max(1, era));
    if (this.state === 'forming') {
      if (t > 20 && this.below >= settleNeed) return this.settle(t);
    } else if (this.state === 'settled') {
      if (this.above >= 3 && t - this.since > 30 * Math.sqrt(Math.max(1, era))) {
        this.state = 'turbulent';
        this.since = t;
        return { type: 'depart', t, epoch: this.epoch, text: `Epoch ${roman(this.epoch)} breaks up` };
      }
    } else if (this.state === 'turbulent') {
      if (this.below >= settleNeed) return this.settle(t);
    }
    return null;
  }

  settle(t) {
    this.epoch++;
    this.state = 'settled';
    this.since = t;
    this.below = 0;
    const desc = describe(this.win);
    return { type: 'settle', t, epoch: this.epoch, desc, text: `Epoch ${roman(this.epoch)} settles · ${desc.words.join(', ')} · centre ${desc.centre}` };
  }
}

export function describe(win) {
  if (!win.length) return { words: ['unformed'], centre: '—' };
  const n = win.length;
  let cent = 0, clamp = 0, m = 0, m2 = 0;
  for (const w of win) { cent += w.cent; clamp += w.clamp; m += w.loop; m2 += w.loop * w.loop; }
  cent /= n; clamp /= n; m /= n;
  const sd = Math.sqrt(Math.max(0, m2 / n - m * m));
  const last = win[n - 1].bands;
  const max = Math.max(...last);
  const near = last.filter((v) => v > max - 0.1).length / last.length;
  const colour = cent < 180 ? 'abyssal' : cent < 350 ? 'dark' : cent < 700 ? 'umber' : cent < 1400 ? 'amber' : cent < 2800 ? 'bright' : 'glassy';
  const density = near > 0.62 ? 'dense' : near > 0.42 ? 'layered' : 'sparse';
  const motion = sd < 1 ? 'still' : sd < 2.5 ? 'drifting' : sd < 4.5 ? 'breathing' : 'heaving';
  const hold = clamp > 0.22 ? 'held hard' : clamp > 0.09 ? 'held' : 'open';
  const centre = cent >= 1000 ? `${(cent / 1000).toFixed(2)} kHz` : `${Math.round(cent)} Hz`;
  return { words: [colour, density, motion, hold], centre, cent, motion, density, colour };
}
