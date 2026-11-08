/*
 * Lossless recording. The signal engine hands over its finished output as
 * 32-bit float chunks, taken after the limiter and before the listening
 * level; this turns them into 24-bit PCM WAV files.
 *
 * Long sessions: data is batched into Blobs, which browsers may keep on disk
 * rather than in memory, and a file that reaches the WAV format's 4 GB limit
 * (about 3.75 hours at 48 kHz) is finished and recording continues in the
 * next part with no gap between them.
 */

const BYTES_PER_FRAME = 6;            // 24-bit stereo
const MAX_DATA = 3_900_000_000;       // stay clear of the 4 GiB RIFF limit
const BATCH = 8 * 1024 * 1024;        // gather this much before making a Blob

function wavHeader(sampleRate, dataBytes, info) {
  const enc = new TextEncoder();
  const fields = Object.entries(info)
    .filter(([, v]) => v)
    .map(([id, v]) => {
      const b = enc.encode(`${v}\0`);
      return { id, b, pad: b.length & 1 };
    });
  const listSize = 4 + fields.reduce((n, f) => n + 8 + f.b.length + f.pad, 0);
  const size = 12 + 24 + 8 + listSize + 8;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) u8[p++] = s.charCodeAt(i); };
  const u32 = (v) => { dv.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { dv.setUint16(p, v, true); p += 2; };
  str('RIFF'); u32(size - 8 + dataBytes); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(2); u32(sampleRate); u32(sampleRate * BYTES_PER_FRAME); u16(BYTES_PER_FRAME); u16(24);
  str('LIST'); u32(listSize); str('INFO');
  for (const f of fields) {
    str(f.id); u32(f.b.length);
    u8.set(f.b, p); p += f.b.length;
    if (f.pad) u8[p++] = 0;
  }
  str('data'); u32(dataBytes);
  return buf;
}

export class WavRecorder {
  constructor(sampleRate, meta = {}) {
    this.sampleRate = sampleRate;
    this.meta = meta;
    this.files = [];
    this.part = 0;
    this.peak = 0;
    this.clipped = 0;
    this.totalFrames = 0;
    this.onFile = null;
    this.startPart();
  }

  startPart() {
    this.part++;
    this.blobs = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.dataBytes = 0;
  }

  get seconds() { return this.totalFrames / this.sampleRate; }
  get bytes() { return this.files.reduce((n, f) => n + f.blob.size, 0) + this.dataBytes; }

  /* Interleaved stereo float samples from the engine. */
  push(data) {
    const n = data.length;
    const bytes = new Uint8Array(n * 3);
    let peak = this.peak, clipped = this.clipped;
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      let v = data[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a >= 1) { clipped++; v = v < 0 ? -1 : 1; }
      let q = Math.round(v * 8388607);
      if (q > 8388607) q = 8388607; else if (q < -8388608) q = -8388608;
      bytes[o] = q & 255;
      bytes[o + 1] = (q >> 8) & 255;
      bytes[o + 2] = (q >> 16) & 255;
    }
    this.peak = peak;
    this.clipped = clipped;
    this.write(bytes);
  }

  write(bytes) {
    const room = MAX_DATA - this.dataBytes;
    if (bytes.length > room) {
      const fit = room - (room % BYTES_PER_FRAME);
      if (fit > 0) this.append(bytes.subarray(0, fit));
      this.finishPart();
      this.startPart();
      this.write(bytes.subarray(fit));
      return;
    }
    this.append(bytes);
  }

  append(bytes) {
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    this.dataBytes += bytes.length;
    this.totalFrames += bytes.length / BYTES_PER_FRAME;
    if (this.pendingBytes >= BATCH) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    this.blobs.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  finishPart() {
    this.flush();
    if (this.dataBytes === 0) return null;
    const date = new Date();
    const title = `${this.meta.title || 'Kybernetes'}${this.part > 1 || this.meta.multi ? ` · part ${this.part}` : ''}`;
    const head = wavHeader(this.sampleRate, this.dataBytes, {
      INAM: title,
      ISFT: 'Kybernetes',
      ICRD: date.toISOString().slice(0, 10),
      ICMT: this.meta.comment || '',
    });
    const file = {
      part: this.part,
      blob: new Blob([head, ...this.blobs], { type: 'audio/wav' }),
      seconds: this.dataBytes / BYTES_PER_FRAME / this.sampleRate,
    };
    this.files.push(file);
    this.blobs = [];
    this.dataBytes = 0;
    if (this.onFile) this.onFile(file);
    return file;
  }

  /* Finish the current part and return every file made. */
  finish() {
    this.finishPart();
    return this.files;
  }
}
