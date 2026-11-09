/*
 * The architect's bench: every module of the web as a card of controls,
 * bound to the architecture model. Each binding can re-read the model, so
 * loading a different architecture refreshes everything at once.
 */
import { Knob, fmt } from './knob.js';
import { getPath, setPath, SOURCES, GATE_MODES, REC_SOURCES, defaultArch } from '../state.js';

const DEFAULTS = defaultArch();

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) e.append(kid);
  return e;
}

export function buildArchitecture(root, api) {
  const syncs = [];
  const live = {};
  const { getArch, changed, engine, notify } = api;

  const knob = (path, def) => {
    const k = new Knob({
      size: 'sm',
      default: getPath(DEFAULTS, path),
      ...def,
      id: `k-${path.replace(/\./g, '-')}`,
      value: getPath(getArch(), path),
      onInput: (v) => { setPath(getArch(), path, v); changed(path); },
      onCommit: () => changed(path, true, def.label),
    });
    syncs.push(() => k.set(getPath(getArch(), path), { silent: true }));
    return k.el;
  };

  const select = (id, label, options, get, set) => {
    const s = h('select', { id, class: 'select' });
    for (const o of options) s.append(h('option', { value: String(o.id), text: o.label }));
    s.addEventListener('change', () => { set(s.value); });
    syncs.push(() => { s.value = String(get()); });
    return h('label', { class: 'field', for: id }, h('span', { class: 'field__k', text: label }), s);
  };

  const card = (id, code, title, note, ...body) =>
    h('section', { class: `card card--${id}`, 'aria-labelledby': `card-${id}` },
      h('header', { class: 'card__head' },
        h('span', { class: 'code' }, code),
        h('h3', { id: `card-${id}`, class: 'card__title', text: title })),
      note ? h('p', { class: 'card__note', text: note }) : null,
      ...body);

  /* ---- generators ---- */
  const gens = h('div', { class: 'gens' });
  for (let i = 0; i < 4; i++) {
    live[`gen${i}`] = h('span', { class: 'live', text: '—' });
    gens.append(h('div', { class: 'gen' },
      h('div', { class: 'gen__head' }, h('b', { text: `G${i + 1}` }), live[`gen${i}`]),
      h('div', { class: 'knobs' },
        knob(`gens.${i}.f`, { label: 'Freq', min: 8, max: 5000, curve: 'log', format: fmt.hz, title: `Base frequency of generator ${i + 1}` }),
        knob(`gens.${i}.fold`, { label: 'Fold', min: 0, max: 2.5, format: fmt.num, title: 'Self-modulation: from sine toward a dense, unstable spectrum' }))));
  }
  const genCard = card('gens', 'G', 'Generators', 'Four oscillators, each modulating its own phase. They pull toward small whole-number ratios with their neighbour, and the loop pushes their phase. Glide sets how slowly pitch may move anywhere in the web; Ratios keeps the generators drifting together.',
    gens,
    h('div', { class: 'knobs knobs--row' },
      knob('sync', { label: 'Coupling', min: 0, max: 1, format: fmt.pct, title: 'How hard neighbouring generators pull each other toward a shared ratio' }),
      knob('pm', { label: 'Loop → phase', min: 0, max: 1, format: fmt.pct, title: 'How much the loop output pushes the generators’ phase' }),
      knob('hold', { label: 'Ratios', min: 0, max: 1, format: fmt.pct, title: 'How closely the generators keep their tuning relative to one another as they drift. Held ratios keep the beating between them steady instead of speeding up and slowing down.' }),
      knob('glide', { label: 'Glide', min: 0.05, max: 60, curve: 'log', format: fmt.sec, title: 'How slowly anything that changes pitch may move: generator pitch, tape speed, reel speed, frequency shift and the bank’s sweeps (stretched by Era). Long glides drift; short ones swoop.' })));

  /* ---- multipliers ---- */
  const stages = [['×1', 'G1 · G2'], ['×2', '· G3'], ['×3', '· G4'], ['×4', '· loop']];
  const mults = h('div', { class: 'knobs knobs--row' },
    stages.map(([c, w], i) => h('div', { class: 'stage' },
      knob(`mult.${i}`, { label: c, min: 0, max: 1, format: fmt.pct, title: `Depth of multiplier ${c}: 0 passes the signal through, 100% multiplies fully` }),
      h('span', { class: 'stage__what', text: w }))));
  const multCard = card('mults', '×', 'Multiplier cascade', 'Four ring multipliers in series. Multiplying cancels the carriers and leaves sum and difference sidebands; the last stage multiplies by the loop’s own return.',
    mults,
    h('div', { class: 'knobs knobs--row' },
      knob('drive', { label: 'Drive', min: 0.25, max: 4, curve: 'log', format: fmt.x, title: 'Gain into the cascade’s soft saturation' }),
      knob('reelToMult', { label: 'Reels in', min: 0, max: 1.5, format: fmt.pct, title: 'How much of the reel mix enters the cascade alongside G1' })));

  /* ---- loop ---- */
  const loopCard = card('loop', 'MFb', 'Multiplied feedback loop', 'Tape, bank, shifter and smear sit inside the loop, so every pass is re-carved, re-pitched and smeared before it comes round again.',
    h('div', { class: 'knobs knobs--grid' },
      knob('loop.fb', { label: 'Feedback', min: 0, max: 1.3, format: fmt.x, title: 'Base loop gain; the homeostat trims around it' }),
      knob('loop.time', { label: 'Tape', min: 0.01, max: 9, curve: 'log', format: fmt.sec, title: 'Loop length: the delay of the left tape head' }),
      knob('loop.spread', { label: 'Heads', min: 0.5, max: 2, curve: 'log', format: fmt.ratio, title: 'Right head delay relative to the left' }),
      knob('loop.tone', { label: 'Tone', min: 0, max: 1, format: fmt.pct, title: 'Top end kept at the record head on each pass' }),
      knob('loop.shift', { label: 'Shift', min: -60, max: 60, curve: 'slog', lin0: 0.05, default: DEFAULTS.loop.shift, format: fmt.shift, title: 'Single-sideband frequency shift applied on every pass' }),
      knob('loop.shiftSpread', { label: 'Mirror', min: 0, max: 1, format: fmt.pct, title: 'At 100% the right channel shifts the opposite way' }),
      knob('loop.smear', { label: 'Smear', min: 0, max: 1, format: fmt.pct, title: 'Reverberation inside the loop' }),
      knob('loop.decay', { label: 'Decay', min: 0, max: 0.97, format: fmt.pct, title: 'Length of the smear' }),
      knob('loop.cross', { label: 'Cross', min: 0, max: 0.5, format: fmt.pct, title: 'Left and right returns feeding each other' })));

  /* ---- homeostasis ---- */
  const homeoCard = card('homeo', 'H', 'Homeostasis', 'Each band has an envelope follower driving an inverted VCA: a band that rises past the ceiling is held down, then slowly let go. The loop as a whole inhales toward the setpoint and exhales past it, and a slower metabolism keeps the breathing itself from settling into a routine.',
    h('div', { class: 'knobs knobs--grid' },
      knob('homeo.ceil', { label: 'Ceiling', min: 0, max: 24, format: fmt.db, title: 'How far above an even share of the spectrum a band may rise before its inverted VCA holds it down' }),
      knob('homeo.strength', { label: 'Hold', min: 0, max: 1.5, format: fmt.num, title: 'How hard a loud band is held: 1 holds it at the ceiling' }),
      knob('homeo.release', { label: 'Release', min: 0.05, max: 30, curve: 'log', format: fmt.sec, title: 'How slowly a held band opens again (stretched by Era)' }),
      knob('homeo.breath', { label: 'Breath', min: 0, max: 2, format: fmt.num, title: 'How fast the loop inhales and exhales' }),
      knob('homeo.depth', { label: 'Depth', min: 1, max: 24, format: fmt.db, title: 'How far the loop falls on each exhale' }),
      knob('bank.q', { label: 'Precision', min: 1.5, max: 24, curve: 'log', format: fmt.q, title: 'Filter Q of the bank: 4.3 is a true third-octave, higher rings' }),
      knob('homeo.metab', { label: 'Metabolism', min: 0, max: 2, format: fmt.pct, title: 'A slower regulator that watches the breathing. When it turns clock-like or stops changing, the metabolism shifts the setpoint, depth and ceiling. 0% turns it off.' }),
      knob('homeo.temper', { label: 'Temper', min: 0, max: 1, format: fmt.pct, title: 'How far the colour wanders from the helm’s Warmth. When the web has kept one colour for a while, it leans the other way: warmer after a cold spell, colder after a warm one. 0% holds the colour still.' })),
    live.metab = h('p', { class: 'card__live', id: 'metab-live', text: 'The metabolism is resting.' }),
    live.temper = h('p', { class: 'card__live', id: 'temper-live', text: 'Colour as the helm sets it.' }));

  /* ---- logic ---- */
  const srcOptions = SOURCES.map((s, i) => ({ id: i, label: `${s.code} · ${s.short}` }));
  const bOptions = [{ id: -1, label: 'Fixed level' }, ...srcOptions];
  const gateRows = h('div', { class: 'gates' });
  live.lamps = [];
  for (let g = 0; g < 4; g++) {
    const lamp = h('span', { class: 'lamp', 'aria-hidden': 'true' });
    live.lamps.push(lamp);
    const kWrap = h('div', { class: 'gate__k' }, knob(`gates.${g}.k`, { label: 'Level', min: -1, max: 1, format: fmt.signed, title: 'The fixed level B, when B is fixed' }));
    syncs.push(() => { kWrap.style.visibility = getArch().gates[g].b !== -1 ? 'hidden' : ''; });
    gateRows.append(h('div', { class: 'gate' },
      h('div', { class: 'gate__id' }, lamp, h('b', { text: `L${g + 1}` })),
      h('div', { class: 'gate__fields' },
        select(`gate-${g}-a`, 'A', srcOptions, () => getArch().gates[g].a, (v) => { getArch().gates[g].a = +v; changed(`gates.${g}.a`, true, 'A'); }),
        select(`gate-${g}-mode`, 'Rule', GATE_MODES, () => getArch().gates[g].mode, (v) => { getArch().gates[g].mode = v; changed(`gates.${g}.mode`, true, 'rule'); }),
        select(`gate-${g}-b`, 'B', bOptions, () => getArch().gates[g].b, (v) => { getArch().gates[g].b = +v; kWrap.style.visibility = +v !== -1 ? 'hidden' : ''; changed(`gates.${g}.b`, true, 'B'); })),
      h('div', { class: 'gate__knobs' },
        kWrap,
        knob(`gates.${g}.h`, { label: 'Hyst', min: 0, max: 0.5, format: fmt.num, title: 'Hysteresis: how far past B the comparison must go before the gate changes' }))));
  }
  const logicCard = card('logic', 'L', 'Logic gates', 'Comparators watch two eyes and open or shut. They decide when reels record and, through the matrix, which tapes come up in the mix.', gateRows);

  /* ---- reels ---- */
  const reelModes = [{ id: 'self', label: 'Self loop' }, { id: 'tape', label: 'Held tape' }, { id: 'off', label: 'Off' }];
  const reels = h('div', { class: 'reels' });
  live.reels = [];
  for (let r = 0; r < 4; r++) {
    const status = h('span', { class: 'live', text: '—' });
    const recLamp = h('span', { class: 'lamp lamp--rec', 'aria-hidden': 'true' });
    const file = h('input', { type: 'file', accept: 'audio/*', id: `reel-${r}-file`, class: 'sr-only' });
    const lenWrap = h('div', {}, knob(`reels.${r}.len`, { label: 'Length', min: 0.5, max: 24, curve: 'log', format: fmt.sec, title: 'Loop length of a self-recording reel' }));
    const recWrap = select(`reel-${r}-rec`, 'Records', REC_SOURCES, () => getArch().reels[r].rec, (v) => { getArch().reels[r].rec = +v; changed(`reels.${r}.rec`, true, 'recording'); });
    const loadBtn = h('label', { class: 'btn btn--small', for: `reel-${r}-file` }, 'Load sound');
    const capBtn = h('button', { type: 'button', class: 'btn btn--small' }, 'Capture 8 s');
    const clrBtn = h('button', { type: 'button', class: 'btn btn--small btn--quiet' }, 'Clear');
    const refresh = () => {
      const m = getArch().reels[r].mode;
      lenWrap.hidden = m !== 'self';
      recWrap.hidden = m !== 'self';
    };
    syncs.push(refresh);
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const secs = await engine.loadReel(r, f, getArch());
        getArch().reels[r].mode = 'tape';
        refresh();
        api.syncAll();
        changed(`reels.${r}.mode`, true, 'sound');
        notify(`Reel ${r + 1} holds “${f.name}” (${secs.toFixed(1)} s).`);
      } catch (err) {
        notify(`Reel ${r + 1} could not read that file. Try a WAV, MP3, OGG or M4A file. (${err.message})`, 'error');
      }
      file.value = '';
    });
    capBtn.addEventListener('click', async () => {
      try {
        await engine.enableMic(getArch());
        engine.capture(r, 8);
        notify(`Reel ${r + 1} is capturing 8 seconds from the microphone.`);
      } catch (err) {
        notify(`The microphone is not available here (${err.message}). Load a sound file instead.`, 'error');
      }
    });
    clrBtn.addEventListener('click', () => {
      engine.clearReel(r);
      notify(`Reel ${r + 1} cleared.`);
    });
    live.reels.push({ status, recLamp });
    reels.append(h('div', { class: 'reel' },
      h('div', { class: 'gen__head' }, h('b', { text: `R${r + 1}` }), recLamp, status),
      select(`reel-${r}-mode`, 'Mode', reelModes, () => getArch().reels[r].mode, (v) => { getArch().reels[r].mode = v; refresh(); changed(`reels.${r}.mode`, true, 'mode'); }),
      h('div', { class: 'knobs' },
        lenWrap,
        knob(`reels.${r}.level`, { label: 'Level', min: 0, max: 1.25, format: fmt.pct, title: 'Base level of this reel in the mix' }),
        knob(`reels.${r}.speed`, { label: 'Speed', min: -4, max: 4, format: fmt.speed, default: 1, title: 'Playback speed; negative plays backwards' })),
      recWrap,
      h('div', { class: 'reel__btns' }, file, loadBtn, capBtn, clrBtn)));
  }
  const micBtn = h('button', { type: 'button', class: 'btn btn--small', id: 'mic-enable' }, 'Use microphone');
  micBtn.addEventListener('click', async () => {
    try {
      await engine.enableMic(getArch());
      micBtn.textContent = 'Microphone on';
      micBtn.disabled = true;
      notify('Microphone connected. Raise “Live in” to let the room into the loop.');
    } catch (err) {
      notify(`The microphone is not available here (${err.message}).`, 'error');
    }
  });
  const reelCard = card('reels', 'R', 'Reels', 'Tape loops of concrete material. Self-recording reels take the output back in while their gate is open; held reels play a sound you load. All of them feed the loop.',
    reels,
    h('div', { class: 'knobs knobs--row' },
      knob('reelToLoop', { label: 'Into loop', min: 0, max: 1.5, format: fmt.pct, title: 'How much of the reel mix enters the loop' }),
      knob('liveIn', { label: 'Live in', min: 0, max: 1.5, format: fmt.pct, title: 'Microphone into the loop, once enabled' }),
      h('div', { class: 'card__aside' }, micBtn)));

  /* ---- output ---- */
  const recBtn = h('button', { type: 'button', class: 'btn btn--small', id: 'record-toggle' }, 'Record output');
  const recInfo = h('span', { class: 'live', id: 'record-info', text: 'Lossless 24-bit WAV at the engine’s own sample rate, taken after the limiter and before the Level knob, so the file is the same whatever you listen at. Very long sessions continue in a new file every 3.7 hours or so, with no gap.' });
  const recFiles = h('ul', { class: 'record__files', id: 'record-files' });
  const outCard = card('out', 'O', 'Output', 'What reaches the speakers. The loop is the system; the dry cascade and reels are its raw material.',
    h('div', { class: 'knobs knobs--row' },
      knob('out.loop', { label: 'Loop', min: 0, max: 1.5, format: fmt.pct }),
      knob('out.dry', { label: 'Dry ×', min: 0, max: 1.5, format: fmt.pct }),
      knob('out.reels', { label: 'Reels', min: 0, max: 1.5, format: fmt.pct }),
      knob('out.space', { label: 'Space', min: 0, max: 1.5, format: fmt.pct })),
    h('div', { class: 'record' }, recBtn, recInfo), recFiles);
  live.recBtn = recBtn;
  live.recInfo = recInfo;
  live.recFiles = recFiles;

  root.append(genCard, multCard, loopCard, homeoCard, logicCard, outCard, reelCard);

  return {
    sync() { for (const s of syncs) s(); },
    live,
    update(frame) {
      for (let i = 0; i < 4; i++) live[`gen${i}`].textContent = `${fmt.hz(frame.gens[i])}`;
      const st = frame.stat;
      if (st.length > 21) {
        const moved = Math.abs(st[15]) + Math.abs(st[16]) + Math.abs(st[17]) > 0.1;
        live.metab.textContent = getArch().homeo.metab === 0 ? 'The metabolism is off.'
          : moved || st[18] > 0.02
            ? `Setpoint ${fmt.db(st[15])}, depth ${fmt.db(st[16])}, ceiling ${fmt.db(st[17])} · pressure ${Math.round(st[18] * 100)}% · ${st[20]} shift${st[20] === 1 ? '' : 's'} so far`
            : 'The metabolism is resting: the breathing is varied enough.';
      }
      if (st.length > 26) {
        const off = st[25];
        live.temper.textContent = getArch().homeo.temper === 0 ? `Colour held at ${Math.round(st[24] * 100)}% warm.`
          : `Colour ${Math.round(st[24] * 100)}% warm · temper leaning ${Math.abs(off) < 0.01 ? 'nowhere yet' : off > 0 ? 'warmer' : 'colder'} · ready to turn ${Math.round(st[26] * 100)}%`;
      }
      for (let g = 0; g < 4; g++) live.lamps[g].style.setProperty('--on', frame.gates[g].toFixed(3));
      for (let r = 0; r < 4; r++) {
        const len = frame.reels[r * 4 + 3];
        const rec = frame.reels[r * 4 + 2];
        const mode = getArch().reels[r].mode;
        live.reels[r].recLamp.style.setProperty('--on', rec.toFixed(3));
        live.reels[r].status.textContent = mode === 'off' ? 'off'
          : len > 0 ? `${mode === 'self' ? 'loop' : 'holds'} ${len.toFixed(1)} s${rec > 0.05 ? ' · recording' : ''}`
          : mode === 'tape' ? 'empty' : '—';
      }
    },
  };
}
