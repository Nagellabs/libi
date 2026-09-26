import type { InputAudioTrack } from "mediabunny";
import { repairHeAacDecoderConfig } from "@/lib/audio/he-aac-config";

const REPAIRED = Symbol("libi.heAacRepaired");

/**
 * Makes an HE-AAC track decodable in Chromium by correcting the decoder config
 * mediabunny builds for it (see `he-aac-config.ts`). mediabunny's
 * `AudioSampleSink` / `AudioBufferSink` read the config through the track's
 * public `getDecoderConfig()` (still so in 1.60), so this wraps that method on
 * this one track instance. Decoding stays on mediabunny's own WebCodecs path,
 * including its error reporting: a decoder failure rejects the sample iterator
 * promptly.
 *
 * Not a registered CustomAudioDecoder, deliberately. In mediabunny 1.40 a
 * custom decoder could not report an asynchronous error, and a file of more
 * than ~40 packets hung its iterator forever (Review I1). 1.50 added `onError`
 * for custom decoders, but wrapping one method is still the smaller change.
 * `he-aac-track.test.ts` pins the prompt rejection through the real sink.
 *
 * Idempotent. With mediabunny 1.60 it changes exactly one kind of config: SBR
 * on a mono core with no PS signalled (mono-source HE-AAC v1), which 1.60
 * still reports as 1 channel and Electron 36 rejects. The Dreams clip
 * (HE-AACv2), stereo HE-AAC v1, LC and every other codec reach the sink
 * untouched. The repair can be deleted once mediabunny reports that case as 2
 * channels; `he-aac-track.test.ts` says so when it does.
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */
export function repairHeAacTrack(track: InputAudioTrack): void {
  const t = track as InputAudioTrack & { [REPAIRED]?: true };
  if (t[REPAIRED] || typeof t.getDecoderConfig !== "function") return;
  const originalConfig = t.getDecoderConfig.bind(t);
  const originalCanDecode = typeof t.canDecode === "function" ? t.canDecode.bind(t) : null;
  const repaired = async (): Promise<AudioDecoderConfig | null> => {
    const config = await originalConfig();
    return config ? repairHeAacDecoderConfig(config) : null;
  };
  t.getDecoderConfig = async () => (await repaired()) ?? (await originalConfig());
  // mediabunny's canDecode() (which its sinks call again before creating a
  // decoder) asks AudioDecoder.isConfigSupported about the config it reads
  // through its internal backing, the UNREPAIRED one. A platform that refuses
  // that config up front would never reach the repair (Re-review R3), so a
  // repaired track answers from the repaired config. Everything else keeps
  // mediabunny's own answer.
  if (originalCanDecode) {
    t.canDecode = async () => {
      let config: AudioDecoderConfig | null;
      try {
        config = await repaired();
      } catch {
        return originalCanDecode();
      }
      if (!config) return originalCanDecode();
      if (typeof AudioDecoder === "undefined") return false;
      try {
        return (await AudioDecoder.isConfigSupported(config)).supported === true;
      } catch {
        return false;
      }
    };
  }
  t[REPAIRED] = true;
}
