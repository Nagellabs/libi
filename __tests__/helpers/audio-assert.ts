export interface WavHeader {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSeconds: number;
}

export function parseWavHeader(buf: Buffer): WavHeader {
  if (
    buf.length < 44 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE buffer");
  }
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  // Scan chunks for "data".
  let offset = 12;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      dataLen = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  const durationSeconds =
    bytesPerFrame > 0 ? dataLen / bytesPerFrame / sampleRate : 0;
  return { sampleRate, channels, bitsPerSample, durationSeconds };
}

export function assertWav(
  buf: Buffer,
  opts: { sampleRate?: number; minSeconds?: number; maxSeconds?: number },
): WavHeader {
  const h = parseWavHeader(buf);
  if (opts.sampleRate !== undefined && h.sampleRate !== opts.sampleRate) {
    throw new Error(
      `unexpected sample rate ${h.sampleRate}, expected ${opts.sampleRate}`,
    );
  }
  if (opts.minSeconds !== undefined && h.durationSeconds < opts.minSeconds) {
    throw new Error(
      `duration ${h.durationSeconds.toFixed(2)}s below min ${opts.minSeconds}s`,
    );
  }
  if (opts.maxSeconds !== undefined && h.durationSeconds > opts.maxSeconds) {
    throw new Error(
      `duration ${h.durationSeconds.toFixed(2)}s above max ${opts.maxSeconds}s`,
    );
  }
  return h;
}
