/*
 * The observatory: the closed web drawn as an orrery. Generators and the
 * multiplier chain spiral into the loop (tape, bank, shift, smear), which
 * circles the homeostat. In the homeostat's eye the output is drawn as a
 * phase portrait (mid on the vertical, side on the horizontal). Modulation
 * arcs from the matrix glow with the voltage they carry.
 */
import { theme, rgba, fit, dprOf } from './theme.js';
import { SOURCES, DESTS } from '../state.js';

const GROUPS = {
  gens: ['g1', 'g2', 'g3', 'g4'],
  mults: ['m1', 'm2', 'm3', 'm4'],
  reels: ['r1', 'r2', 'r3', 'r4'],
};

const AUDIO = [
  ['g1', 'm1'], ['g2', 'm1'], ['m1', 'm2'], ['g3', 'm2'], ['m2', 'm3'], ['g4', 'm3'], ['m3', 'm4'], ['m4', 'tape'],
  ['tape', 'bank', 'arc'], ['bank', 'shift', 'arc'], ['shift', 'smear', 'arc'], ['smear', 'tape', 'arc'],
  ['smear', 'm4', 'fb'], ['smear', 'out'], ['m4', 'out', 'dry'],
  ['r1', 'tape', 'reel'], ['r2', 'tape', 'reel'], ['r3', 'tape', 'reel'], ['r4', 'tape', 'reel'],
];

const LOOP_ANGLE = { tape: Math.PI, bank: -Math.PI / 2, shift: 0, smear: Math.PI / 2 };

function fmtHz(v) {
  const a = Math.abs(v);
  return a >= 1000 ? `${(v / 1000).toFixed(2)}k` : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

export class Observatory {
  constructor(back, front, { getArch }) {
    this.back = back;
    this.front = front;
    this.bctx = back.getContext('2d');
    this.fctx = front.getContext('2d');
    this.getArch = getArch;
    this.pos = {};
    this.phase = AUDIO.map((_, i) => (i * 0.137) % 1);
    this.last = performance.now();
    this.reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  layout() {
    fit(this.back);
    fit(this.front);
    const w = this.front.clientWidth, h = this.front.clientHeight;
    this.w = w; this.h = h;
    const p = {};
    if (w / h >= 0.95) {
      const cx = w * 0.6, cy = h * 0.52, R = Math.min(h * 0.33, w * 0.2);
      this.C = [cx, cy]; this.R = R;
      for (const [k, a] of Object.entries(LOOP_ANGLE)) p[k] = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
      p.out = [Math.min(w - 30, cx + R + w * 0.14), cy + R * 0.7];
      for (let i = 0; i < 4; i++) p[`g${i + 1}`] = [w * 0.07, h * (0.2 + 0.2 * i)];
      const gx = w * 0.07, tx = p.tape[0];
      const step = (tx - gx) / 4.6;
      p.m1 = [gx + step * 1.1, h * 0.29];
      p.m2 = [gx + step * 1.9, h * 0.44];
      p.m3 = [gx + step * 2.7, h * 0.6];
      p.m4 = [gx + step * 3.6, h * 0.72];
      for (let i = 0; i < 4; i++) p[`l${i + 1}`] = [w * (0.2 + 0.06 * i), h * 0.085];
      for (let i = 0; i < 4; i++) p[`r${i + 1}`] = [w * (0.2 + 0.065 * i), h * 0.9];
    } else {
      const cx = w * 0.5, cy = h * 0.56, R = Math.min(w * 0.25, h * 0.2);
      this.C = [cx, cy]; this.R = R;
      for (const [k, a] of Object.entries(LOOP_ANGLE)) p[k] = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
      p.out = [Math.min(w - 26, cx + R + w * 0.16), cy + R * 0.95];
      for (let i = 0; i < 4; i++) p[`g${i + 1}`] = [w * (0.14 + 0.24 * i), h * 0.075];
      p.m1 = [w * 0.26, h * 0.2];
      p.m2 = [w * 0.5, h * 0.22];
      p.m3 = [w * 0.74, h * 0.2];
      p.m4 = [Math.max(24, p.tape[0] - w * 0.1), cy - R * 0.9];
      for (let i = 0; i < 4; i++) p[`l${i + 1}`] = [w * (0.07 + 0.1 * i), h * 0.89];
      for (let i = 0; i < 4; i++) p[`r${i + 1}`] = [w * (0.6 + 0.1 * i), h * 0.89];
    }
    p.homeo = this.C;
    p.reels = GROUPS.reels.map((k) => p[k]).reduce((a, b) => [a[0] + b[0] / 4, a[1] + b[1] / 4], [0, 0]);
    this.pos = p;
    this.edges = AUDIO.map(([a, b, kind]) => this.edgeGeom(a, b, kind));
    this.bctx.setTransform(1, 0, 0, 1, 0, 0);
    this.bctx.clearRect(0, 0, this.back.width, this.back.height);
  }

  edgeGeom(a, b, kind) {
    const p = this.pos;
    if (kind === 'arc') {
      let a0 = LOOP_ANGLE[a], a1 = LOOP_ANGLE[b];
      while (a1 <= a0) a1 += Math.PI * 2;
      return { kind, a, b, a0, a1 };
    }
    if (kind === 'fb') {
      const c = [this.C[0] - this.R * 0.9, this.C[1] + this.R * 1.25];
      return { kind, a, b, p0: p[a], c, p1: p[b] };
    }
    return { kind: kind || 'line', a, b, p0: p[a], p1: p[b] };
  }

  at(e, t) {
    if (e.kind === 'arc') {
      const ang = e.a0 + (e.a1 - e.a0) * t;
      return [this.C[0] + this.R * Math.cos(ang), this.C[1] + this.R * Math.sin(ang)];
    }
    if (e.kind === 'fb') {
      const u = 1 - t;
      return [u * u * e.p0[0] + 2 * u * t * e.c[0] + t * t * e.p1[0], u * u * e.p0[1] + 2 * u * t * e.c[1] + t * t * e.p1[1]];
    }
    return [e.p0[0] + (e.p1[0] - e.p0[0]) * t, e.p0[1] + (e.p1[1] - e.p0[1]) * t];
  }

  activity(frame) {
    const act = {};
    const lv = (db, lo, span) => Math.max(0, Math.min(1, (db - lo) / span));
    if (!frame) {
      for (const k of Object.keys(this.pos)) act[k] = 0.12;
      return act;
    }
    const s = frame.stat;
    const loop = lv(s[0], -50, 40), casc = lv(s[10], -40, 34), out = lv(s[1], -50, 44);
    for (let i = 0; i < 4; i++) act[`g${i + 1}`] = 0.55;
    act.m1 = act.m2 = act.m3 = 0.25 + casc * 0.6;
    act.m4 = casc;
    act.tape = act.bank = act.shift = act.smear = loop;
    act.out = out;
    act.homeo = s[7];
    for (let i = 0; i < 4; i++) {
      act[`l${i + 1}`] = frame.gates[i];
      act[`r${i + 1}`] = Math.min(1, frame.reels[i * 4 + 1] * (frame.reels[i * 4 + 3] > 0 ? 1 : 0));
    }
    return act;
  }

  draw(frame, scope) {
    if (fit(this.front) | fit(this.back)) this.layout();
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const dpr = dprOf();
    const act = this.activity(frame);
    this.drawPhase(scope, dpr);

    const ctx = this.fctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const [cx, cy] = this.C, R = this.R;
    const p = this.pos;

    // orbit of the loop
    ctx.strokeStyle = theme['rule-hi'];
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = theme.rule;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2, r0 = R + 3, r1 = R + (i % 6 === 0 ? 8 : 5);
      ctx.beginPath();
      ctx.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
      ctx.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
      ctx.stroke();
    }

    // metabolism: pressure builds around the orbit as the breathing settles into a routine
    if (frame && frame.stat.length > 21 && frame.stat[18] > 0.01) {
      ctx.strokeStyle = rgba(theme.signal, 0.4);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 13, -Math.PI / 2, -Math.PI / 2 + Math.min(1, frame.stat[18]) * Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // homeostat: the eye ring breathes with the regulation
    const hold = frame ? frame.stat[7] : 0;
    const inhale = frame ? frame.stat[13] > 0.5 : true;
    const eyeR = R * 0.62;
    ctx.strokeStyle = rgba(theme.regulate, 0.25 + hold * 0.75);
    ctx.lineWidth = 1 + hold * 3;
    ctx.beginPath(); ctx.arc(cx, cy, eyeR + 3, 0, Math.PI * 2); ctx.stroke();
    if (frame) {
      const trim = frame.stat[2];
      const tr = Math.max(-1, Math.min(1, trim / 18));
      ctx.strokeStyle = rgba(trim >= 0 ? theme.signal : theme.regulate, 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, eyeR + 9, -Math.PI / 2, -Math.PI / 2 + tr * Math.PI, tr < 0);
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    // modulation arcs from the matrix
    const a = this.getArch();
    const bias = frame ? frame.helm[1] : a.helm.bias;
    const coup = frame ? frame.helm[4] : a.helm.coupling;
    for (const [i, j, amt] of a.matrix) {
      const sNode = SOURCES[i].node, dNode = DESTS[j].node;
      const from = p[sNode] || p.homeo;
      const targets = GROUPS[dNode] || [dNode];
      const flow = frame ? Math.min(1, Math.abs((frame.src[i] + bias) * amt * coup)) : Math.abs(amt) * 0.4;
      const col = amt > 0 ? theme.signal : theme.regulate;
      ctx.strokeStyle = rgba(col, (0.05 + flow * 0.5) / Math.sqrt(targets.length));
      ctx.lineWidth = 0.75 + flow * 1.25;
      for (const t of targets) {
        const to = p[t];
        if (!to) continue;
        const mx = (from[0] + to[0]) / 2, my = (from[1] + to[1]) / 2;
        const qx = mx + (cx - mx) * 0.45, qy = my + (cy - my) * 0.45;
        ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.quadraticCurveTo(qx, qy, to[0], to[1]); ctx.stroke();
      }
    }
    ctx.lineWidth = 1;

    // audio paths with travelling particles
    for (let e = 0; e < this.edges.length; e++) {
      const g = this.edges[e];
      const level = act[g.a] ?? 0.2;
      const dim = g.kind === 'dry' ? 0.35 : g.kind === 'reel' ? 0.5 : 1;
      ctx.strokeStyle = rgba(theme.dim, (0.18 + level * 0.25) * dim);
      ctx.setLineDash(g.kind === 'fb' || g.kind === 'dry' || g.kind === 'reel' ? [3, 4] : []);
      ctx.beginPath();
      if (g.kind === 'arc') {
        // the arc itself is the orbit; draw a brighter overlay
        ctx.strokeStyle = rgba(theme.signal, 0.12 + level * 0.35);
        ctx.arc(cx, cy, R, g.a0, g.a1);
      } else if (g.kind === 'fb') {
        ctx.moveTo(g.p0[0], g.p0[1]); ctx.quadraticCurveTo(g.c[0], g.c[1], g.p1[0], g.p1[1]);
      } else {
        ctx.moveTo(g.p0[0], g.p0[1]); ctx.lineTo(g.p1[0], g.p1[1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (!this.reduce) this.phase[e] = (this.phase[e] + dt * (0.08 + level * 0.5)) % 1;
      if (level < 0.05) continue;
      ctx.fillStyle = rgba(theme['signal-hi'], 0.35 + level * 0.6);
      for (let k = 0; k < 3; k++) {
        const [x, y] = this.at(g, (this.phase[e] + k / 3) % 1);
        ctx.beginPath(); ctx.arc(x, y, 1.1 + level * 1.1, 0, Math.PI * 2); ctx.fill();
      }
    }

    // nodes
    ctx.font = `500 9px ${theme.fData}`;
    ctx.textBaseline = 'middle';
    const node = (id, label, r, opts = {}) => {
      const [x, y] = p[id];
      const v = act[id] ?? 0.2;
      ctx.fillStyle = theme.void;
      ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = theme.panel;
      ctx.strokeStyle = rgba(opts.color || theme.signal, 0.35 + v * 0.65);
      ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (opts.lamp !== undefined) {
        ctx.fillStyle = rgba(opts.color || theme.signal, opts.lamp);
        ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = rgba(opts.color || theme.signal, 0.15 + v * 0.7);
        ctx.beginPath(); ctx.arc(x, y, r * 0.38, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = theme.dim;
      ctx.textAlign = opts.align || 'left';
      const lx = opts.align === 'right' ? x - r - 6 : opts.align === 'center' ? x : x + r + 6;
      const ly = opts.align === 'center' ? y + r + 10 : y;
      ctx.fillText(label, lx, ly);
      if (opts.sub) {
        ctx.fillStyle = theme.faint;
        ctx.fillText(opts.sub, lx, ly + 11);
      }
    };

    const tall = this.w / this.h < 0.95;
    for (let i = 0; i < 4; i++) {
      node(`g${i + 1}`, `G${i + 1}`, 7, { sub: frame ? `${fmtHz(frame.gens[i])} Hz` : `${fmtHz(a.gens[i].f)} Hz`, align: tall ? 'center' : 'left' });
    }
    node('m1', '×1', 6, { align: tall ? 'center' : 'left' });
    node('m2', '×2', 6, { align: tall ? 'center' : 'left' });
    node('m3', '×3', 6, { align: tall ? 'center' : 'left' });
    node('m4', '×4', 7, { sub: 'by loop', align: 'center' });
    node('tape', 'TAPE', 9, { align: 'right', sub: frame ? `${frame.stat[5].toFixed(2)} s` : `${a.loop.time.toFixed(2)} s` });
    node('bank', 'BANK', 9, { align: 'left', sub: '1/3 oct' });
    node('shift', 'SHIFT', 9, { align: 'left', sub: frame ? `${frame.stat[6] >= 0 ? '+' : '−'}${Math.abs(frame.stat[6]).toFixed(2)} Hz` : '' });
    node('smear', 'SMEAR', 9, { align: 'left', sub: frame ? `loop ${frame.stat[0].toFixed(0)} dB` : '' });
    node('out', 'OUT', 8, { align: 'center', sub: frame ? `${frame.stat[1].toFixed(0)} dB` : '' });
    for (let i = 0; i < 4; i++) {
      const open = frame ? frame.gateState[i] : 0;
      node(`l${i + 1}`, `L${i + 1}`, 5, { lamp: frame ? 0.15 + frame.gates[i] * 0.85 : 0.1, align: 'center', sub: open ? 'open' : 'shut' });
    }
    for (let i = 0; i < 4; i++) {
      const id = `r${i + 1}`;
      const mode = a.reels[i].mode;
      node(id, `R${i + 1}`, 7, { align: 'center', sub: mode === 'off' ? 'off' : mode === 'self' ? 'self' : 'tape' });
      if (frame && frame.reels[i * 4 + 3] > 0) {
        const [x, y] = p[id];
        const ang = frame.reels[i * 4] * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = theme.ink;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 6 * Math.cos(ang), y + 6 * Math.sin(ang)); ctx.stroke();
        if (frame.reels[i * 4 + 2] > 0.05) {
          ctx.fillStyle = theme.regulate;
          ctx.beginPath(); ctx.arc(x + 7, y - 7, 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // spectrum crown over the bank
    if (frame) {
      const [bx, by] = p.bank;
      const bw = Math.min(64, R * 0.8), bh = 16;
      const x0 = bx - bw / 2, y0 = by - 14 - bh;
      for (let k = 0; k < 24; k++) {
        const v = frame.bands[k];
        const held = 1 - frame.clamp[k];
        ctx.fillStyle = rgba(held > 0.3 ? theme.regulate : theme.signal, 0.35 + v * 0.65);
        const hh = Math.max(1, v * bh);
        ctx.fillRect(x0 + (k * bw) / 24, y0 + bh - hh, bw / 24 - 0.6, hh);
      }
    }

    // homeostat legend
    ctx.textAlign = 'center';
    ctx.fillStyle = rgba(theme.regulate, 0.85);
    ctx.font = `500 9px ${theme.fData}`;
    const label = frame
      ? `${inhale ? 'INHALE' : 'EXHALE'} · trim ${frame.stat[2] >= 0 ? '+' : '−'}${Math.abs(frame.stat[2]).toFixed(1)} dB`
      : 'HOMEOSTAT';
    if (tall) {
      ctx.textAlign = 'left';
      ctx.fillText(label, 10, 14);
    } else {
      ctx.fillText(label, cx, cy - eyeR - 19);
    }
    ctx.textAlign = 'center';
    if (!frame) {
      ctx.fillStyle = theme.faint;
      ctx.fillText('engage to see the output', cx, cy);
    }
  }

  drawPhase(scope, dpr) {
    const ctx = this.bctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${this.reduce ? 1 : 0.14})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'lighter';
    if (!scope) { ctx.globalCompositeOperation = 'source-over'; return; }
    const [L, Rr] = scope;
    const [cx, cy] = this.C;
    const rEye = this.R * 0.62;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, rEye, 0, Math.PI * 2); ctx.clip();
    // scale to the recent peak so the portrait fills the eye without clipping
    let pk = 0.05;
    for (let i = 0; i < L.length; i += 4) pk = Math.max(pk, Math.abs(L[i]) + Math.abs(Rr[i]));
    this.pk = this.pk ? Math.max(pk, this.pk * 0.985) : pk;
    const k = (rEye * 0.95) / (this.pk * 0.7071);
    ctx.strokeStyle = rgba(theme.signal, 0.07);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let i = 0; i < L.length; i++) {
      const l = L[i], r = Rr[i];
      const x = cx + (l - r) * 0.7071 * k, y = cy - (l + r) * 0.7071 * k;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = rgba(theme['signal-hi'], 0.1);
    for (let i = 0; i < L.length; i += 3) {
      const l = L[i], r = Rr[i];
      ctx.fillRect(cx + (l - r) * 0.7071 * k - 0.6, cy - (l + r) * 0.7071 * k - 0.6, 1.2, 1.2);
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }
}
