/*
 * The pin matrix: rows are the system's eyes, columns are the knobs it can
 * turn. A pin connects one to the other with a signed amount. Pale pins add,
 * amber pins invert. Each pin glows with the voltage flowing through it.
 */
import { theme, rgba, fit, dprOf } from './theme.js';

const SRC_GROUPS = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 3];
const DST_GROUPS = [0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4];
const SRC_GROUP_NAMES = ['Signals', 'Spectrum', 'Dynamics', 'Logic'];
const DST_GROUP_NAMES = ['Generators', '×', 'Loop', 'Reels', 'Colour'];

export class Matrix {
  constructor(canvas, inspector, { sources, dests, getArch, onChange, onCommit }) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.sources = sources;
    this.dests = dests;
    this.getArch = getArch;
    this.onChange = onChange;
    this.onCommit = onCommit || (() => {});
    this.sel = null;
    this.hover = null;
    this.drag = null;
    this.dense = new Float32Array(sources.length * dests.length);
    this.buildInspector(inspector);
    this.bind();
    this.layout();
  }

  /* ---------- model ---------- */

  syncDense() {
    this.dense.fill(0);
    const nd = this.dests.length;
    for (const [i, j, v] of this.getArch().matrix) this.dense[i * nd + j] = v;
  }
  amount(i, j) { return this.dense[i * this.dests.length + j]; }
  commit(i, j) { this.onCommit(`Pin ${this.sources[i].code} → ${this.dests[j].code}`); }
  setAmount(i, j, v) {
    const a = this.getArch();
    v = Math.max(-1, Math.min(1, Math.round(v * 100) / 100));
    const idx = a.matrix.findIndex((p) => p[0] === i && p[1] === j);
    if (Math.abs(v) < 0.02) { if (idx >= 0) a.matrix.splice(idx, 1); }
    else if (idx >= 0) a.matrix[idx][2] = v;
    else a.matrix.push([i, j, v]);
    this.dense[i * this.dests.length + j] = Math.abs(v) < 0.02 ? 0 : v;
    this.onChange();
    this.updateInspector();
  }

  /* ---------- geometry ---------- */

  layout() {
    const W = this.cv.clientWidth || 420;
    this.LW = W < 380 ? 40 : 48;
    this.HH = 54;
    this.gap = W < 380 ? 3 : 5;
    const avail = W - this.LW - 4 - this.gap * 3;
    this.cs = Math.max(13, Math.min(28, Math.floor(avail / this.dests.length)));
    this.colX = this.dests.map((_, j) => this.LW + j * this.cs + DST_GROUPS[j] * this.gap);
    this.rowY = this.sources.map((_, i) => this.HH + i * this.cs + SRC_GROUPS[i] * this.gap);
    const H = this.rowY[this.rowY.length - 1] + this.cs + 4;
    if (Math.abs(this.cv.clientHeight - H) > 0.5) this.cv.style.height = `${H}px`;
    fit(this.cv);
  }

  cellAt(x, y) {
    const cs = this.cs;
    for (let i = 0; i < this.sources.length; i++) {
      if (y < this.rowY[i] || y >= this.rowY[i] + cs) continue;
      for (let j = 0; j < this.dests.length; j++) {
        if (x >= this.colX[j] && x < this.colX[j] + cs) return { i, j };
      }
    }
    return null;
  }

  /* ---------- drawing ---------- */

  draw(frame, helmActual) {
    if (fit(this.cv)) this.layout();
    this.syncDense();
    const ctx = this.ctx, dpr = dprOf(), cs = this.cs;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    const src = frame?.src, dst = frame?.dst;
    const bias = helmActual ? helmActual[1] : this.getArch().helm.bias;
    const coup = helmActual ? helmActual[4] : this.getArch().helm.coupling;
    const ns = this.sources.length, nd = this.dests.length;
    const gridR = this.colX[nd - 1] + cs, gridB = this.rowY[ns - 1] + cs;

    // crosshair for hover / selection
    const focus = this.hover || this.sel;
    if (focus) {
      ctx.fillStyle = rgba(theme.signal, 0.045);
      ctx.fillRect(this.LW - 2, this.rowY[focus.i], gridR - this.LW + 2, cs);
      ctx.fillRect(this.colX[focus.j], this.HH - 4, cs, gridB - this.HH + 4);
    }

    // group separators
    ctx.strokeStyle = theme.rule;
    ctx.lineWidth = 1;
    for (let j = 1; j < nd; j++) {
      if (DST_GROUPS[j] !== DST_GROUPS[j - 1]) {
        const x = this.colX[j] - this.gap / 2;
        ctx.beginPath(); ctx.moveTo(x, this.HH - 30); ctx.lineTo(x, gridB); ctx.stroke();
      }
    }
    for (let i = 1; i < ns; i++) {
      if (SRC_GROUPS[i] !== SRC_GROUPS[i - 1]) {
        const y = this.rowY[i] - this.gap / 2;
        ctx.beginPath(); ctx.moveTo(4, y); ctx.lineTo(gridR, y); ctx.stroke();
      }
    }

    // column headers with live destination meters
    ctx.font = `500 ${cs < 18 ? 8.5 : 9.5}px ${theme.fData}`;
    ctx.textBaseline = 'middle';
    for (let j = 0; j < nd; j++) {
      const x = this.colX[j] + cs / 2;
      const hot = focus && focus.j === j;
      ctx.save();
      ctx.translate(x, this.HH - 14);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = hot ? theme.ink : theme.dim;
      ctx.fillText(this.dests[j].code, 0, 0);
      ctx.restore();
      const v = dst ? Math.max(-1, Math.min(1, dst[j])) : 0;
      const mw = cs - 6, my = this.HH - 7;
      ctx.fillStyle = theme.rule;
      ctx.fillRect(x - mw / 2, my, mw, 2);
      ctx.fillStyle = v >= 0 ? theme.signal : theme.regulate;
      ctx.fillRect(x, my, (v * mw) / 2, 2);
    }

    // row labels with live source meters
    ctx.textAlign = 'right';
    for (let i = 0; i < ns; i++) {
      const y = this.rowY[i] + cs / 2;
      const hot = focus && focus.i === i;
      ctx.fillStyle = hot ? theme.ink : theme.dim;
      ctx.fillText(this.sources[i].code, this.LW - 11, y + 0.5);
      const v = src ? Math.max(-1, Math.min(1, src[i] + bias)) : 0;
      const mh = cs - 6, mx = this.LW - 6;
      ctx.fillStyle = theme.rule;
      ctx.fillRect(mx, y - mh / 2, 2, mh);
      ctx.fillStyle = v >= 0 ? theme.signal : theme.regulate;
      ctx.fillRect(mx, y, 2, (-v * mh) / 2);
    }

    // holes and pins
    for (let i = 0; i < ns; i++) {
      const cy = this.rowY[i] + cs / 2;
      const s = src ? src[i] + bias : 0;
      for (let j = 0; j < nd; j++) {
        const cx = this.colX[j] + cs / 2;
        const a = this.dense[i * nd + j];
        if (a === 0) {
          ctx.fillStyle = theme.rule;
          ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();
          continue;
        }
        const col = a > 0 ? theme.signal : theme.regulate;
        const r = cs * (0.17 + 0.2 * Math.abs(a));
        const flow = Math.min(1, Math.abs(s * a * coup));
        if (flow > 0.02) {
          ctx.fillStyle = rgba(col, 0.1 + flow * 0.3);
          ctx.beginPath(); ctx.arc(cx, cy, r + 1.5 + flow * cs * 0.2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = theme.panel;
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, r * 0.34), 0, Math.PI * 2); ctx.fill();
      }
    }

    // selection box
    if (this.sel) {
      ctx.strokeStyle = document.activeElement === this.cv ? theme.signal : theme.ink;
      ctx.lineWidth = 1;
      ctx.strokeRect(this.colX[this.sel.j] + 0.5, this.rowY[this.sel.i] + 0.5, cs - 1, cs - 1);
    }

    // group legends
    ctx.font = `500 8px ${theme.fData}`;
    ctx.fillStyle = theme.faint;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    let last = -1;
    for (let j = 0; j < nd; j++) {
      if (DST_GROUPS[j] !== last && cs >= 16) {
        last = DST_GROUPS[j];
        const span = DST_GROUPS.filter((g) => g === last).length;
        if (span * cs > 40) ctx.fillText(DST_GROUP_NAMES[last].toUpperCase(), this.colX[j], 8);
      }
    }
    if (this.inspectorDirty) this.updateInspector();
  }

  /* ---------- inspector ---------- */

  buildInspector(root) {
    root.innerHTML = `
      <p class="insp__route" id="matrix-route"></p>
      <p class="insp__desc" id="matrix-desc"></p>
      <div class="insp__controls">
        <label class="sr-only" for="matrix-amount">Pin amount</label>
        <input type="range" id="matrix-amount" min="-1" max="1" step="0.01" value="0">
        <output id="matrix-amount-out" for="matrix-amount">0.00</output>
        <button type="button" class="btn btn--small" id="matrix-invert">Invert</button>
        <button type="button" class="btn btn--small" id="matrix-remove">Remove</button>
      </div>`;
    this.iRoute = root.querySelector('#matrix-route');
    this.iDesc = root.querySelector('#matrix-desc');
    this.iRange = root.querySelector('#matrix-amount');
    this.iOut = root.querySelector('#matrix-amount-out');
    this.iInv = root.querySelector('#matrix-invert');
    this.iRem = root.querySelector('#matrix-remove');
    this.iControls = root.querySelector('.insp__controls');
    this.iRange.addEventListener('input', () => {
      if (!this.sel) return;
      this.setAmount(this.sel.i, this.sel.j, +this.iRange.value);
    });
    this.iRange.addEventListener('change', () => { if (this.sel) this.commit(this.sel.i, this.sel.j); });
    this.iInv.addEventListener('click', () => {
      if (!this.sel) return;
      this.setAmount(this.sel.i, this.sel.j, -this.amount(this.sel.i, this.sel.j));
      this.commit(this.sel.i, this.sel.j);
    });
    this.iRem.addEventListener('click', () => {
      if (!this.sel) return;
      this.setAmount(this.sel.i, this.sel.j, 0);
      this.commit(this.sel.i, this.sel.j);
    });
    this.updateInspector();
  }

  updateInspector() {
    this.inspectorDirty = false;
    const c = this.hover || this.sel;
    if (!c) {
      this.iRoute.textContent = 'Pick a hole';
      this.iDesc.textContent = 'Click a hole to place a pin, drag a pin up or down to set its amount, right-click to invert it. Alt-click places an inverting pin.';
      this.iControls.hidden = true;
      return;
    }
    const s = this.sources[c.i], d = this.dests[c.j];
    const a = this.amount(c.i, c.j);
    this.iRoute.innerHTML = `<b>${s.code}</b><span aria-hidden="true"> → </span><span class="sr-only"> to </span><b>${d.code}</b>${a ? ` <span class="insp__amt ${a < 0 ? 'is-neg' : ''}">${a > 0 ? '+' : '−'}${Math.abs(a).toFixed(2)}</span>` : ''}`;
    this.iDesc.textContent = a
      ? `${s.name} ${a > 0 ? 'pushes' : 'pulls back'} ${d.name.toLowerCase()}.`
      : `${s.name} could turn ${d.name.toLowerCase()}. No pin here yet.`;
    const showSel = this.sel && (!this.hover || (this.hover.i === this.sel.i && this.hover.j === this.sel.j));
    this.iControls.hidden = !showSel || !this.amount(this.sel.i, this.sel.j);
    if (this.sel) {
      const v = this.amount(this.sel.i, this.sel.j);
      this.iRange.value = v;
      this.iOut.value = `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
    }
  }

  /* ---------- input ---------- */

  bind() {
    const cv = this.cv;
    cv.tabIndex = 0;
    cv.setAttribute('role', 'grid');
    cv.setAttribute('aria-label', 'Modulation matrix. Arrow keys move, Enter places or removes a pin, plus and minus adjust, I inverts.');
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (this.drag && e.pointerType !== 'touch') {
        const dy = this.drag.y - y;
        if (Math.abs(dy) > 3) this.drag.moved = true;
        if (this.drag.moved) {
          let v = this.drag.start + dy / 90;
          if (this.drag.start === 0 && this.drag.sign === 0) this.drag.sign = dy > 0 ? 1 : -1;
          if (this.drag.start === 0) v = this.drag.sign * Math.abs(dy) / 90;
          this.setAmount(this.drag.i, this.drag.j, v);
        }
        return;
      }
      const c = this.cellAt(x, y);
      if ((c && (!this.hover || c.i !== this.hover.i || c.j !== this.hover.j)) || (!c && this.hover)) {
        this.hover = c;
        this.updateInspector();
      }
      cv.style.cursor = c ? (this.amount(c.i, c.j) ? 'ns-resize' : 'pointer') : 'default';
    });
    cv.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.updateInspector(); } });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [x, y] = pos(e);
      const c = this.cellAt(x, y);
      if (!c) return;
      this.sel = c;
      if (e.pointerType !== 'touch') {
        cv.setPointerCapture(e.pointerId);
        e.preventDefault();
        cv.focus({ preventScroll: true });
      }
      this.drag = { ...c, y, start: this.amount(c.i, c.j), moved: false, sign: 0, alt: e.altKey || e.shiftKey, touch: e.pointerType === 'touch' };
      this.updateInspector();
    });
    const end = () => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (!d.moved && d.start === 0) this.setAmount(d.i, d.j, d.alt ? -0.5 : 0.5);
      if (d.moved || d.start === 0) this.commit(d.i, d.j);
      this.updateInspector();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', () => { this.drag = null; });
    cv.addEventListener('dblclick', (e) => {
      const [x, y] = pos(e);
      const c = this.cellAt(x, y);
      if (c && this.amount(c.i, c.j)) { this.setAmount(c.i, c.j, 0); this.commit(c.i, c.j); }
    });
    cv.addEventListener('contextmenu', (e) => {
      const [x, y] = pos(e);
      const c = this.cellAt(x, y);
      if (!c) return;
      e.preventDefault();
      this.sel = c;
      const a = this.amount(c.i, c.j);
      this.setAmount(c.i, c.j, a ? -a : -0.5);
      this.commit(c.i, c.j);
    });
    cv.addEventListener('keydown', (e) => {
      const ns = this.sources.length, nd = this.dests.length;
      if (!this.sel) this.sel = { i: 0, j: 0 };
      const s = this.sel;
      let used = true;
      switch (e.key) {
        case 'ArrowUp': s.i = (s.i + ns - 1) % ns; break;
        case 'ArrowDown': s.i = (s.i + 1) % ns; break;
        case 'ArrowLeft': s.j = (s.j + nd - 1) % nd; break;
        case 'ArrowRight': s.j = (s.j + 1) % nd; break;
        case 'Enter': case ' ': this.setAmount(s.i, s.j, this.amount(s.i, s.j) ? 0 : 0.5); break;
        case '+': case '=': this.setAmount(s.i, s.j, this.amount(s.i, s.j) + 0.05); break;
        case '-': case '_': this.setAmount(s.i, s.j, this.amount(s.i, s.j) - 0.05); break;
        case 'i': case 'I': this.setAmount(s.i, s.j, -this.amount(s.i, s.j)); break;
        case 'Delete': case 'Backspace': this.setAmount(s.i, s.j, 0); break;
        default: used = false;
      }
      if (used) {
        e.preventDefault();
        e.stopPropagation();
        this.hover = null;
        if (!e.key.startsWith('Arrow')) this.commit(s.i, s.j);
        this.updateInspector();
      }
    });
    window.addEventListener('resize', () => this.layout());
  }
}

export { SRC_GROUP_NAMES, DST_GROUP_NAMES };
