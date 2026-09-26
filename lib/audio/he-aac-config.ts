/**
 * Repairs the WebCodecs decoder config of an HE-AAC track. Pure: no DOM, no
 * mediabunny.
 *
 * HE-AAC's AudioSpecificConfig describes a half-rate CORE layer, plus SBR
 * (object type 5, or an 0x2b7 sync extension) that doubles the rate and, with
 * PS (object type 29, or an 0x548 extension), turns a MONO core into stereo.
 * Chromium (Electron 36) decodes any SBR stream on a mono core to two channels
 * (ISO 14496-3 §1.6.5.3: PS may ride in-band). A decoder config that says 1
 * channel for such a stream passes `isConfigSupported`, then fails
 * asynchronously with `OperationError: Unsupported configuration`, and the
 * clip is silent in the preview. The rate is not what decides it.
 *
 * mediabunny 1.40 reported the core layer (the Dreams clip, HE-AACv2, reached
 * WebCodecs as 1 ch / 22050 Hz). Since 1.55.3 (#471) it reports the SBR output
 * rate, and 2 channels when PS is signalled. It still reports 1 channel for
 * SBR on a mono core with no PS signalled: a mono-source HE-AAC v1 file, as
 * afconvert and other encoders write it. Measured with 1.60 in Electron 36:
 * that config fails, 2 channels decodes. That is the one case this repairs;
 * every config upstream gets right already says 2 channels and is left alone,
 * so a mediabunny that fixes it turns this off on its own.
 *
 * Streams that signal SBR only in-band are undetectable here. For those, the
 * audio engine's fallback to the proxy's AAC-LC track is the safety net.
 *
 * docs-local/qa/2026-09-25-dreams-audio-report.md,
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */

export interface AacAudioSpecificConfig {
  /** Audio object type: 2 = LC, 5 = SBR (HE-AAC), 29 = PS (HE-AACv2). */
  objectType: number;
  /** Sampling rate of the core (half-rate, when SBR is present) layer. */
  coreSampleRate: number | null;
  /** Channels of the core layer; null = PCE-defined. */
  coreChannels: number | null;
  /** Output rate when SBR is signalled; null when it isn't. */
  sbrSampleRate: number | null;
  /** Parametric stereo signalled: a mono core decodes to stereo. */
  psPresent: boolean;
}

const FREQUENCIES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
const CHANNELS = [null, 1, 2, 3, 4, 5, 6, 8] as const;

const AOT_LC = 2;
const AOT_SBR = 5;
const AOT_PS = 29;
const SYNC_EXTENSION_SBR = 0x2b7;
const SYNC_EXTENSION_PS = 0x548;

class BitReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining(): number {
    return this.bytes.length * 8 - this.pos;
  }
  read(n: number): number {
    if (n > this.remaining) throw new RangeError("ASC truncated");
    let v = 0;
    for (let i = 0; i < n; i++) {
      const bit = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
      v = v * 2 + bit;
      this.pos++;
    }
    return v;
  }
}

function readObjectType(r: BitReader): number {
  const aot = r.read(5);
  return aot === 31 ? 32 + r.read(6) : aot;
}

function readFrequency(r: BitReader): number | null {
  const idx = r.read(4);
  if (idx === 15) return r.read(24);
  return FREQUENCIES[idx] ?? null;
}

function toBytes(description: AllowSharedBufferSource | undefined): Uint8Array | null {
  if (!description) return null;
  if (description instanceof Uint8Array) return description;
  if (ArrayBuffer.isView(description)) {
    return new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
  }
  return new Uint8Array(description as ArrayBuffer);
}

/** Parse an MPEG-4 AudioSpecificConfig (ISO 14496-3 §1.6.2.1), as far as it
 *  decides the decoded rate and channel count. Returns null for bytes too short
 *  or malformed to be one. */
export function parseAacAudioSpecificConfig(bytes: Uint8Array): AacAudioSpecificConfig | null {
  if (bytes.length < 2) return null;
  const r = new BitReader(bytes);
  try {
    const objectType = readObjectType(r);
    const coreSampleRate = readFrequency(r);
    const channelConfig = r.read(4);
    const coreChannels = CHANNELS[channelConfig] ?? null;
    let sbrSampleRate: number | null = null;
    let psPresent = false;
    if (objectType === AOT_SBR || objectType === AOT_PS) {
      // Explicit hierarchical signalling: the extension rate follows, then the
      // core's own object type (normally LC), which decides nothing here.
      psPresent = objectType === AOT_PS;
      sbrSampleRate = readFrequency(r);
    } else if (objectType === AOT_LC && channelConfig !== 0) {
      // Backward-compatible signalling: after the LC GASpecificConfig come
      // the optional SBR (0x2b7) and PS (0x548) sync extensions.
      r.read(1); // frameLengthFlag
      if (r.read(1)) r.read(14); // dependsOnCoreCoder → coreCoderDelay
      r.read(1); // extensionFlag (always 0 for LC)
      if (r.remaining >= 16 && r.read(11) === SYNC_EXTENSION_SBR) {
        const extType = readObjectType(r);
        if (extType === AOT_SBR && r.read(1)) {
          sbrSampleRate = readFrequency(r);
          if (r.remaining >= 12 && r.read(11) === SYNC_EXTENSION_PS) {
            psPresent = r.read(1) === 1;
          }
        }
      }
    }
    return { objectType, coreSampleRate, coreChannels, sbrSampleRate, psPresent };
  } catch {
    return null;
  }
}

/**
 * The decoder config with the channel count the stream actually decodes to,
 * or null when the track can stay as it is.
 *
 * It repairs ONLY what Chromium rejects: a config that says 1 channel for SBR
 * on a mono core, which decodes to stereo. The rate is mediabunny's (the SBR
 * output rate since 1.55.3); a rate-only discrepancy decodes anyway. LC, a
 * config without a description, and a config that already says 2 channels are
 * left alone.
 */
export function repairHeAacDecoderConfig(config: AudioDecoderConfig): AudioDecoderConfig | null {
  if (!config.codec.startsWith("mp4a.40")) return null;
  const bytes = toBytes(config.description);
  if (!bytes) return null;
  const asc = parseAacAudioSpecificConfig(bytes);
  if (!asc || (asc.sbrSampleRate === null && !asc.psPresent)) return null;
  if (asc.coreChannels !== 1 || config.numberOfChannels !== 1) return null;
  return { ...config, numberOfChannels: 2 };
}
