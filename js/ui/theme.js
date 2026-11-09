/* Canvas drawing reads its colours and faces from the page's CSS tokens. */

export const theme = {};
const KEYS = ['void', 'panel', 'panel-2', 'rule', 'rule-hi', 'ink', 'dim', 'faint', 'signal', 'signal-hi', 'signal-deep', 'regulate', 'regulate-deep', 'alarm', 'warm'];

export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of KEYS) theme[k] = cs.getPropertyValue(`--${k}`).trim() || '#888';
  theme.fData = cs.getPropertyValue('--f-data').trim() || 'monospace';
  theme.fDisplay = cs.getPropertyValue('--f-display').trim() || 'sans-serif';
  theme.fUi = cs.getPropertyValue('--f-ui').trim() || 'sans-serif';
  return theme;
}

const cache = new Map();
export function rgba(color, a) {
  let rgb = cache.get(color);
  if (!rgb) {
    const c = color.replace('#', '');
    const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
    rgb = [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
    cache.set(color, rgb);
  }
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
export function rgbOf(color) {
  rgba(color, 1);
  return cache.get(color);
}

/* Size a canvas to its CSS box at device resolution. Returns true if it changed. */
export function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

export function dprOf() { return Math.min(2, window.devicePixelRatio || 1); }
