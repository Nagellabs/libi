/**
 * WebAudioEngine: a clip whose ORIGINAL can't be decoded in the browser plays
 * its proxy's audio instead, and a clip that can't be played at all says so
 * once and goes quiet — never a silent failure repeated on every play.
 *
 * Before this, the Dreams / Ocean Spray pieces played their TikTok clip with
 * no sound: the original's HE-AACv2 track failed `AudioDecoder.configure`, the
 * engine logged `clip schedule failed` on every play and seek (30 lines in the
 * dev server.log), and nothing tried the proxy — whose AAC-LC track decodes.
 * docs-local/qa/2026-09-25-dreams-audio-report.md
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AudioClip } from "@/lib/engine/types";

/** url → how that source behaves. */
type Behaviour = "ok" | "decode-error" | "cannot-decode" | "http-404" | "fetch-flake" | "no-audio";
const behaviour = new Map<string, Behaviour>();
const opened: string[] = [];
const buffersRequested: string[] = [];
const configsRead: AudioDecoderConfig[] = [];
type GainEvent = ["set" | "ramp" | "cancel", number, number];
/** url → how far before the requested start the first chunk begins (a chunk
 *  that straddles the start, as a real decoder's does). */
const straddle = new Map<string, number>();
/** url → the file's first raw timestamp (mediabunny getFirstTimestamp). */
const origins = new Map<string, number>();
const rangesRequested: Array<[string, number, number]> = [];
/** Whether each getFirstTimestamp ran inside an attribution region (review round 3, R3-M1). */
const firstTimestampInRegion: boolean[] = [];
let inRegion = false;

vi.mock("@/lib/engine/sps-diagnostics", () => ({
  attributeMediaLogs: async <T,>(_key: string, fn: () => Promise<T>) => {
    inRegion = true;
    try {
      return await fn();
    } finally {
      inRegion = false;
    }
  },
}));

function behaviourFor(url: string): Behaviour {
  return behaviour.get(url) ?? "ok";
}

vi.mock("mediabunny", () => {
  class UrlSource { constructor(public url: string) {} }
  class Input {
    url: string;
    constructor(opts: { source: UrlSource }) {
      this.url = opts.source.url;
      opened.push(this.url);
    }
    async getFirstTimestamp() {
      firstTimestampInRegion.push(inRegion);
      return origins.get(this.url) ?? 0;
    }
    async getPrimaryAudioTrack() {
      const b = behaviourFor(this.url);
      if (b === "http-404") throw new Error(`Error fetching ${this.url}: 404 Not Found`);
      if (b === "no-audio") return null;
      return {
        url: this.url,
        getCodec: async () => "aac",
        canDecode: async () => b !== "cannot-decode",
        // SBR on a mono core with no PS (a mono-source HE-AAC v1 file), as
        // mediabunny 1.60 still describes it: the one config the repair
        // changes (he-aac-track then answers canDecode from the repaired config
        // via AudioDecoder.isConfigSupported). A "cannot-decode" source is
        // plain LC, so mediabunny's own canDecode (above) answers.
        getDecoderConfig: async () =>
          b === "cannot-decode"
            ? { codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 44100, description: new Uint8Array([0x12, 0x10]) }
            : {
                codec: "mp4a.40.2", numberOfChannels: 1, sampleRate: 44100,
                description: new Uint8Array([0x13, 0x88, 0x56, 0xe5, 0xa0]),
              },
      };
    }
    dispose() {}
  }
  class AudioBufferSink {
    constructor(private track: { url: string; getDecoderConfig(): Promise<AudioDecoderConfig> }) {}
    async *buffers(start: number, end: number) {
      buffersRequested.push(this.track.url);
      rangesRequested.push([this.track.url, start, end]);
      configsRead.push(await this.track.getDecoderConfig());
      const b = behaviourFor(this.track.url);
      if (b === "decode-error") {
        throw new DOMException(
          "Unsupported configuration. Check isConfigSupported() prior to calling configure().",
          "OperationError",
        );
      }
      if (b === "fetch-flake") throw new Error("Failed to fetch");
      // The file's first chunk, at its raw first timestamp.
      const lead = straddle.get(this.track.url);
      yield {
        buffer: { tag: this.track.url },
        timestamp: lead !== undefined ? start - lead : (origins.get(this.track.url) ?? 0),
        duration: 0.5,
      };
    }
  }
  return {
    Input,
    UrlSource,
    AudioBufferSink,
    ALL_FORMATS: [],
    Logging: { on: () => () => {} },
  };
});

interface FakeSourceNode {
  buffer: { tag: string } | null;
  started: boolean;
  when?: number;
  offset?: number;
  playbackRate: { value: number };
  onended: (() => void) | null;
}
const startedSources: FakeSourceNode[] = [];

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

let warn: { mock: { calls: unknown[][] }; mockRestore(): void };

beforeEach(() => {
  behaviour.clear();
  opened.length = 0;
  buffersRequested.length = 0;
  configsRead.length = 0;
  origins.clear();
  rangesRequested.length = 0;
  straddle.clear();
  proxyStates.clear();
  startedSources.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("AudioDecoder", { isConfigSupported: async (config: AudioDecoderConfig) => ({ supported: true, config }) });
  // Records its automation so tests can read the gain envelope. `value`
  // starts at 1, a real GainNode's intrinsic gain.
  const param = () => {
    const events: GainEvent[] = [];
    return {
      value: 1,
      events,
      setValueAtTime: (v: number, t: number) => { events.push(["set", v, t]); },
      linearRampToValueAtTime: (v: number, t: number) => { events.push(["ramp", v, t]); },
      cancelScheduledValues: (t: number) => { events.push(["cancel", 0, t]); },
    };
  };
  vi.stubGlobal("AudioContext", class {
    state = "running";
    sampleRate = 48000;
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    async resume() {}
    async close() {}
    createGain() {
      return { gain: param(), connect: () => {}, disconnect: () => {} };
    }
    createBufferSource() {
      const node: FakeSourceNode & Record<string, unknown> = {
        buffer: null,
        started: false,
        playbackRate: { value: 1 },
        onended: null,
        connect: () => {},
        disconnect: () => {},
        stop: () => {},
        start: (when?: number, offset?: number) => {
          node.started = true;
          node.when = when;
          node.offset = offset;
          startedSources.push(node);
        },
      };
      return node;
    }
  });
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
});

function clip(id: string, extra: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    fileId: `f-${id}`,
    kind: "inline",
    startTime: 0,
    duration: 8,
    trimStart: 0,
    volume: 1,
    enabled: true,
    ...extra,
  } as AudioClip;
}

/** fileId → whether a proxy is expected for it (default: ready). */
type ProxyStateLike = "none" | "pending" | "ready" | "unknown" | { state: "none" | "pending" | "ready" | "unknown"; revision?: string | number | null };
const proxyStates = new Map<string, ProxyStateLike>();

async function engineFor(extra: { onUnplayable?: (u: unknown) => void } = {}) {
  const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
  return new WebAudioEngine(
    (fileId) => `/content/${fileId}`,
    1,
    (fileId) => `/proxy/${fileId}`,
    { proxyState: (fileId) => proxyStates.get(fileId) ?? "ready", ...extra },
  );
}

const warnings = () => warn.mock.calls.map((c: unknown[]) => c.map(String).join(" "));

describe("WebAudioEngine source fallback", () => {
  it("plays the proxy's audio when the original's decoder config is rejected", async () => {
    behaviour.set("/content/f-dreams", "decode-error");
    const eng = await engineFor();
    eng.setClips([clip("dreams")]);
    eng.play();
    await flush();

    expect(opened).toEqual(["/content/f-dreams", "/proxy/f-dreams"]);
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual(["/proxy/f-dreams"]);
    // One line naming the switch, not a failure per play.
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/dreams.*proxy/i);
    expect(warnings()[0]).toMatch(/Unsupported configuration/);
    eng.dispose();
  });

  it("falls back when mediabunny says up front that the track can't be decoded", async () => {
    behaviour.set("/content/f-hevc", "cannot-decode");
    const eng = await engineFor();
    eng.setClips([clip("hevc")]);
    eng.play();
    await flush();
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual(["/proxy/f-hevc"]);
    eng.dispose();
  });

  it("keeps the proxy after the switch: a later play or seek doesn't retry the original", async () => {
    behaviour.set("/content/f-dreams", "decode-error");
    const eng = await engineFor();
    eng.setClips([clip("dreams")]);
    eng.play();
    await flush();
    eng.pause();
    eng.seek(0); // back to the start, where the fake's one chunk sits
    eng.play();
    await flush();
    expect(opened).toEqual(["/content/f-dreams", "/proxy/f-dreams"]);
    expect(buffersRequested.filter((u) => u.startsWith("/content"))).toHaveLength(1);
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual(["/proxy/f-dreams", "/proxy/f-dreams"]);
    eng.dispose();
  });

  it("reports once when a proxy that should exist 404s, and doesn't ask again while nothing changed (Re-review R4)", async () => {
    behaviour.set("/content/f-mono", "decode-error");
    behaviour.set("/proxy/f-mono", "http-404"); // status "ready", file gone (e.g. evicted)
    const eng = await engineFor();
    eng.setClips([clip("mono")]);
    eng.play();
    await flush();
    for (let i = 0; i < 4; i++) {
      eng.pause();
      eng.play();
      eng.seek(1 + i);
      await flush();
    }
    expect(startedSources).toHaveLength(0);
    expect(opened).toEqual(["/content/f-mono", "/proxy/f-mono"]);
    // The switch line, then one "can't be played" line.
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]).toMatch(/mono.*can't be played/i);
    eng.dispose();
  });

  it("a file that can never have a proxy (audio-only, VPx alpha) never requests one (Re-review R4)", async () => {
    behaviour.set("/content/f-song", "decode-error");
    proxyStates.set("f-song", "none");
    const eng = await engineFor();
    eng.setClips([clip("song")]);
    eng.play();
    await flush();
    for (let i = 0; i < 4; i++) {
      eng.pause();
      eng.play();
      eng.seek(0.5 * i);
      await flush();
    }
    expect(opened).toEqual(["/content/f-song"]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/song.*can't be played/i);
    eng.dispose();
  });

  it("a proxy that is expected but not ready yet is not requested until it lands, then plays (M1, Re-review R4)", async () => {
    behaviour.set("/content/f-alac", "decode-error");
    proxyStates.set("f-alac", "pending"); // proxy job still running
    const eng = await engineFor();
    eng.setClips([clip("alac")]);
    eng.play();
    await flush();
    eng.pause();
    eng.play();
    eng.seek(0.3);
    await flush();
    expect(opened).toEqual(["/content/f-alac"]); // nothing to ask for yet
    expect(startedSources).toHaveLength(0);

    proxyStates.set("f-alac", "ready"); // the proxy landed
    eng.seek(0);
    await flush();
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual(["/proxy/f-alac"]);
    // The original is never re-opened: its decode failure is permanent.
    expect(opened).toEqual(["/content/f-alac", "/proxy/f-alac"]);
    eng.dispose();
  });

  it("a proxy that is undecodable (not a 404) is not retried", async () => {
    behaviour.set("/content/f-x", "decode-error");
    behaviour.set("/proxy/f-x", "decode-error");
    const eng = await engineFor();
    eng.setClips([clip("x")]);
    eng.play();
    await flush();
    eng.pause();
    eng.play();
    await flush();
    expect(opened).toEqual(["/content/f-x", "/proxy/f-x"]);
    eng.dispose();
  });

  it("tells its owner once when a clip can't be played at all, so the preview can say so in-app", async () => {
    behaviour.set("/content/f-song", "decode-error");
    behaviour.set("/proxy/f-song", "http-404"); // an audio file: no proxy
    const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
    const onUnplayable = vi.fn();
    const eng = new WebAudioEngine((id) => `/content/${id}`, 1, (id) => `/proxy/${id}`, { onUnplayable });
    eng.setClips([clip("song", { label: "song.m4a" })]);
    eng.play();
    await flush();
    eng.pause();
    eng.play();
    await flush();
    expect(onUnplayable).toHaveBeenCalledTimes(1);
    expect(onUnplayable).toHaveBeenCalledWith(
      expect.objectContaining({ clipId: "song", fileId: "f-song", label: "song.m4a", cause: "undecodable" }),
    );
    eng.dispose();
  });

  it("says the file couldn't be loaded — not a format problem — when the original itself is missing (M2)", async () => {
    behaviour.set("/content/f-gone", "http-404");
    behaviour.set("/proxy/f-gone", "http-404");
    const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
    const onUnplayable = vi.fn();
    const eng = new WebAudioEngine((id) => `/content/${id}`, 1, (id) => `/proxy/${id}`, { onUnplayable });
    eng.setClips([clip("gone")]);
    eng.play();
    await flush();
    expect(onUnplayable).toHaveBeenCalledTimes(1);
    expect(onUnplayable).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f-gone", cause: "unavailable" }));
    eng.dispose();
  });

  it("does not tell its owner when the proxy saved the clip", async () => {
    behaviour.set("/content/f-dreams", "decode-error");
    const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
    const onUnplayable = vi.fn();
    const eng = new WebAudioEngine((id) => `/content/${id}`, 1, (id) => `/proxy/${id}`, { onUnplayable });
    eng.setClips([clip("dreams")]);
    eng.play();
    await flush();
    expect(onUnplayable).not.toHaveBeenCalled();
    eng.dispose();
  });

  it("does not fall back on a transient fetch failure — the next play retries the original", async () => {
    behaviour.set("/content/f-net", "fetch-flake");
    const eng = await engineFor();
    eng.setClips([clip("net")]);
    eng.play();
    await flush();
    expect(opened).toEqual(["/content/f-net"]);

    behaviour.set("/content/f-net", "ok");
    eng.pause();
    eng.play();
    await flush();
    expect(opened).toEqual(["/content/f-net"]);
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual(["/content/f-net"]);
    eng.dispose();
  });

  it("a source with no audio track and no possible proxy is silent: not a failure, opens nothing else", async () => {
    behaviour.set("/content/f-silent", "no-audio");
    proxyStates.set("f-silent", "none");
    const onUnplayable = vi.fn();
    const eng = await engineFor({ onUnplayable });
    eng.setClips([clip("silent")]);
    eng.play();
    await flush();
    expect(opened).toEqual(["/content/f-silent"]);
    expect(warnings()).toHaveLength(0);
    expect(onUnplayable).not.toHaveBeenCalled();
    eng.dispose();
  });

  it("an original whose only audio track the preview can't list plays the proxy's audio (review M4)", async () => {
    // A Matroska file whose audio tracks mediabunny drops (disabled or
    // compressed): ffmpeg still sees one, and the proxy carries it as AAC.
    behaviour.set("/content/f-hidden", "no-audio");
    const eng = await engineFor();
    eng.setClips([clip("hidden")]);
    eng.play();
    await flush();
    expect(opened).toEqual(["/content/f-hidden", "/proxy/f-hidden"]);
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual(["/proxy/f-hidden"]);
    eng.dispose();
  });

  it("a silent video whose proxy is silent too stays quiet after one look at the proxy", async () => {
    behaviour.set("/content/f-mute", "no-audio");
    behaviour.set("/proxy/f-mute", "no-audio");
    const onUnplayable = vi.fn();
    const eng = await engineFor({ onUnplayable });
    eng.setClips([clip("mute")]);
    eng.play();
    await flush();
    eng.seek(1);
    await flush();
    expect(opened).toEqual(["/content/f-mute", "/proxy/f-mute"]);
    expect(onUnplayable).not.toHaveBeenCalled();
    expect(startedSources).toHaveLength(0);
    eng.dispose();
  });

  it("hands the sink the HE-AAC-repaired decoder config (2 ch, 44100 Hz)", async () => {
    const eng = await engineFor();
    eng.setClips([clip("mono-he-aac")]);
    eng.play();
    await flush();
    expect(configsRead[0]).toMatchObject({ codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 44100 });
    eng.dispose();
  });

  describe("files whose timestamps don't start at 0 (Review M6)", () => {
    it("reads the original from its own start: raw 1.5 s is source time 0", async () => {
      origins.set("/content/f-cut", 1.5); // e.g. a clip cut from a stream
      const eng = await engineFor();
      eng.setClips([clip("cut", { duration: 4 })]);
      eng.play();
      await flush();
      expect(rangesRequested[0]).toEqual(["/content/f-cut", 1.5, 5.5]);
      expect(startedSources[0].when).toBe(0); // at composition 0, not 1.5 s late
      eng.dispose();
    });

    it("the proxy fallback (ffmpeg-rebased to 0) lands at the same time as the original would", async () => {
      origins.set("/content/f-cut", 1.5);
      behaviour.set("/content/f-cut", "decode-error");
      const eng = await engineFor();
      eng.setClips([clip("cut", { duration: 4 })]);
      eng.play();
      await flush();
      expect(rangesRequested.at(-1)).toEqual(["/proxy/f-cut", 0, 4]);
      expect(startedSources.map((n) => [n.buffer?.tag, n.when])).toEqual([["/proxy/f-cut", 0]]);
      eng.dispose();
    });

    it("AAC priming (a negative first timestamp) shifts nothing", async () => {
      origins.set("/content/f-dreams", -0.161); // measured on the Dreams original
      const eng = await engineFor();
      eng.setClips([clip("dreams")]);
      eng.play();
      await flush();
      expect(rangesRequested[0]).toEqual(["/content/f-dreams", 0, 8]);
      eng.dispose();
    });
  });

  describe("a chunk that began before the playhead (a seek or play start mid-chunk)", () => {
    it("plays from the playhead's position inside the chunk, not from the chunk's start", async () => {
      // The fake source's one chunk covers source 0–0.5 s. Playing from 0.2 s
      // lands inside it. Starting it "now" from its beginning would put the
      // audio 0.2 s late against the picture.
      const eng = await engineFor();
      eng.setClips([clip("mid")]);
      eng.seek(0.2);
      eng.play();
      await flush();
      expect(startedSources).toHaveLength(1);
      expect(startedSources[0].when).toBe(0);
      expect(startedSources[0].offset).toBeCloseTo(0.2, 6);
      eng.dispose();
    });

    it("a chunk wholly in the past is not played at all", async () => {
      const eng = await engineFor();
      eng.setClips([clip("late")]);
      eng.seek(0.6); // past the fake's only chunk (0–0.5 s)
      eng.play();
      await flush();
      expect(startedSources).toHaveLength(0);
      eng.dispose();
    });
  });

  describe("a trimmed clip that hasn't started yet (Re-review R5)", () => {
    type Internal = { clips: Map<string, { gain: { gain: { value: number; events: GainEvent[] } } }> };

    it("no audio from before the trim point plays: the straddling chunk starts AT the clip start, offset to the trim point", async () => {
      // The clip starts at composition 1 s and plays source 2–4 s. The decoder's
      // first chunk begins 20 ms before source 2 s.
      straddle.set("/content/f-trim", 0.02);
      const eng = await engineFor();
      eng.setClips([clip("trim", { startTime: 1, trimStart: 2, duration: 2 })]);
      eng.play();
      await flush();
      expect(rangesRequested[0]).toEqual(["/content/f-trim", 2, 4]);
      expect(startedSources).toHaveLength(1);
      expect(startedSources[0].when).toBeCloseTo(1, 9); // the clip's start, not 0.98
      expect(startedSources[0].offset).toBeCloseTo(0.02, 9); // skips the 20 ms before the trim point
      eng.dispose();
    });

    it("the gain is 0 until the clip starts, and the first schedule never exceeds the clip's volume", async () => {
      const eng = await engineFor();
      eng.setClips([clip("quiet", { startTime: 1, volume: 0.3 })]);
      const gain = (eng as unknown as Internal).clips.get("quiet")!.gain.gain;
      expect(gain.value).toBe(0); // not the intrinsic 1 while nothing is scheduled
      eng.play();
      await flush();
      const sets = gain.events.filter((e) => e[0] !== "cancel");
      // The very first automation holds 0 from NOW (ctx 0), not from the start.
      expect(sets[0]).toEqual(["set", 0, 0]);
      expect(Math.max(...sets.map((e) => e[1]))).toBeCloseTo(0.3, 9);
      eng.dispose();
    });

    it("a clip already under way is at its volume from now on the first schedule", async () => {
      const eng = await engineFor();
      eng.setClips([clip("under", { startTime: 0, volume: 0.3 })]);
      eng.seek(1);
      eng.play();
      await flush();
      const gain = (eng as unknown as Internal).clips.get("under")!.gain.gain;
      const sets = gain.events.filter((e) => e[0] !== "cancel");
      expect(sets[0]).toEqual(["set", 0.3, 0]);
      expect(Math.max(...sets.map((e) => e[1]))).toBeCloseTo(0.3, 9);
      eng.dispose();
    });
  });

  describe("proxy revisions and files the preview can't look up (final review F1, F2)", () => {
    it("F1: a 'ready' proxy that 404'd is asked for again once it is REGENERATED (new revision), even though the status stayed 'ready'", async () => {
      behaviour.set("/content/f-regen", "decode-error");
      behaviour.set("/proxy/f-regen", "http-404"); // the list says ready, the file is gone
      proxyStates.set("f-regen", { state: "ready", revision: "2026-09-25T10:00:00Z" });
      const eng = await engineFor();
      eng.setClips([clip("regen")]);
      eng.play();
      await flush();
      for (let i = 0; i < 3; i++) { eng.seek(0.1 * i); await flush(); }
      expect(opened).toEqual(["/content/f-regen", "/proxy/f-regen"]); // no retry while nothing changed

      // Regenerated while the user wasn't playing: ready → ready, new revision.
      behaviour.set("/proxy/f-regen", "ok");
      proxyStates.set("f-regen", { state: "ready", revision: "2026-09-25T10:05:00Z" });
      eng.seek(0);
      await flush();
      expect(startedSources.map((n) => n.buffer?.tag)).toEqual(["/proxy/f-regen"]);
      expect(opened).toEqual(["/content/f-regen", "/proxy/f-regen", "/proxy/f-regen"]);
      eng.dispose();
    });

    it("F2: a file the preview can't look up ('unknown') is tried again once per play or seek, as before, and plays once its proxy lands", async () => {
      behaviour.set("/content/f-global", "decode-error");
      behaviour.set("/proxy/f-global", "http-404"); // a global-library video whose proxy is still pending
      proxyStates.set("f-global", "unknown");
      const eng = await engineFor();
      eng.setClips([clip("global")]);
      eng.play();
      await flush();
      expect(opened).toEqual(["/content/f-global", "/proxy/f-global"]);
      eng.seek(0.2);
      await flush();
      expect(opened).toEqual(["/content/f-global", "/proxy/f-global", "/proxy/f-global"]); // once per seek

      behaviour.set("/proxy/f-global", "ok"); // it landed
      eng.seek(0);
      await flush();
      expect(startedSources.map((n) => n.buffer?.tag)).toEqual(["/proxy/f-global"]);
      eng.dispose();
    });
  });

  describe("the server's timing never holds playback back (review round 2, I1)", () => {
    const API = (id: string) => `/api/files/by-id/${id}/content`;
    async function apiEngine() {
      const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
      const { clearServerTimingForTest } = await import("@/lib/engine/source-time-origin");
      clearServerTimingForTest();
      return new WebAudioEngine(API, 1, (id) => `/api/files/by-id/${id}/proxy`, { proxyState: () => "ready" });
    }
    afterEach(() => vi.unstubAllGlobals());

    it("the first read (where MPEG-TS parses an HEVC SPS) runs inside the attribution region (R3-M1)", async () => {
      firstTimestampInRegion.length = 0;
      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
      const eng = await apiEngine();
      eng.setClips([clip("ts")]);
      await flush();
      expect(firstTimestampInRegion).toEqual([true]);
      eng.dispose();
    });

    it("a failed lookup is asked again on the next play once its back-off has passed, and its answer applied (review round 3)", async () => {
      const { LOOKUP_BACKOFF_MS } = await import("@/lib/engine/source-time-origin");
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ startTime: 0.025057, audioCodecDelay: 0 })));
      vi.stubGlobal("fetch", fetchMock);
      const eng = await apiEngine();
      eng.setClips([clip("retry")]);
      eng.play();
      await flush();
      expect(rangesRequested).toEqual([[API("f-retry"), 0, 8]]); // on the fallback
      eng.pause();
      eng.play(); // too soon: not asked again
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      eng.pause();
      const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + LOOKUP_BACKOFF_MS[0] + 10);
      eng.play();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(rangesRequested.at(-1)).toEqual([API("f-retry"), 0.025057, 8.025057]);
      spy.mockRestore();
      eng.dispose();
    });

    it("a lookup that never answers: the clip plays at once, on mediabunny's own origin", async () => {
      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
      const eng = await apiEngine();
      eng.setClips([clip("hang")]);
      eng.play();
      await flush();
      expect(rangesRequested[0]).toEqual([API("f-hang"), 0, 8]);
      expect(startedSources).toHaveLength(1);
      eng.dispose();
    });

    it("an answer already in: the first schedule uses it (a LAME MP3 starting at 0.025 s)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ startTime: 0.025057, audioCodecDelay: 0 }))));
      const eng = await apiEngine();
      eng.setClips([clip("lame")]);
      await flush(); // the answer lands while the source opens
      eng.play();
      await flush();
      expect(rangesRequested).toEqual([[API("f-lame"), 0.025057, 8.025057]]);
      eng.dispose();
    });

    it("a late answer that moves nothing reschedules nothing (review round 4: no dropout)", async () => {
      let answer!: (r: Response) => void;
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { answer = r; })));
      const eng = await apiEngine();
      eng.setClips([clip("same")]);
      eng.play();
      await flush();
      expect(rangesRequested).toEqual([[API("f-same"), 0, 8]]);
      const started = startedSources.length;
      // AAC: an Opus-only field (the lead, the CodecDelay flag) and the same origin.
      answer(new Response(JSON.stringify({ startTime: 0, audioCodecDelay: 0, audioStart: 0.343 })));
      await flush();
      expect(rangesRequested).toEqual([[API("f-same"), 0, 8]]);
      expect(startedSources.length).toBe(started);
      eng.dispose();
    });

    it("an answer that lands after play: the clip is rescheduled once, from now, on the new origin", async () => {
      let answer!: (r: Response) => void;
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { answer = r; })));
      const eng = await apiEngine();
      eng.setClips([clip("late")]);
      eng.play();
      await flush();
      expect(rangesRequested).toEqual([[API("f-late"), 0, 8]]);
      answer(new Response(JSON.stringify({ startTime: 0.025057, audioCodecDelay: 0 })));
      await flush();
      expect(rangesRequested).toEqual([[API("f-late"), 0, 8], [API("f-late"), 0.025057, 8.025057]]);
      eng.dispose();
    });
  });
});


/**
 * Review round 4: an original the preview misreads WITHOUT failing plays the
 * proxy's audio, never silence. mediabunny reads a chained Ogg's first stream
 * and stops (silence after it), and lists no track for FLAC in Ogg; the
 * server says so (`preferProxyAudio`, lib/ffmpeg/audio-preview.ts) and such
 * an audio file gets an AAC proxy (proxy-gen.ts).
 */
describe("an original the preview misreads without failing plays the proxy's audio (review round 4)", () => {
  const API = (id: string) => `/api/files/by-id/${id}/content`;
  const PROXY = (id: string) => `/api/files/by-id/${id}/proxy`;
  async function apiEngine() {
    const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
    const { clearServerTimingForTest } = await import("@/lib/engine/source-time-origin");
    clearServerTimingForTest();
    return new WebAudioEngine(API, 1, PROXY, { proxyState: (fileId) => proxyStates.get(fileId) ?? "ready" });
  }
  const timing = (extra: Record<string, unknown>) =>
    vi.fn(async () => new Response(JSON.stringify({ startTime: 0, audioCodecDelay: 0, audioStart: 0, ...extra })));
  afterEach(() => vi.unstubAllGlobals());

  it("a chained Ogg whose proxy is ready: the proxy plays, from the first schedule", async () => {
    vi.stubGlobal("fetch", timing({ preferProxyAudio: true }));
    const eng = await apiEngine();
    eng.setClips([clip("chain")]);
    await flush(); // the answer lands while the original opens
    eng.play();
    await flush();
    expect(opened).toEqual([API("f-chain"), PROXY("f-chain")]);
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual([PROXY("f-chain")]);
    eng.dispose();
  });

  it("the answer lands after play: the clip moves to the proxy then, from now", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    const eng = await apiEngine();
    eng.setClips([clip("late-chain")]);
    eng.play();
    await flush();
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual([API("f-late-chain")]);
    answer(new Response(JSON.stringify({ startTime: 0, audioCodecDelay: 0, preferProxyAudio: true })));
    await flush();
    expect(opened).toEqual([API("f-late-chain"), PROXY("f-late-chain")]);
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual([API("f-late-chain"), PROXY("f-late-chain")]);
    eng.dispose();
  });

  it("its proxy still being made: the original plays until it lands, then the proxy", async () => {
    proxyStates.set("f-making", "pending");
    vi.stubGlobal("fetch", timing({ preferProxyAudio: true }));
    const eng = await apiEngine();
    eng.setClips([clip("making")]);
    await flush();
    eng.play();
    await flush();
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual([API("f-making")]);
    proxyStates.set("f-making", "ready");
    eng.seek(0);
    await flush();
    expect(opened).toEqual([API("f-making"), PROXY("f-making")]);
    expect(startedSources.map((n) => n.buffer?.tag).at(-1)).toBe(PROXY("f-making"));
    eng.dispose();
  });

  it("FLAC in Ogg (no listed track), an audio file whose proxy isn't made yet: silent, then the proxy once it is", async () => {
    behaviour.set(API("f-oggflac"), "no-audio");
    proxyStates.set("f-oggflac", "none"); // an audio file before its proxy job runs
    vi.stubGlobal("fetch", timing({ preferProxyAudio: true }));
    const eng = await apiEngine();
    eng.setClips([clip("oggflac")]);
    eng.play();
    await flush();
    expect(opened).toEqual([API("f-oggflac")]);
    expect(startedSources).toHaveLength(0);
    proxyStates.set("f-oggflac", "ready");
    eng.seek(0);
    await flush();
    expect(opened).toEqual([API("f-oggflac"), PROXY("f-oggflac")]);
    expect(startedSources.map((n) => n.buffer?.tag)).toEqual([PROXY("f-oggflac")]);
    eng.dispose();
  });

  it("an ordinary file is never moved off its original", async () => {
    vi.stubGlobal("fetch", timing({ preferProxyAudio: false }));
    const eng = await apiEngine();
    eng.setClips([clip("plain")]);
    await flush();
    eng.play();
    await flush();
    expect(opened).toEqual([API("f-plain")]);
    eng.dispose();
  });
});
