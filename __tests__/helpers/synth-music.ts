/**
 * Deterministic synthetic "music" for audio-analysis tests: two voices of random notes over a kick
 * pulse, so no two seconds alike (a steady tone would match everywhere). Mono float at `rate`.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthMusic(seconds: number, seed: number, rate = 8000): Float32Array {
  const rand = rng(seed);
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let voice = 0; voice < 2; voice++) {
    let i = 0;
    while (i < n) {
      const len = Math.round((0.22 + rand() * 0.14) * rate);
      const hz = 180 * Math.pow(2, Math.floor(rand() * 30) / 12) * (voice + 1);
      for (let k = 0; k < len && i + k < n; k++) {
        const env = Math.min(1, k / 200) * Math.min(1, (len - k) / 200);
        out[i + k] += 0.25 * env * Math.sin((2 * Math.PI * hz * (i + k)) / rate);
      }
      i += len;
    }
  }
  for (let beat = 0; beat * 0.5 * rate < n; beat++) {
    const at = Math.round(beat * 0.5 * rate);
    for (let k = 0; k < 800 && at + k < n; k++) out[at + k] += 0.4 * Math.exp(-k / 150) * Math.sin((2 * Math.PI * 70 * k) / rate);
  }
  return out;
}

/** A mono 16-bit PCM WAV of `x` at `rate`. */
export function wavBytes(x: Float32Array, rate = 8000): Buffer {
  const data = Buffer.alloc(44 + x.length * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + x.length * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return data;
}
