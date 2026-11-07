# Kybernetes

A self-regulating feedback instrument for the browser.

You don't play notes on it. You build a closed web of generators, multipliers, tape loops and filters, set its rules, switch it on, and let it run. The system watches its own levels, spectrum and rate of change, and turns its own knobs. It pushes itself toward instability, regulates itself back, and settles into a new equilibrium. You steer it with a handful of slow controls, the way a helmsman nudges a ship.

There are **no LFOs, no noise generators and no step sequencers**. Nothing draws a random number while the system runs. All motion comes from the web reading itself.

## Running it

It's a static site with no build step and no dependencies. ES modules and the AudioWorklet need to be served over HTTP:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000> and press **Engage**. It needs a current Chrome, Edge, Firefox or Safari.

## How the machine is built

```
 G1 ─┐
     ×1 ──┐
 G2 ─┘    ×2 ──┐
 G3 ──────┘    ×3 ──┐
 G4 ───────────┘    ×4 ──► TAPE ──► BANK ──► SHIFT ──► SMEAR ──┬──► OUT ──► reels record it
                    ▲       ▲                                  │
                    │       └──────────── feedback ────────────┤
                    └──────────── multiplied by the return ────┤
 generators' phase ◄──────────────── pushed by the return ─────┘
```

* **Generators (G1–G4).** Four oscillators that modulate their own phase (fold), pull toward small whole-number frequency ratios with their neighbour (coupling), and have their phase pushed by the loop's return.
* **Glide.** Anything that changes pitch moves at the glide's pace, stretched by Era: generator pitch, tape speed (a long glide makes a heavy transport that never bends far), reel speed, frequency shift, and the bank's tilt and rotation. The default of 10 seconds makes the web drift rather than swoop. The restless presets use 1.5–2 seconds.
* **Ratios.** How closely the generators keep their tuning relative to one another as they drift. The cascade's combination tones beat at rates set by small differences between the generators. Let them drift apart and a beat can slide from a fraction of a hertz to several hertz, which sounds like the music speeding up and slowing down. Held ratios (85% by default) make the generators drift together, so the beats stay steady.
* **No ramps by default.** The calm architectures play their reels at the material's own speed, forwards or backwards. They mirror the frequency shifter (left up, right down), so nothing spirals upward or downward, and none of their pins vary reel speed or shift. The matrix can still move tape length, shift and reel speed when you patch it, but over narrower ranges than before.
* **Multiplier cascade (×1–×4).** Four ring multipliers in series. Multiplication cancels the input frequencies and leaves their sums and differences. The fourth stage multiplies by the loop's own return: multiplied feedback.
* **The loop.** A stereo tape delay with two heads, a bank of 24 third-octave band-pass filters (63 Hz to 12.5 kHz), a single-sideband frequency shifter and a smearing reverberator, all *inside* the feedback path. Every pass is re-carved, re-pitched and smeared.
* **Eyes.** Envelope followers read the multiplier output, loop level, output level, reel level, low, middle and high spectral share, spectral centre, rate of change and regulation pressure. They habituate: each eye reports how far things are from what it has grown used to.
* **The matrix.** 14 eyes × 18 destinations (generator pitches, fold, coupling, multiplication depth, tape time, bank tilt and rotation, shift, smear, feedback, reel levels and speed). Each pin carries a signed amount; amber pins invert.
* **Homeostasis.** Every band has its own envelope follower driving an inverted VCA. A band that rises the ceiling's worth above an even share of the active bands is held down fast, then let go slowly, so no few bands can hoard the loop and the spectrum keeps moving on. The loop as a whole has a homeostat that inhales (opens the gain slowly toward the setpoint) and exhales (pulls it back once the loop overshoots, until it has fallen by the breath depth). The breathing period isn't set anywhere. It depends on how the web responds.
* **Metabolism.** A second, much slower regulator watches the breathing itself. When breaths start keeping time like a clock, when their pace hasn't changed for the better part of an hour, or when the loop stops breathing, pressure builds over several minutes. When it's full, the metabolism shifts the setpoint, breath depth and ceiling the homeostat works with, gliding over a minute or two. If its last shift made the breathing more varied it keeps that direction. If not, it reads a new direction off what the eyes see at that moment, so its steps follow the system's own history and never cycle. With no pressure, the offsets drift slowly back home. Era stretches all of it.
* **Logic gates (L1–L4).** Comparators with hysteresis on any two eyes, or one eye and a fixed level, in *greater than*, *less than* or *flip* modes. They decide when reels record and, through the matrix, which reels come up in the mix.
* **Reels (R1–R4).** Tape loops of concrete material. *Self loop* reels record the system's own output while their gate is open and play it back at their own speed (including reversed). *Held tape* reels play a sound you load or capture from the microphone.

## The interface

| Area | What it's for |
| --- | --- |
| **Helm** | The steersman's controls: Inflow, Bias (a master voltage added to every eye), Drift (global transposition), Setpoint, Coupling (matrix depth) and Era. Every helm move glides. The amber inner arc shows where the system actually is. **Perturb** strikes a short burst into the loop. The regulation trace shows two minutes of loop level against the setpoint as the metabolism has moved it, with the helm's own setpoint dotted beneath. |
| **The web** | The architecture drawn as an orrery. The loop circles the homeostat; the output's phase portrait (mid vertical, side horizontal) fills its eye. Modulation arcs glow with the voltage they carry. |
| **Matrix** | Click a hole to place a pin. Drag a pin up or down to set its amount. Right-click inverts it, double-click removes it, and Alt-click places an inverting pin. Arrow keys, Enter, `+`, `-` and `I` work when it has focus. |
| **Bank** | Live band energy, with amber showing how far each band is being held down. Draw across it to set the carving curve. The dotted line is that curve as the system is currently bending it. |
| **Logbook** | Epochs (stable states the system settles into, with a short description), steering, and events. |
| **Chronicle** | A spectrogram of the whole run, with epochs marked above, and steering (amber) and metabolism shifts (open rings) below. Spans of 1, 4 and 14 hours show how little of a long piece has happened yet. |
| **Snapshots** | **Snapshot** (or <kbd>S</kbd>) keeps the current architecture and helm and flags the moment on the chronicle. Click the flag, or **Recall** in the list, to return. Recall restores the rules and the helm. The system's own memory (tape, reels, filter states) carries on, so it finds its way back rather than jumping. Snapshots are kept in the browser. |
| **Undo** | Every finished edit is one step: a knob released, a pin placed, a stroke across the bank, a menu choice, an architecture loaded or recalled. Use the header arrows, <kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>Z</kbd> and <kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>Z</kbd>. The output level isn't part of the history. |
| **Architecture** | Every module's parameters, seven starting architectures, *Derive from a name* (the same name always builds the same web), and architecture codes you can copy and paste to share an exact web. |

**Era** stretches every slow process: band release, breath, glide, habituation and gate slew. It runs from *Weather* (seconds) through *Tide* and *Season* to *Aeon* (tens of minutes). Systems like this need hours to show what they are.

Keyboard: <kbd>Space</kbd> engages or halts, <kbd>P</kbd> perturbs, <kbd>S</kbd> takes a snapshot, and <kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>Z</kbd> undoes. Knobs respond to dragging (Shift for fine), arrow keys, or the scroll wheel once focused. Double-click resets a knob to its default.

The architecture is saved in the browser's local storage. Loaded sounds are not saved.

## Offline rendering and inspection

`tools/render.mjs` runs the same signal engine in Node, with no browser, and writes a WAV file. At the end it reports how the system regulated itself:

* **Headroom:** how often the feedback gain sat at its ceiling, and the trim the homeostat needed.
* **Breathing:** breaths per window, the mean interval, and how much the intervals vary. Low variation means clock-like.
* **Metabolism:** each shift, why it happened and where it moved the setpoint, depth and ceiling.
* **Motion:** how fast pitch, tape speed, shift, level and brightness change from one second to the next, how far each generator ranges, how many abrupt moves there were, and how far the spectrum evolves over five minutes.
* **Clicks:** isolated sample discontinuities, each with what the engine was doing at that moment (a reel loop point, a record-head crossing, a tape lurch, the limiter, a gate). Sharp sawtooth edges from heavily folded generators are counted apart, as timbre.

```bash
node tools/render.mjs --seconds 600 --preset "Gas Giant" --out gas-giant.wav
```

```bash
node tools/render.mjs --derive andromeda --seconds 300 --at 120:bias=0.4 --at 200:perturb --out a.wav
```

```bash
node tools/render.mjs --set loop.time=0.4 --set bank.q=14 --seconds 120 --out narrow.wav
```

`--inject 20` adds synthetic steps to check the click detector. `--hold 4:441.3:1.7` puts a raw sine on reel 4 whose ends don't line up, to test loop points. `--at 30:arch:loop.time=4` changes the architecture mid-run.

The engine renders at about 20× real time on one core.

## Files

```
index.html            the page
styles.css            the single dark console look
js/dsp/processor.js   the signal engine (AudioWorkletProcessor)
js/state.js           the architecture model, presets, derivation, codes
js/engine.js          AudioContext, worklet, analysers, reels, microphone, recorder
js/epochs.js          detects the system settling into and leaving stable states
js/history.js         undo and redo
js/main.js            wiring
js/ui/                knobs, matrix, bank, web, chronicle, regulation trace, module cards
tools/render.mjs      offline renderer
```
