/**
 * Where a media file's source time 0 sits on the raw packet timestamps
 * mediabunny reports.
 *
 * libi measures source time from the file's start as ffmpeg defines it (its
 * `format.start_time`). The ffmpeg CLI rebases every input by it, so `-ss`,
 * the export mix's `atrim` and every proxy count from the first decoded
 * sample. mediabunny reports RAW timestamps on the same timeline as ffmpeg's
 * packets, but ignores the encoder delay that gapless metadata declares and
 * ffmpeg skips:
 * - an MP3's LAME header (576 + 529 samples: the file starts at 0.025 s);
 * - an Apple AAC file's iTunSMPB tag (2112 samples);
 * - a Matroska track's CodecDelay, which ffmpeg subtracts from that track's
 *   timestamps (see `audioTimelineShift`).
 * Reading from mediabunny's first timestamp played those 25 ms / 47.9 ms /
 * 23-25 ms late against ffmpeg's decode and the export (Electron 36,
 * 2026-09-25). A file cut from a stream starts at 1.5 s, which reading raw
 * would play 1.5 s late (Review M6).
 *
 * So for a file served from `/api/files/by-id/<id>/content` the server says,
 * via `/timing`: ffprobe's `start_time`, and the primary audio track's
 * Matroska CodecDelay. Both come from the file's own metadata, as ffmpeg reads
 * it. Nothing is inferred from comparing the two demuxers' first packets:
 * on an MP4 stream-copied at a non-keyframe (libi's own `trim_video`),
 * mediabunny lists pre-roll packets the edit list hides from ffmpeg, and that
 * comparison put the audio 302 ms late (review round 2, C1).
 *
 * The lookup never delays playback (review I1): it starts before the file is
 * opened, a source uses `fallbackOrigin` until the answer arrives, and
 * applies it then, however late it comes (up to `LOOKUP_TIMEOUT_MS`). A
 * lookup that fails (a network error, a 5xx such as a probe that timed out,
 * or no answer in time) is not the last word: the next play or seek asks
 * again (`retryServerTiming`) once its back-off has passed, up to
 * `MAX_LOOKUP_ATTEMPTS` per file per page (review round 3). A 404 or other
 * 4xx is final. The fallback is the file's first timestamp, clamped at
 * 0 so AAC priming (a negative first timestamp behind an edit list) shifts
 * nothing: -0.161 s on the Dreams original, -0.023 s on its proxy. A proxy
 * (made by ffmpeg, starting at 0) and any other URL only ever use it.
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */

export interface ServerTiming {
  /** ffprobe `format.start_time`; null when ffprobe reports none (WAV). */
  startTime: number | null;
  /** The primary audio track's Matroska CodecDelay in seconds; 0 elsewhere. */
  audioCodecDelay: number;
  /** Matroska: that priming exact (whole ms in `audioCodecDelay`); 0 or absent: none known (packet-grid.ts). */
  audioPadding?: number;
  /**
   * The primary audio stream's first decoded sample, in seconds from the
   * file's start, unclamped (ffprobe's stream `start_time` − `startTime`);
   * null when unknown. Places an Opus track that starts after its file and an
   * Ogg stream whose granules don't start at 0 (opus-seek.ts, ogg-timeline.ts).
   */
  audioStart: number | null;
  /** Ogg only: the primary audio stream's first packet, seconds from the file's start (ogg-timeline.ts). */
  oggFirstPacket: number | null;
  /** Its duration (0 when unknown). */
  oggFirstPacketDuration: number;
  /**
   * Opus in Matroska: the packets ffmpeg cuts short by a DiscardPadding, as
   * `[seconds after the stream's first packet, samples at 48 kHz]` (the join
   * of two encodes, the stream's end). Absent or empty: none (opus-seek.ts).
   */
  opusTrims?: ReadonlyArray<readonly [number, number]>;
  /**
   * The preview should play the proxy's audio: mediabunny misreads this
   * file's without failing (a chained Ogg, FLAC in Ogg: audio-preview.ts).
   */
  preferProxyAudio?: boolean;
}

/**
 * How long one lookup may take. Nothing interactive waits on it: a preview
 * source plays on its fallback meanwhile and takes a late answer when it
 * comes (a first compile of the route in dev can take seconds).
 */
export const LOOKUP_TIMEOUT_MS = 20_000;
/** Lookups per file per page, the first included. */
export const MAX_LOOKUP_ATTEMPTS = 3;
/** Back-off before the 2nd and the 3rd attempt, from the failure before it. */
export const LOOKUP_BACKOFF_MS = [2_000, 10_000] as const;

/** The file's first timestamp, clamped at 0; 0 when the input can't say. */
export async function fallbackOrigin(input: { getFirstTimestamp?: () => Promise<number> }): Promise<number> {
  if (typeof input.getFirstTimestamp !== "function") return 0;
  try {
    const first = await input.getFirstTimestamp();
    return Number.isFinite(first) && first > 0 ? first : 0;
  } catch {
    return 0;
  }
}

/** The origin a server answer gives, or null when it gives none. */
export function originFromTiming(timing: ServerTiming | null): number | null {
  const start = timing?.startTime;
  return typeof start === "number" && Number.isFinite(start) ? Math.max(0, start) : null;
}

/**
 * The origin, waiting for the server's answer. For the chromium-render export,
 * which must be exact and is not interactive: it gets a long timeout.
 */
export async function sourceTimeOrigin(
  input: { getFirstTimestamp?: () => Promise<number> },
  url?: string,
  fetchTiming: (url: string) => Promise<ServerTiming | null> = serverTiming,
): Promise<number> {
  if (url) {
    const fromServer = originFromTiming(await fetchTiming(url).catch(() => null));
    if (fromServer !== null) return fromServer;
  }
  return fallbackOrigin(input);
}

/**
 * How much later mediabunny stamps an audio track than ffmpeg does: add it to
 * the origin to read that track on ffmpeg's timeline. It is the Matroska
 * CodecDelay (an MP3 or AAC in MKV was 25 / 23 ms late), 0 elsewhere.
 * Opus is handled by opus-seek.ts, which places every run itself.
 */
export function audioTimelineShift(codec: string | null, timing: ServerTiming | null): number {
  if (codec === "opus" || !timing) return 0;
  const d = timing.audioCodecDelay;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

const CONTENT_URL = /^(.*\/api\/files\/by-id\/[^/?#]+)\/content(?:[?#].*)?$/;

/** The timing route for a file's content URL, or null for any other URL. */
export function timingUrlFor(url: string): string | null {
  const m = CONTENT_URL.exec(url);
  return m ? `${m[1]}/timing` : null;
}

/** `opusTrims` from the route's body: well-formed pairs only, in stream order. */
function trimsOf(v: unknown): Array<[number, number]> {
  if (!Array.isArray(v)) return [];
  const out: Array<[number, number]> = [];
  for (const e of v) {
    if (Array.isArray(e) && e.length === 2 && e.every((x) => typeof x === "number" && Number.isFinite(x)) && e[1] > 0) {
      out.push([e[0], e[1]]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Why a lookup gave no answer: `retry` may be asked again, `final` never. */
class LookupFailure extends Error {
  constructor(readonly kind: "retry" | "final") {
    super(kind);
  }
}

interface Lookup {
  /** The current attempt; resolves with the answer or null. */
  promise: Promise<ServerTiming | null>;
  attempts: number;
  /** When the current attempt failed (null while pending, or once answered). */
  failedAt: number | null;
  /** A 4xx: never asked again. */
  final: boolean;
}

/** Per page: one lookup per file, shared by its sources. */
const lookups = new Map<string, Lookup>();

function attempt(endpoint: string, entry: Lookup, timeoutMs: number): Promise<ServerTiming | null> {
  entry.attempts++;
  entry.failedAt = null;
  return (async () => {
    let res: Response;
    try {
      res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new LookupFailure("retry");
    }
    if (!res.ok) throw new LookupFailure(res.status >= 400 && res.status < 500 ? "final" : "retry");
    const body = (await res.json()) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      startTime: num(body.startTime),
      audioCodecDelay: num(body.audioCodecDelay) ?? 0,
      audioPadding: num(body.audioPadding) ?? 0,
      audioStart: num(body.audioStart),
      oggFirstPacket: num(body.oggFirstPacket),
      oggFirstPacketDuration: num(body.oggFirstPacketDuration) ?? 0,
      opusTrims: trimsOf(body.opusTrims),
      preferProxyAudio: body.preferProxyAudio === true,
    };
  })().catch((err: unknown) => {
    entry.failedAt = Date.now();
    // Only a 4xx is final. Anything else (the body timing out mid-read, a body
    // that isn't JSON, a network error) may be asked again (review round 4).
    if (err instanceof LookupFailure && err.kind === "final") entry.final = true;
    return null;
  });
}

/**
 * The file's timing from the server, or null when it can't say (yet). The
 * first call starts the lookup; later calls share it, a failed one included:
 * only `retryServerTiming` asks again.
 */
export function serverTiming(url: string, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<ServerTiming | null> {
  const endpoint = timingUrlFor(url);
  if (!endpoint || typeof fetch !== "function") return Promise.resolve(null);
  let entry = lookups.get(endpoint);
  if (!entry) {
    entry = { promise: Promise.resolve(null), attempts: 0, failedAt: null, final: false };
    entry.promise = attempt(endpoint, entry, timeoutMs);
    lookups.set(endpoint, entry);
  }
  return entry.promise;
}

/**
 * Ask again for a file whose lookup failed, when its back-off has passed and
 * it has attempts left: the new attempt's promise, or null when there is
 * nothing to do (answered, still pending, final, too soon, or out of
 * attempts). The engines call it on play and seek, and never wait on it.
 */
export function retryServerTiming(url: string, now = Date.now(), timeoutMs = LOOKUP_TIMEOUT_MS): Promise<ServerTiming | null> | null {
  const endpoint = timingUrlFor(url);
  const entry = endpoint ? lookups.get(endpoint) : undefined;
  if (!endpoint || !entry || entry.final || entry.failedAt === null) return null;
  if (entry.attempts >= MAX_LOOKUP_ATTEMPTS) return null;
  const wait = LOOKUP_BACKOFF_MS[Math.min(entry.attempts - 1, LOOKUP_BACKOFF_MS.length - 1)];
  if (now - entry.failedAt < wait) return null;
  entry.promise = attempt(endpoint, entry, timeoutMs);
  return entry.promise;
}

/** Test hook. */
export function clearServerTimingForTest(): void {
  lookups.clear();
}

/** Settled value of `p` if it has already settled, else `pending`. */
export async function ifSettled<T, P>(p: Promise<T>, pending: P): Promise<T | P> {
  const marker = {};
  const v = await Promise.race([p, Promise.resolve(marker)]);
  return v === marker ? pending : (v as T);
}
