/*
 * The regulation trace: two minutes of loop level against the setpoint.
 * Amber bands mark exhales, when the homeostat is pulling the gain back.
 */
import { theme, rgba, fit, dprOf } from './theme.js';

const N = 600;          // 0.2 s per sample, two minutes
const STEP = 0.2;

export class Trace {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.reset();
  }

  reset() {
    this.lv = new Float32Array(N).fill(NaN);
    this.sp = new Float32Array(N).fill(NaN);
    this.base = new Float32Array(N).fill(NaN);
    this.ex = new Uint8Array(N);
    this.i = 0;
    this.next = 0;
  }

  push(frame) {
    if (frame.el < this.next) return;
    this.next = frame.el + STEP;
    this.lv[this.i] = frame.stat[0];
    this.sp[this.i] = frame.stat.length > 21 ? frame.stat[21] : frame.helm[3];
    this.base[this.i] = frame.helm[3];
    this.ex[this.i] = frame.stat[13] > 0.5 ? 0 : 1;
    this.i = (this.i + 1) % N;
  }

  draw(setpoint) {
    fit(this.cv);
    const ctx = this.ctx, dpr = dprOf();
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const sp = Number.isNaN(this.sp[(this.i + N - 1) % N]) ? setpoint : this.sp[(this.i + N - 1) % N];
    const lo = sp - 18, hi = sp + 12;
    const y = (db) => H - 2 - ((Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo)) * (H - 4);
    const x = (k) => (k / (N - 1)) * W;
    // exhale bands
    ctx.fillStyle = rgba(theme.regulate, 0.12);
    for (let k = 0; k < N; k++) {
      const idx = (this.i + k) % N;
      if (this.ex[idx] && !Number.isNaN(this.lv[idx])) ctx.fillRect(x(k), 0, W / N + 0.5, H);
    }
    // the setpoint as the metabolism has moved it, over the helm's own setting
    const line = (arr, off, style, dash) => {
      ctx.strokeStyle = style;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let on = false;
      for (let k = 0; k < N; k++) {
        const v = arr[(this.i + k) % N];
        if (Number.isNaN(v)) { on = false; continue; }
        const yy = y(v + off) + 0.5;
        if (!on) { ctx.moveTo(x(k), yy); on = true; } else ctx.lineTo(x(k), yy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (Number.isNaN(this.sp[(this.i + N - 1) % N])) {
      ctx.strokeStyle = rgba(theme.regulate, 0.9);
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, y(sp) + 0.5); ctx.lineTo(W, y(sp) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
    } else {
      line(this.base, 0, rgba(theme.faint, 0.8), [1, 3]);
      line(this.sp, 3, rgba(theme.regulate, 0.3), []);
      line(this.sp, 0, rgba(theme.regulate, 0.9), [3, 3]);
    }
    // loop level
    ctx.strokeStyle = theme.signal;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < N; k++) {
      const v = this.lv[(this.i + k) % N];
      if (Number.isNaN(v)) { started = false; continue; }
      if (!started) { ctx.moveTo(x(k), y(v)); started = true; } else ctx.lineTo(x(k), y(v));
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}
