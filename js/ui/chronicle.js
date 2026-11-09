/*
 * The chronicle: a long-form spectrogram of the whole run, one strip per
 * second, low bands at the bottom. Epochs are marked above, the steersman's
 * interventions below. Spans of 1, 4 and 14 hours show how small the present
 * is against the time these systems need.
 */
import { theme, rgbOf, rgba, fit, dprOf } from './theme.js';

const NB = 24;
const CAP = 16 * 3600; // snapshots before the store halves its resolution

function fmtClock(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

export class Chronicle {
  constructor(canvas, caption, { onPick } = {}) {
    this.onPick = onPick || (() => {});
    this.hits = [];
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.caption = caption;
    this.span = 'fit';
    this.marks = [];
    this.reset();
    this.lut = null;
    this.dirty = true;
    this.hoverX = -1;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.dirty = true;
    });
    canvas.addEventListener('pointerleave', () => { this.hoverX = -1; this.dirty = true; });
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      const hit = this.hitAt(e.clientX - r.left);
      if (hit) this.onPick(hit.id);
    });
  }

  reset() {
    this.data = new Uint8Array(CAP * NB);
    this.level = new Float32Array(CAP);
    this.hold = new Uint8Array(CAP);
    this.n = 0;
    this.res = 1;          // seconds per snapshot
    this.acc = new Float32Array(NB);
    this.accN = 0;
    this.accHold = 0;
    this.accLevel = 0;
    this.nextT = 0;
    this.elapsed = 0;
    this.marks = [];
    this.dirty = true;
  }

  setSpan(span) { this.span = span; this.dirty = true; }

  mark(t, kind, label, id) {
    this.marks.push({ t, kind, label, id });
    this.dirty = true;
  }

  unmark(id) {
    this.marks = this.marks.filter((m) => m.id !== id);
    this.dirty = true;
  }

  hitAt(x) {
    let best = null;
    for (const h of this.hits) if (Math.abs(h.x - x) < 8 && (!best || Math.abs(h.x - x) < Math.abs(best.x - x))) best = h;
    return best;
  }

  push(frame) {
    this.elapsed = frame.el;
    for (let k = 0; k < NB; k++) this.acc[k] += frame.bands[k];
    this.accHold += frame.stat[7];
    this.accLevel += frame.stat[0];
    this.accN++;
    if (frame.el < this.nextT) return;
    this.nextT = frame.el + this.res;
    if (this.n >= CAP) this.halve();
    const o = this.n * NB;
    for (let k = 0; k < NB; k++) this.data[o + k] = Math.round(Math.min(1, this.acc[k] / this.accN) * 255);
    this.hold[this.n] = Math.round(Math.min(1, this.accHold / this.accN) * 255);
    this.level[this.n] = this.accLevel / this.accN;
    this.n++;
    this.acc.fill(0); this.accN = 0; this.accHold = 0; this.accLevel = 0;
    this.dirty = true;
  }

  halve() {
    const half = this.n >> 1;
    for (let i = 0; i < half; i++) {
      for (let k = 0; k < NB; k++) this.data[i * NB + k] = (this.data[2 * i * NB + k] + this.data[(2 * i + 1) * NB + k]) >> 1;
      this.hold[i] = (this.hold[2 * i] + this.hold[2 * i + 1]) >> 1;
      this.level[i] = (this.level[2 * i] + this.level[2 * i + 1]) / 2;
    }
    this.n = half;
    this.res *= 2;
  }

  buildLut() {
    const v = rgbOf(theme.void), d = rgbOf(theme['signal-deep']), s = rgbOf(theme.signal), h = rgbOf(theme['signal-hi']);
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let a, b, f;
      if (x < 0.45) { a = v; b = d; f = x / 0.45; } else if (x < 0.8) { a = d; b = s; f = (x - 0.45) / 0.35; } else { a = s; b = h; f = (x - 0.8) / 0.2; }
      f = f * f * (3 - 2 * f);
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c] + (b[c] - a[c]) * f;
    }
    this.lut = lut;
    this.reg = rgbOf(theme.regulate);
  }

  spanSeconds() {
    if (this.span === 'fit') return Math.max(60, this.elapsed * 1.02);
    return { '1h': 3600, '4h': 14400, '14h': 50400 }[this.span];
  }

  draw() {
    const resized = fit(this.cv);
    if (!this.dirty && !resized) return;
    this.dirty = false;
    if (!this.lut) this.buildLut();
    const ctx = this.ctx, dpr = dprOf();
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    const padT = 14, padB = 18, plotH = H - padT - padB;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    const span = this.spanSeconds();
    const start = Math.max(0, this.elapsed - span);
    const pxW = Math.round(W * dpr);
    const pxT = Math.round(padT * dpr), pxH = Math.round(plotH * dpr);
    const img = ctx.createImageData(pxW, pxH);
    const buf = img.data;
    const secPerPx = span / pxW;
    const lut = this.lut, reg = this.reg;
    const col = new Float32Array(NB);
    for (let x = 0; x < pxW; x++) {
      const t0 = start + x * secPerPx, t1 = t0 + secPerPx;
      if (t0 > this.elapsed) break;
      let i0 = Math.floor(t0 / this.res), i1 = Math.max(i0 + 1, Math.ceil(t1 / this.res));
      if (i0 >= this.n) break;
      i1 = Math.min(i1, this.n);
      const cnt = i1 - i0;
      let hold = 0;
      col.fill(0);
      for (let i = i0; i < i1; i++) {
        hold += this.hold[i];
        const o = i * NB;
        for (let k = 0; k < NB; k++) col[k] += this.data[o + k];
      }
      hold /= cnt * 255;
      for (let y = 0; y < pxH; y++) {
        const kf = (1 - (y + 0.5) / pxH) * (NB - 1);
        const k0 = Math.floor(kf), k1 = Math.min(NB - 1, k0 + 1), f = kf - k0;
        const v = Math.round((col[k0] * (1 - f) + col[k1] * f) / cnt);
        const o = (y * pxW + x) * 4;
        // regulation pressure tints the strata warm
        const w = Math.min(0.55, hold * 1.1) * (v / 255);
        buf[o] = lut[v * 3] * (1 - w) + reg[0] * w;
        buf[o + 1] = lut[v * 3 + 1] * (1 - w) + reg[1] * w;
        buf[o + 2] = lut[v * 3 + 2] * (1 - w) + reg[2] * w;
        buf[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, pxT);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // empty future: the part of the canvas this run has not reached yet
    const nowX = ((this.elapsed - start) / span) * W;
    if (nowX < W) {
      ctx.fillStyle = theme['panel-2'];
      ctx.fillRect(nowX, padT, W - nowX, plotH);
      ctx.strokeStyle = theme.rule;
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(W - 0.5, padT); ctx.lineTo(W - 0.5, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.signal;
      ctx.fillRect(Math.max(0, nowX - 1), padT - 3, 1.5, plotH + 6);
    }

    // time axis
    ctx.font = `400 9px ${theme.fData}`;
    ctx.fillStyle = theme.dim;
    ctx.textBaseline = 'alphabetic';
    const steps = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];
    const step = steps.find((s) => (s / span) * W > 70) || 21600;
    for (let t = Math.ceil(start / step) * step; t <= start + span; t += step) {
      const x = ((t - start) / span) * W;
      ctx.fillStyle = theme.rule;
      ctx.fillRect(Math.round(x), padT + plotH, 1, 4);
      ctx.fillStyle = theme.dim;
      ctx.textAlign = x < 20 ? 'left' : x > W - 20 ? 'right' : 'center';
      ctx.fillText(fmtClock(t), x, H - 4);
    }

    // marks
    ctx.font = `500 9px ${theme.fData}`;
    this.hits = [];
    for (const m of this.marks) {
      if (m.t < start || m.t > start + span) continue;
      const x = ((m.t - start) / span) * W;
      if (m.kind === 'snap') {
        // a snapshot: a bright flag you can click to return to it
        ctx.fillStyle = theme['signal-hi'];
        ctx.fillRect(Math.round(x), padT, 1.5, plotH);
        const tw = ctx.measureText(m.label).width + 8;
        const fx = Math.min(W - tw, Math.max(0, x - 1));
        ctx.fillRect(fx, padT, tw, 12);
        ctx.fillStyle = theme.void;
        ctx.textAlign = 'left';
        ctx.fillText(m.label, fx + 4, padT + 9);
        this.hits.push({ x, id: m.id });
      } else if (m.kind === 'metab') {
        // the metabolism shifting: an open ring under the strata
        ctx.strokeStyle = theme.signal;
        ctx.lineWidth = 1.25;
        ctx.beginPath(); ctx.arc(x, padT + plotH + 4.5, 3, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
      } else if (m.kind === 'warm' || m.kind === 'cold') {
        // temper turning: a dot under the strata, warm or cold
        ctx.fillStyle = m.kind === 'warm' ? theme.warm : theme.signal;
        ctx.beginPath(); ctx.arc(x, padT + plotH + 4.5, 2.5, 0, Math.PI * 2); ctx.fill();
      } else if (m.kind === 'epoch') {
        ctx.fillStyle = rgba(theme.ink, 0.5);
        ctx.fillRect(Math.round(x), padT, 1, plotH);
        ctx.fillStyle = theme.ink;
        ctx.textAlign = 'left';
        ctx.fillText(m.label, x + 3, padT - 4);
      } else {
        ctx.fillStyle = theme.regulate;
        ctx.beginPath();
        ctx.moveTo(x, padT + plotH + 1); ctx.lineTo(x - 3.5, padT + plotH + 7); ctx.lineTo(x + 3.5, padT + plotH + 7);
        ctx.closePath(); ctx.fill();
      }
    }

    this.cv.style.cursor = this.hoverX >= 0 && this.hitAt(this.hoverX) ? 'pointer' : 'default';
    if (this.hoverX >= 0 && this.hoverX < nowX) {
      const t = start + (this.hoverX / W) * span;
      ctx.fillStyle = rgba(theme.ink, 0.6);
      ctx.fillRect(Math.round(this.hoverX), padT, 1, plotH);
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
      const label = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      ctx.textAlign = this.hoverX > W - 60 ? 'right' : 'left';
      ctx.fillStyle = theme.ink;
      ctx.fillText(label, this.hoverX + (this.hoverX > W - 60 ? -4 : 4), padT + 11);
    }

    const perPx = span / W;
    const res = perPx >= 60 ? `${(perPx / 60).toFixed(1)} min` : perPx >= 1 ? `${perPx.toFixed(1)} s` : `${Math.round(perPx * 1000)} ms`;
    this.caption.textContent = this.n
      ? `Each pixel column holds ${res} of the run.`
      : `The chronicle fills while the system runs. At this span each pixel column will hold ${res}.`;
  }
}
