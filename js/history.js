/*
 * Undo and redo for the architecture and helm. A step is recorded when an
 * edit is finished (a knob released, a pin placed, a stroke across the bank
 * ended, an architecture loaded), so dragging a knob is one step, not fifty.
 * The output level is left out: it is how loud you listen, not part of the
 * piece.
 */

const LIMIT = 200;

function key(a) {
  return JSON.stringify({ ...a, helm: { ...a.helm, volume: 0 } });
}

export class History extends EventTarget {
  constructor(get, apply) {
    super();
    this.get = get;
    this.apply = apply;
    this.past = [];
    this.future = [];
    this.base = key(get());
  }

  /* Record whatever has changed since the last step, under a label. */
  commit(label) {
    const now = key(this.get());
    if (now === this.base) return false;
    this.past.push({ state: this.base, label });
    if (this.past.length > LIMIT) this.past.shift();
    this.future = [];
    this.base = now;
    this.emit();
    return true;
  }

  /* Forget the history and start from the current state (after a page load). */
  rebase() {
    this.base = key(this.get());
    this.emit();
  }

  undo() {
    this.commit('Edit');
    const step = this.past.pop();
    if (!step) return null;
    this.future.push({ state: this.base, label: step.label });
    this.base = step.state;
    this.restore(step.state);
    this.emit();
    return step.label;
  }

  redo() {
    const step = this.future.pop();
    if (!step) return null;
    this.past.push({ state: this.base, label: step.label });
    this.base = step.state;
    this.restore(step.state);
    this.emit();
    return step.label;
  }

  restore(state) {
    const next = JSON.parse(state);
    next.helm.volume = this.get().helm.volume;
    this.apply(next);
  }

  get canUndo() { return this.past.length > 0 || key(this.get()) !== this.base; }
  get canRedo() { return this.future.length > 0; }
  get undoLabel() { return this.past.length ? this.past[this.past.length - 1].label : key(this.get()) !== this.base ? 'Edit' : ''; }
  get redoLabel() { return this.future.length ? this.future[this.future.length - 1].label : ''; }

  emit() { this.dispatchEvent(new Event('change')); }
}

/* A readable name for an edit to the architecture at `path`. */
export function describe(path, label) {
  const p = path.split('.');
  const n = (i) => Number(p[i]) + 1;
  switch (p[0]) {
    case 'gens': return `G${n(1)} ${label}`;
    case 'mult': return `Multiplier ×${n(1)}`;
    case 'loop': return `Loop ${label}`;
    case 'homeo': return `Homeostasis ${label}`;
    case 'bank': return label ? `Bank ${label}` : 'Bank carving';
    case 'gates': return `Gate L${n(1)} ${label}`;
    case 'reels': return `Reel R${n(1)} ${label}`;
    case 'out': return `Output ${label}`;
    default: return label || path;
  }
}
