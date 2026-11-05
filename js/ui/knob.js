/*
 * Rotary control. Drag vertically (Shift for fine), use the arrow keys, or
 * scroll while focused. Double-click returns to the default. A second,
 * inner arc can show where the system actually is while it glides toward
 * the value you set.
 */

const SWEEP = 135;
const NS = 'http://www.w3.org/2000/svg';

export function curveFor(def) {
  const { min, max } = def;
  switch (def.curve) {
    case 'log':
      return {
        toNorm: (v) => Math.log(Math.max(min, Math.min(max, v)) / min) / Math.log(max / min),
        fromNorm: (n) => min * Math.pow(max / min, n),
      };
    case 'slog': {
      // signed logarithmic: fine resolution around zero, wide reach at the ends
      const l0 = def.lin0 || 0.1;
      const k = Math.log(max / l0 + 1);
      return {
        toNorm: (v) => {
          const u = Math.sign(v) * Math.log(Math.abs(v) / l0 + 1) / k;
          return (u + 1) / 2;
        },
        fromNorm: (n) => {
          const u = n * 2 - 1;
          return Math.sign(u) * l0 * (Math.exp(Math.abs(u) * k) - 1);
        },
      };
    }
    default:
      return {
        toNorm: (v) => (v - min) / (max - min),
        fromNorm: (n) => min + n * (max - min),
      };
  }
}

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
}
function arcPath(r, a0, a1) {
  if (Math.abs(a1 - a0) < 0.01) return '';
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function el(tag, cls) {
  const e = document.createElementNS(NS, tag);
  if (cls) e.setAttribute('class', cls);
  return e;
}

let uid = 0;

export class Knob {
  constructor(def) {
    this.def = def;
    this.curve = curveFor(def);
    this.value = def.value ?? def.default ?? def.min;
    this.actual = null;
    this.bipolar = def.bipolar ?? (def.min < 0 && def.max > 0);

    const root = document.createElement('div');
    root.className = `knob knob--${def.size || 'md'}`;
    root.tabIndex = 0;
    root.setAttribute('role', 'slider');
    root.id = def.id || `knob-${++uid}`;
    root.setAttribute('aria-label', def.aria || def.label);
    if (def.title) root.title = def.title;

    const svg = el('svg', 'knob__svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');
    const ticks = el('g', 'knob__ticks');
    const n = def.ticks ?? 11;
    for (let i = 0; i < n; i++) {
      const a = -SWEEP + (2 * SWEEP * i) / (n - 1);
      const [x0, y0] = polar(47, a);
      const [x1, y1] = polar(i === 0 || i === n - 1 || (this.bipolar && i === (n - 1) / 2) ? 41.5 : 44, a);
      const t = el('line');
      t.setAttribute('x1', x0); t.setAttribute('y1', y0); t.setAttribute('x2', x1); t.setAttribute('y2', y1);
      ticks.appendChild(t);
    }
    this.track = el('path', 'knob__track');
    this.track.setAttribute('d', arcPath(36, -SWEEP, SWEEP));
    this.arc = el('path', 'knob__arc');
    this.act = el('path', 'knob__actual');
    const cap = el('circle', 'knob__cap');
    cap.setAttribute('cx', 50); cap.setAttribute('cy', 50); cap.setAttribute('r', 26);
    this.ptr = el('line', 'knob__ptr');
    svg.append(ticks, this.track, this.act, this.arc, cap, this.ptr);

    const label = document.createElement('span');
    label.className = 'knob__label';
    label.textContent = def.label;
    this.out = document.createElement('span');
    this.out.className = 'knob__value';
    root.append(svg, label, this.out);
    this.el = root;

    this.bind();
    this.render();
  }

  norm() { return Math.max(0, Math.min(1, this.curve.toNorm(this.value))); }

  set(v, { silent = false } = {}) {
    const d = this.def;
    let x = Math.max(d.min, Math.min(d.max, v));
    if (d.step) x = Math.round(x / d.step) * d.step;
    if (x === this.value) return;
    this.value = x;
    this.render();
    if (!silent && d.onInput) d.onInput(x);
  }

  setActual(v) {
    this.actual = v;
    this.renderActual();
  }

  format(v) {
    return this.def.format ? this.def.format(v) : String(+v.toFixed(2));
  }

  render() {
    const n = this.norm();
    const a = -SWEEP + 2 * SWEEP * n;
    const from = this.bipolar ? 0 : -SWEEP;
    this.arc.setAttribute('d', arcPath(36, Math.min(from, a), Math.max(from, a)));
    const [x0, y0] = polar(10, a);
    const [x1, y1] = polar(24, a);
    this.ptr.setAttribute('x1', x0); this.ptr.setAttribute('y1', y0);
    this.ptr.setAttribute('x2', x1); this.ptr.setAttribute('y2', y1);
    const text = this.format(this.value);
    this.out.textContent = text;
    this.el.setAttribute('aria-valuemin', this.def.min);
    this.el.setAttribute('aria-valuemax', this.def.max);
    this.el.setAttribute('aria-valuenow', +this.value.toFixed(4));
    this.el.setAttribute('aria-valuetext', text);
    if (this.actual !== null) this.renderActual();
  }

  renderActual() {
    if (this.actual === null) return;
    const n = Math.max(0, Math.min(1, this.curve.toNorm(this.actual)));
    const a = -SWEEP + 2 * SWEEP * n;
    const from = this.bipolar ? 0 : -SWEEP;
    this.act.setAttribute('d', arcPath(30.5, Math.min(from, a), Math.max(from, a)));
    const t = this.norm();
    this.el.classList.toggle('is-gliding', Math.abs(t - n) > 0.004);
  }

  nudge(dn) {
    const n = Math.max(0, Math.min(1, this.norm() + dn));
    this.set(this.curve.fromNorm(n));
  }

  commit() {
    if (this.def.onCommit) this.def.onCommit(this.value);
  }

  bind() {
    const root = this.el;
    let start = null;
    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      root.focus({ preventScroll: true });
      root.setPointerCapture(e.pointerId);
      start = { y: e.clientY, x: e.clientX, n: this.norm(), moved: false };
      root.classList.add('is-active');
      e.preventDefault();
    });
    root.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dy = start.y - e.clientY;
      const dx = e.clientX - start.x;
      if (Math.abs(dy) + Math.abs(dx) > 2) start.moved = true;
      const scale = e.shiftKey ? 900 : 220;
      const n = Math.max(0, Math.min(1, start.n + (dy + dx * 0.35) / scale));
      this.set(this.curve.fromNorm(n));
    });
    const end = (e) => {
      if (!start) return;
      if (root.hasPointerCapture?.(e.pointerId)) root.releasePointerCapture(e.pointerId);
      const moved = start.moved;
      start = null;
      root.classList.remove('is-active');
      if (moved) this.commit();
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('dblclick', () => {
      if (this.def.default === undefined) return;
      this.set(this.def.default);
      this.commit();
    });
    root.addEventListener('wheel', (e) => {
      if (document.activeElement !== root) return;
      e.preventDefault();
      this.nudge((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.002 : 0.01));
      clearTimeout(this.wheelT);
      this.wheelT = setTimeout(() => this.commit(), 500);
    }, { passive: false });
    root.addEventListener('keydown', (e) => {
      const fine = e.shiftKey ? 0.2 : 1;
      let used = true;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': this.nudge(0.01 * fine); break;
        case 'ArrowDown': case 'ArrowLeft': this.nudge(-0.01 * fine); break;
        case 'PageUp': this.nudge(0.1); break;
        case 'PageDown': this.nudge(-0.1); break;
        case 'Home': this.set(this.def.min); break;
        case 'End': this.set(this.def.max); break;
        default: used = false;
      }
      if (used) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(this.keyT);
        this.keyT = setTimeout(() => this.commit(), 500);
      }
    });
  }
}

/* Formatting helpers shared by the controls. */
export const fmt = {
  hz: (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : Math.abs(v) >= 100 ? `${v.toFixed(0)} Hz` : Math.abs(v) >= 10 ? `${v.toFixed(1)} Hz` : `${v.toFixed(2)} Hz`),
  shift: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v) >= 10 ? Math.abs(v).toFixed(1) : Math.abs(v).toFixed(2)} Hz`,
  sec: (v) => (v >= 1 ? `${v.toFixed(2)} s` : `${(v * 1000).toFixed(0)} ms`),
  db: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`,
  pct: (v) => `${Math.round(v * 100)}%`,
  x: (v) => `×${v.toFixed(2)}`,
  ratio: (v) => `×${v.toFixed(3)}`,
  signed: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`,
  volt: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} V`,
  st: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} st`,
  speed: (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}×`,
  q: (v) => `Q ${v.toFixed(1)}`,
  num: (v) => v.toFixed(2),
};
