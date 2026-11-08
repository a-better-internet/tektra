/*
 * The audio side of the page: one AudioContext, one worklet holding the
 * whole web, two analysers for the phase display, optional microphone and
 * recorder. Everything the interface needs from the signal engine arrives as
 * 'frame' events about thirty times a second.
 */
import { WavRecorder } from './recorder.js';

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.running = false;
    this.starting = null;
    this.frame = null;
    this.scopeL = new Float32Array(2048);
    this.scopeR = new Float32Array(2048);
    this.mic = null;
    this.recorder = null;
  }

  get ready() { return !!this.node; }

  async init(arch) {
    if (this.node) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('This browser has no Web Audio support.');
      // 48 kHz: the rate the engine is tuned at and the offline renderer uses
      let ctx;
      try { ctx = new AC({ latencyHint: 'playback', sampleRate: 48000 }); } catch { ctx = new AC({ latencyHint: 'playback' }); }
      if (!ctx.audioWorklet) throw new Error('This browser cannot run audio worklets. Try a current Chrome, Firefox or Safari.');
      const url = new URL('./dsp/processor.js', import.meta.url);
      try {
        await ctx.audioWorklet.addModule(url);
      } catch (first) {
        // Some sandboxed hosts refuse module URLs for worklets; a blob of the same source works.
        const res = await fetch(url);
        if (!res.ok) throw first;
        const blob = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(blob);
      }
      const node = new AudioWorkletNode(ctx, 'kybernetes', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { arch },
      });
      node.port.onmessage = (e) => this.onMessage(e.data);
      const split = ctx.createChannelSplitter(2);
      this.anL = ctx.createAnalyser();
      this.anR = ctx.createAnalyser();
      this.anL.fftSize = 2048;
      this.anR.fftSize = 2048;
      node.connect(split);
      split.connect(this.anL, 0);
      split.connect(this.anR, 1);
      node.connect(ctx.destination);
      this.ctx = ctx;
      this.node = node;
      this.emit('ready');
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  post(msg, transfer) {
    if (this.node) this.node.port.postMessage(msg, transfer || []);
  }

  onMessage(m) {
    switch (m.type) {
      case 'frame':
        this.frame = m;
        this.emit('frame', m);
        break;
      case 'rec':
        if (this.recorder) this.recorder.push(m.data);
        break;
      case 'rec-end':
        if (this.recDone) { this.recDone(); this.recDone = null; }
        break;
      case 'halted':
        this.running = false;
        if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
        this.emit('state', { running: false });
        break;
      default:
        this.emit(m.type, m);
    }
  }

  async engage(arch) {
    await this.init(arch);
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.post({ type: 'engage' });
    this.running = true;
    this.emit('state', { running: true });
  }

  halt() {
    if (!this.running) return;
    this.post({ type: 'halt' });
  }

  setArch(arch) { this.post({ type: 'arch', arch }); }
  setHelm(helm) { this.post({ type: 'helm', helm }); }
  perturb(amount = 0.9) { this.post({ type: 'perturb', amount }); }
  reset() { this.post({ type: 'reset' }); }

  readScope() {
    if (!this.anL) return false;
    this.anL.getFloatTimeDomainData(this.scopeL);
    this.anR.getFloatTimeDomainData(this.scopeR);
    return true;
  }

  /* Load a sound file into a reel as held tape material. */
  async loadReel(reel, file, arch) {
    await this.init(arch);
    const bytes = await file.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(bytes);
    const max = Math.min(buf.length, Math.round(buf.sampleRate * 60));
    const data = new Float32Array(max);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < max; i++) data[i] += ch[i] / buf.numberOfChannels;
    }
    let peak = 0;
    for (let i = 0; i < max; i++) peak = Math.max(peak, Math.abs(data[i]));
    const g = peak > 0 ? 0.7 / peak : 1;
    const fade = Math.min(max >> 2, Math.round(buf.sampleRate * 0.015));
    for (let i = 0; i < max; i++) {
      let w = g;
      if (i < fade) w *= i / fade;
      else if (i >= max - fade) w *= (max - 1 - i) / fade;
      data[i] *= w;
    }
    this.post({ type: 'reel-load', reel, data }, [data.buffer]);
    return max / buf.sampleRate;
  }

  clearReel(reel) { this.post({ type: 'reel-clear', reel }); }

  async enableMic(arch) {
    await this.init(arch);
    if (this.mic) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not offer microphone input here.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.node);
    this.mic = { stream, src };
  }

  capture(reel, seconds) { this.post({ type: 'capture', reel, seconds }); }

  /* Lossless recording of the finished signal, before the listening level. */
  startRecording(meta) {
    if (!this.node || this.recorder) return false;
    this.recorder = new WavRecorder(this.ctx.sampleRate, meta);
    this.recorder.onFile = (file) => this.emit('rec-file', file);
    this.post({ type: 'rec-start' });
    return true;
  }

  stopRecording() {
    const r = this.recorder;
    if (!r) return Promise.resolve([]);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.recorder = null;
        resolve(r.finish());
      };
      this.recDone = finish;
      this.post({ type: 'rec-stop' });
      // if the audio thread is suspended it cannot answer; keep what arrived
      setTimeout(finish, 1500);
    });
  }
}
