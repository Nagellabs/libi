/**
 * Why a preview video source could not load, and whether trying again can help.
 *
 * `MediaBunnyFrameSource` used to have no notion of "this will never work": an
 * init that rejected stayed rejected, every pump restart re-awaited it and
 * printed `decode pump failed`, and the readiness gate waited on a source that
 * could never become ready — so a clip whose proxy answered 400 put the player
 * on "Buffering…" every few seconds, forever, with hundreds of log lines per
 * piece (docs-local/qa/2026-09-25-video-download-and-playback-plan.md T3).
 *
 *   PERMANENT — the same request will fail the same way: an HTTP 4xx (except
 *     408/425/429), a container mediabunny can't demux, no video track, a codec
 *     this browser can't decode, a WebCodecs decoder rejection. The source
 *     falls back from the proxy to the original ONCE, then gives up and the
 *     preview draws a "can't be played" placeholder on the overlay's rect.
 *   TRANSIENT — the server or network may come back: 5xx, 408/425/429, a fetch
 *     that threw (mediabunny's own bounded retries already ran,
 *     `media-fetch-retry.ts`), and anything unrecognised. Retried on the bounded
 *     backoff below; when that runs out the source is failed too, so the gate
 *     can never hang — and a later user seek gives it one fresh try.
 */

export type MediaFailureKind = "permanent" | "transient";

/** libi's own verdict that a loaded file can't be shown (no video track, a
 *  codec the browser can't decode). Always permanent. */
export class UnplayableMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnplayableMediaError";
  }
}

/** Backoff before each transient retry, in seconds (~7.5 s of waiting in all).
 *  Short for the same reason as media-fetch-retry.ts: a source that is waiting
 *  is a frozen picture, and a user seek retries anyway. */
export const TRANSIENT_RETRY_DELAYS_SEC: readonly number[] = [0.5, 1, 2, 4];

/** HTTP statuses in the 4xx range that ARE worth retrying. */
const RETRYABLE_4XX = new Set([408, 425, 429]);

/** DOMException names a WebCodecs decoder / demuxer raises for data it will
 *  never accept. `EncodingError` can occasionally be a transient GPU/decoder
 *  fault rather than bad data; it is still called permanent (one fallback,
 *  then the placeholder) — a remount builds a fresh source and clears it. */
const PERMANENT_DOM_NAMES = new Set(["EncodingError", "NotSupportedError", "DataError"]);

/** mediabunny's UrlSource message for a non-ok response:
 *  `Error fetching <url>: <status> <statusText>`. */
const HTTP_STATUS_RE = /Error fetching .*: (\d{3})\b/;

/** mediabunny's `UnsupportedInputFormatError` default message. (Its 1.40
 *  "must surface Content-Length" and "did not respond with 206" failures are
 *  gone since 1.42: `UrlSource` reads such responses sequentially instead.) */
const PERMANENT_MESSAGE_RES = [
  /unsupported or unrecognizable format/i,
  // mediabunny can't build the decoder config of an HEVC/AVC stream it can't
  // parse (an MPEG-TS whose SPS its parser rejects: the Dreams original
  // remuxed to TS). The file won't open for any track, the same on every
  // attempt, so play the proxy instead of retrying.
  /could not extract (HVC|AVC)DecoderConfigurationRecord/i,
];

/** The HTTP status of a mediabunny fetch failure, or null when `err` isn't one. */
export function httpStatusOf(err: unknown): number | null {
  const m = HTTP_STATUS_RE.exec(mediaErrorMessage(err));
  return m ? Number(m[1]) : null;
}

export function classifyMediaLoadError(err: unknown): MediaFailureKind {
  if (err instanceof UnplayableMediaError) return "permanent";
  const name = (err as { name?: unknown } | null)?.name;
  if (typeof name === "string" && PERMANENT_DOM_NAMES.has(name)) return "permanent";
  const message = mediaErrorMessage(err);
  const http = HTTP_STATUS_RE.exec(message);
  if (http) {
    const status = Number(http[1]);
    if (status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) return "permanent";
    return "transient";
  }
  if (PERMANENT_MESSAGE_RES.some((re) => re.test(message))) return "permanent";
  return "transient";
}

/** A loggable one-line message for whatever was thrown. */
export function mediaErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}
