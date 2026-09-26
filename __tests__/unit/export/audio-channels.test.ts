/**
 * probeInputAudio: one channel count and primary audio stream per mixed input
 * (Review M6), a failed probe as unknown, and never more than
 * CHANNEL_PROBE_CONCURRENCY ffprobes at once (Review M5 — a piece with many
 * clips used to fork one per clip in a burst).
 */
import { describe, it, expect } from "vitest";
import { probeInputAudio, mixInputMaps, CHANNEL_PROBE_CONCURRENCY } from "@/lib/export/audio-channels";

describe("probeInputAudio", () => {
  it("maps each input index to its channels and primary stream, and a failed probe to unknown", async () => {
    const probes: Record<string, { audioChannels?: number; primaryAudioStreamIndex?: number }> = {
      "/a": { audioChannels: 1, primaryAudioStreamIndex: 1 },
      "/b": { audioChannels: 2, primaryAudioStreamIndex: 2 },
      "/c": {},
    };
    const out = await probeInputAudio(new Map([[1, "/a"], [2, "/b"], [3, "/c"]]), async (p) => probes[p]);
    expect([...out]).toEqual([[1, { channels: 1, stream: 1 }], [2, { channels: 2, stream: 2 }], [3, {}]]);
    const { inputChannels, inputAudioStream } = mixInputMaps(out);
    expect([...inputChannels]).toEqual([[1, 1], [2, 2], [3, undefined]]);
    expect([...inputAudioStream]).toEqual([[1, 1], [2, 2]]);
  });

  it(`runs at most ${CHANNEL_PROBE_CONCURRENCY} probes at once`, async () => {
    let running = 0;
    let peak = 0;
    const paths = new Map(Array.from({ length: 12 }, (_, i) => [i + 1, `/f${i}`] as [number, string]));
    const out = await probeInputAudio(paths, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { audioChannels: 2 };
    });
    expect(out.size).toBe(12);
    expect(peak).toBe(CHANNEL_PROBE_CONCURRENCY);
  });

  it("an empty map probes nothing", async () => {
    expect((await probeInputAudio(new Map(), async () => { throw new Error("no"); })).size).toBe(0);
  });
});
