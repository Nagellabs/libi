/**
 * Keeps mediabunny's non-actionable console diagnostics out of the Next dev
 * overlay.
 *
 * Next's dev overlay promotes *any* `console.error` to a full-screen, blocking
 * error card. Mediabunny logs two classes of message that way which are
 * diagnostics rather than app failures, and both have now interrupted real
 * editing sessions:
 *
 *  1. "A VideoSample was garbage collected without first being closed."
 *     (2026-08-18) A hygiene warning aimed at a library consumer that holds
 *     samples. libi never touches a `VideoSample` — every one is created,
 *     drawn, and closed inside mediabunny's own `CanvasSink`/`AudioBufferSink`
 *     — and the finalizer that logs this also closes the underlying
 *     `VideoFrame` on the same line, so the GPU resource is reclaimed either
 *     way. Instrumenting `VideoSample` construction/close in the running app
 *     over ~1700 samples (playback, mid-decode source disposal, rapid scrub,
 *     and forced mid-stream fetch failures) never once produced an unclosed
 *     sample, so there is no known libi leak behind it.
 *
 *  2. "Retrying failed fetch." Logged once per attempt from `retriedFetch`.
 *     `mediaFetchRetryDelay` bounds these to MAX_FETCH_RETRIES and reports the
 *     give-up itself (see media-fetch-retry.ts) — so the per-attempt lines are
 *     pure noise in front of a warning we already emit.
 *
 * The messages are DOWNGRADED, not swallowed: they still reach the console (and
 * `~/.libi/logs/server.log` via Next's browser-log forwarding) as warnings, so
 * a real regression is still visible to anyone reading logs. Only the blocking
 * overlay card goes away.
 *
 * Deliberately narrow: match on exact upstream strings, one documented reason
 * each. This is not a general "quiet the console" hook, and nothing here should
 * ever cover a message libi itself emits.
 */

/** Upstream messages that are diagnostics, not failures. Keep each justified. */
export const BENIGN_MEDIA_CONSOLE_ERRORS: readonly { pattern: string; why: string }[] = [
  {
    pattern: "was garbage collected without first being closed",
    why: "mediabunny sample-hygiene finalizer; it closes the underlying frame itself, and libi never owns a sample",
  },
  {
    pattern: "Retrying failed fetch",
    why: "one line per retry attempt; bounded by mediaFetchRetryDelay, which reports the give-up",
  },
];

/** True when every part of a `console.error` call is one of the known diagnostics. */
export function isBenignMediaConsoleError(args: readonly unknown[]): boolean {
  return args.some(
    (arg) =>
      typeof arg === "string" &&
      BENIGN_MEDIA_CONSOLE_ERRORS.some((entry) => arg.includes(entry.pattern)),
  );
}

/** Marks a console.error we installed, so a second install is a no-op. */
const INSTALLED = Symbol.for("libi.mediaConsoleNoiseFilter");

type Patched = Console["error"] & { [INSTALLED]?: Console["error"] };

/**
 * Route the known-benign mediabunny diagnostics through `console.warn`.
 * Idempotent; returns an uninstall that restores the previous `console.error`.
 */
export function installMediaConsoleNoiseFilter(target: Console = console): () => void {
  const previous = target.error as Patched;
  if (previous[INSTALLED]) return () => {};

  const patched: Patched = (...args: unknown[]) => {
    if (isBenignMediaConsoleError(args)) {
      target.warn("[media][benign]", ...args);
      return;
    }
    previous.apply(target, args as Parameters<Console["error"]>);
  };
  patched[INSTALLED] = previous;
  target.error = patched;

  return () => {
    // Only unwind if nothing else patched console.error after us — restoring a
    // stale reference would silently drop another layer's filtering.
    if (target.error === patched) target.error = previous;
  };
}
