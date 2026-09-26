/**
 * The host side of the overlay sandbox (spec §4.1, §4.7 as amended by A1, §4.9).
 * Owns one supervisor frame, the nonce that authenticates it, the port the
 * supervisor transfers per worker generation, the per-overlay request ids and
 * the watchdog. Transport-agnostic on the iframe leg: the real one lives in
 * `iframe-transport.ts`, the dev-only in-origin one in `in-origin-transport.ts`,
 * and tests inject a fake.
 *
 * Two legs:
 *  - iframe channel — `restart` / `ping` down, `ready` (with the port),
 *    `pong` and `supervisorError` up. A reply counts only from the transport's
 *    `peer` (the iframe's contentWindow) with THIS nonce.
 *  - the MessagePort — `load` / `render` / `dispose` down, `loaded` / `started`
 *    / `layer` / `error` / `unattributed` up. Private to the host; every message
 *    up must echo the nonce.
 *
 * Recovery: the watchdog never destroys the frame (Chromium would not reclaim a
 * wedged sandboxed-frame process — spike round 1). It posts `restart` to the
 * supervisor, whose thread never runs a body; the next `ready` brings a fresh
 * worker and port, and the host replays its source cache.
 */
import {
  FIT_CACHE_SIZE,
  IDLE_LAYER_MS,
  contentFitKeys,
  clampRenderGeometry,
  parseRuntimeMessage,
  parseSupervisorReply,
  type ErrorMessage,
  type FontPayload,
  type HostMessage,
  type LayerMessage,
  type LoadMessage,
  type RenderMessage,
  type RuntimeMessage,
  type SupervisorCommand,
  type UnattributedMessage,
} from "./protocol";

export const LOAD_TIMEOUT_MS = 5000;
/**
 * Watchdog allowance for each content fit a render measures beyond its first
 * (`renderBudget`): the other end and the midpoints of a keyframed-size
 * segment, and the frame's exact size where the tween still bends at full
 * depth (`fitPathSizes`: at most 3 + FIT_SUBDIVISION_DEPTH = 6 fits a frame).
 * One probe costs at most one call + max(4 calls, PROBE_BUDGET_MS) — under
 * 2.84 s for any body under the 0.567 s a call that fits a first render at
 * all — so 3 s keeps a tween's first frame no tighter than a static first
 * render. Worst case, 6 fits: 5 s + 5 × 3 s = 20 s before a wedge is caught.
 */
export const PROBE_EXTRA_BUDGET_MS = 3000;
export const RENDER_TIMEOUT_MS = 2000;
/**
 * The floor between two restarts asked for by a BOOT failure (a
 * `supervisorError` with no live worker). A worker that will not construct —
 * a CSP refusal, a syntax error in the bundle — fails again instantly, so
 * without this floor the host and the supervisor would spin as fast as
 * postMessage allows. The watchdog's own restarts need no floor: they are
 * already rate-limited by the 2 s / 5 s timeouts that produce them.
 */
export const RESTART_BACKOFF_MS = 2000;
/**
 * Two restarts for a wedge nothing announced (see `expire`), with the same
 * suspect, inside this window, and the suspect is dropped.
 */
export const REPEAT_WEDGE_WINDOW_MS = 60_000;
/** What the host says when a render never started: nothing is dropped, and no
 *  overlay is named — the one the watchdog was timing is not the cause. */
export const UNSTARTED_WEDGE_MESSAGE =
  "the overlay runtime stopped answering between renders: work a body left running after it returned, through a callback the runtime cannot attribute (an event listener such as a FileReader's, a WebCodecs output or error callback, the settlement of a browser promise such as createImageBitmap, a module imported from a blob: URL), blocked it. The worker was restarted and nothing was dropped";
/** The diagnostic a suspect gets when it is dropped for a repeated wedge. */
export const KEEPS_BLOCKING_MESSAGE =
  "this body keeps blocking the overlay runtime after it returns: work it leaves running never finishes, so the worker had to be restarted twice within 60 s. It is stopped until its source changes";
/**
 * The stall breaker (Task 13 fix round 4, NEW-1; decaying since Task 14, M4).
 * Without it a wedge the host cannot pin on the body it holds — a superseded
 * version's, an unannounced one whose suspect keeps changing — could restart
 * the worker forever, stalling every overlay.
 *
 * It keeps a restart SCORE: every restart that drops nobody adds 1, the score
 * halves every `STALL_HALF_LIFE_MS`, and the restart that brings it to
 * `STALL_SCORE_LIMIT` trips the breaker (see `restartWithoutDrop`). A fixed
 * window (it was 3 inside 30 s) let any loop slower than one restart per 15 s
 * run forever. With a 2 min half-life and a limit of 2.5:
 *  - two restarts never trip it, however close (1 + at most 1 < 2.5);
 *  - three in quick succession do — evenly spaced, up to ~34 s apart;
 *  - a steady loop of period P settles at 1 / (1 - 2^(-P / 2 min)), so every
 *    loop with P up to ~88 s trips it, the slowest after a few minutes;
 *  - restarts minutes apart decay away and never add up.
 * A loop slower than ~88 s still runs, one stall per cycle: no decaying score
 * with a fixed limit catches every period, and a count that never decays
 * would drop someone for three unrelated stalls across a long session.
 */
export const STALL_SCORE_LIMIT = 2.5;
export const STALL_HALF_LIFE_MS = 120_000;
/** Evidence older than this many half-lives (1/8 of its weight) is let go:
 *  a stall from minutes ago names who was open THEN. */
const STALL_EVIDENCE_HALF_LIVES = 3;

/** `score`, `elapsedMs` later. */
export function decayStallScore(score: number, elapsedMs: number): number {
  return score * Math.pow(2, -Math.max(0, elapsedMs) / STALL_HALF_LIFE_MS);
}

/** What each overlay the stall breaker stops is told. */
export const PREVIEW_KEPT_STALLING_MESSAGE =
  "the preview kept stalling: the overlay runtime had to be restarted again and again (three times in quick succession, or repeatedly over a few minutes) without any single overlay being proven at fault, and this body was the likeliest cause. It is stopped until its source changes";
/** The breaker tripped, but every overlay it could name is already gone. */
export const PREVIEW_KEPT_STALLING_UNNAMED_MESSAGE =
  "the preview kept stalling: the overlay runtime had to be restarted again and again, each time by an overlay that has since been removed or replaced. Nothing on screen was stopped";

/**
 * The host-side message budget, per port generation (final security review,
 * I1). Everything in the worker realm can be patched by a body — its own rate
 * limits included — so the bound that holds is the one the HOST enforces, in
 * the port handler, before a message is deserialized or parsed. A port past
 * any of these in one second is flooding the studio's main thread: its worker
 * is restarted as a wedge (`flood`), and the queue behind it is discarded
 * with the port.
 *
 * Legit traffic sits far below: one render per overlay in flight (a `started`
 * and an answer each), an `async` pair per change of owner, diagnostics the
 * worker already limits to one a second per overlay.
 */
export const PORT_MESSAGES_PER_SECOND = 10_000;
/** Characters of text (every top-level string of every message) per second. */
export const PORT_CHARS_PER_SECOND = 4_000_000;
/** One message's text. The wire caps `message` at 2000 and `stack` at 8000,
 *  but a body that patched `String.prototype.slice` defeats the worker's own
 *  truncation: past this the message is dropped unparsed. */
export const MAX_PORT_MESSAGE_CHARS = 12_000;
/** `async` / `asyncDone` window switches per second (Scenario B: a body that
 *  alternates owned and unowned callbacks posts a pair per switch). */
export const PORT_ASYNC_SWITCHES_PER_SECOND = 5_000;
/** Diagnostics that answer nothing — `unattributed`, and a `render` error
 *  with no `req` (an async escape) — per second. Past the first number they
 *  are dropped before they reach React or the diagnostics store; past the
 *  second the port is flooding. */
export const PORT_DIAGNOSTICS_FORWARDED_PER_SECOND = 20;
export const PORT_DIAGNOSTICS_PER_SECOND = 200;
const PORT_BUDGET_WINDOW_MS = 1000;
/** What a port's flood is reported as; the reason names the budget. */
export function floodMessage(reason: string): string {
  return `this body flooded the overlay runtime's channel to the studio (${reason} in one second), which would have stalled the editor. The worker was restarted`;
}

/**
 * Liveness of the supervisor FRAME (final security review, I3). The watchdog
 * restarts a wedged WORKER through the supervisor, whose thread never runs a
 * body; so a frame that sends no `ready` and answers no `ping` is not wedged
 * but dead — its renderer process crashed (a body's out-of-memory in a
 * dedicated worker takes its whole process down), or the frame never loaded.
 * Nothing in it can be restarted, so the host tears the iframe down and mounts
 * a fresh one, which gets a fresh process, and replays its source cache.
 *  - `FRAME_LOAD_TIMEOUT_MS`: a frame whose document is still LOADING (the
 *    transport reports its `load`, re-review R-M4) is not dead — a cold dev
 *    compile of the runtime page plus its esbuild bundle, or a first esbuild
 *    spawn under a virus scanner, is slow, and the supervisor cannot answer a
 *    ping before its script has run. Only past this generous outer deadline
 *    is a frame that never loaded probed, and replaced;
 *  - `FRAME_BOOT_TIMEOUT_MS`: once the document has loaded (or at mount, for
 *    a transport with no load to report) the frame must say `ready` within
 *    this. The supervisor posts `ready` from its script, so this is slack;
 *  - `RESTART_READY_TIMEOUT_MS`: a frame asked to `restart` answers in one
 *    task — past this the host pings it;
 *  - `PING_TIMEOUT_MS`: a ping unanswered this long is CONFIRMED with a
 *    second one before the frame is called dead (R-M5): a host main thread
 *    blocked past the first deadline can run its timer ahead of a `pong`
 *    already queued, and a live frame must not be replaced for that. The
 *    second deadline starts after the host has its thread back;
 *  - at most `MAX_FRAME_REMOUNTS` inside `FRAME_REMOUNT_WINDOW_MS`: the next
 *    death after that is final, and the host says so once
 *    (`FRAME_LOST_MESSAGE`). A frame that never loads dies every ~64 s
 *    (load deadline plus two pings), so four of those fit in the window and it
 *    is still given up on — after about four minutes.
 */
export const FRAME_LOAD_TIMEOUT_MS = 60_000;
export const FRAME_BOOT_TIMEOUT_MS = 15_000;
export const RESTART_READY_TIMEOUT_MS = 3_000;
export const PING_TIMEOUT_MS = 2_000;
export const MAX_FRAME_REMOUNTS = 3;
export const FRAME_REMOUNT_WINDOW_MS = 5 * 60_000;
export const FRAME_LOST_MESSAGE = `the overlay runtime's frame kept dying: it sent no ready and answered no ping ${MAX_FRAME_REMOUNTS + 1} times within ${FRAME_REMOUNT_WINDOW_MS / 60_000} minutes, and was replaced after each of the first ${MAX_FRAME_REMOUNTS}. Code, three and tracked-code overlays are not rendering. A body that exhausts memory can do this. Reopen the editor to try again`;
/** The lost-frame text for a sandbox that replaces NO dead frame
 *  (`maxFrameRemounts: 0` — the export's, re-review 2 R2-M1): the first death
 *  is final, and the count in `FRAME_LOST_MESSAGE` would be false. This is
 *  the text when the host has NO suspect — the frame died with no restart
 *  in flight that an overlay caused (at boot, say) — so running the export
 *  again is the one thing left to suggest. With a suspect it is
 *  `frameDiedMessage`. */
export const FRAME_DIED_MESSAGE = `the overlay runtime's frame died during the export: it sent no ready and answered no ping. An export does not replace it, so the export stops rather than finish with its code, three and tracked-code overlays missing. Export again to retry`;

/** How an overlay is named to the user in a message the HOST writes. */
function describeOverlay(overlay: { id: string; kind?: LoadInput["kind"] }): string {
  const kind = overlay.kind === "tracked" ? "tracked-code" : overlay.kind;
  return `the ${kind ? `${kind} ` : ""}overlay "${overlay.id}"`;
}

/**
 * `FRAME_DIED_MESSAGE` when the host knows which overlay the frame was
 * recovering from (sandbox re-review 3, R3-M2): the frame died while the
 * worker was being restarted because that overlay's body stopped answering,
 * or was the suspect of a wedge. That is what a body exhausting memory looks
 * like — it takes the frame's renderer process down with it — and exporting
 * the same piece again fails the same way every time. So it names the overlay,
 * and says to fix or remove its code instead of "export again".
 */
export function frameDiedMessage(suspect: { id: string; kind?: LoadInput["kind"] }): string {
  const who = describeOverlay(suspect);
  return `the overlay runtime's frame died during the export, while the runtime was restarting because ${who} had stopped answering: the frame sent no ready and answered no ping. That overlay's code most likely used too much memory or crashed the runtime. Fix or remove that overlay's code; exporting it unchanged fails the same way. An export does not replace a dead frame, so it stops rather than finish with its code, three and tracked-code overlays missing`;
}
/**
 * The failure of a sandbox held to `workerRestartTimeoutMs` (the export's,
 * sandbox re-review 3 R3-M3) when a worker restart was asked for and no fresh
 * worker said `ready` in time, while the frame itself kept answering pings —
 * so it is not a frame death, and before this the export went on to finish
 * with every body listed as dropped. Named like `frameDiedMessage` when the
 * host knows which overlay the restart was for.
 */
export function workerNotRestartedMessage(afterMs: number, suspect: { id: string; kind?: LoadInput["kind"] } | null): string {
  const s = Math.round(afterMs / 1000);
  const tail = "An export does not wait any longer, so it stops rather than finish with its code, three and tracked-code overlays missing";
  if (!suspect) {
    return `the overlay runtime's worker did not come back during the export: its frame still answers, but no fresh worker was ready ${s} s after a restart was asked for. ${tail}. Export again to retry`;
  }
  return `the overlay runtime's worker did not come back during the export: its frame still answers, but no fresh worker was ready ${s} s after a restart was asked for because ${describeOverlay(suspect)} had stopped answering. That overlay's code most likely used too much memory or crashed the runtime. Fix or remove that overlay's code; exporting it unchanged can fail the same way. ${tail}`;
}

/**
 * A frame whose document has not LOADED after `FRAME_STARTING_NOTICE_MS` is
 * reported once (re-review 2, R2-M1), unattributed, and the report is
 * withdrawn when it loads. The 60 s load deadline still decides whether it is
 * dead; this only keeps a preview whose runtime response hangs from showing
 * nothing, with nothing said, for the ~4 minutes that takes to give up.
 */
export const FRAME_STARTING_NOTICE_MS = 20_000;
export const FRAME_STARTING_MESSAGE = `the overlay sandbox is still starting: its frame has not finished loading after ${FRAME_STARTING_NOTICE_MS / 1000} s, so code, three and tracked-code overlays show nothing yet. It is replaced if it has not loaded after ${FRAME_LOAD_TIMEOUT_MS / 1000} s`;

/** A layer bitmap bigger than the host asked for (final security review, I2):
 *  a body that resized `ctx.canvas`, or its three renderer's canvas. The body
 *  is dropped for its current source on the first one (re-review R-M3). */
export function oversizedLayerMessage(got: { width: number; height: number }, asked: { width: number; height: number }): string {
  return `the body resized its canvas: the layer came back ${got.width}×${got.height} device px, but ${asked.width}×${asked.height} was asked for. It is stopped until its source changes. Draw within the canvas you are given; never set ctx.canvas.width or height (or the three renderer's size)`;
}
/** How far a layer may exceed the size the host asked for, per axis — the
 *  worker ceils each side once. */
const LAYER_SIZE_SLACK_PX = 1;

function oversized(got: { width: number; height: number }, asked: { width: number; height: number }): boolean {
  return got.width > asked.width + LAYER_SIZE_SLACK_PX || got.height > asked.height + LAYER_SIZE_SLACK_PX;
}

export interface SandboxTransport {
  /** Post a command to the supervisor (the iframe's main thread). */
  command(msg: SupervisorCommand): void;
  /** Replies from the frame: `ready` (with a port), `pong`, `supervisorError`. */
  onReply(handler: (data: unknown, source: unknown) => void): void;
  /** Fired once the frame's document has LOADED — its one script has run, so
   *  the supervisor is up or never will be (R-M4). A transport that has no
   *  load to wait for (the in-origin one) leaves it out, and the frame is
   *  held to `FRAME_BOOT_TIMEOUT_MS` from mount. */
  onLoad?(handler: () => void): void;
  /** What a reply's `source` must equal to be trusted. */
  readonly peer: unknown;
  destroy(): void;
}

export type LoadInput = Omit<LoadMessage, "t" | "fonts">;
export type RenderInput = Omit<RenderMessage, "t" | "req">;

export interface OverlaySandboxOptions {
  createTransport(nonce: string): SandboxTransport;
  onLayer(msg: LayerMessage): void;
  onError(msg: ErrorMessage): void;
  /** A runtime diagnostic no overlay can be blamed for (protocol
   *  `unattributed`): report it, but drop and release nothing. */
  onUnattributed?(msg: UnattributedMessage): void;
  /** Fired when the watchdog gave up on an overlay and asked for a restart.
   *  `afterMs` is the budget that ran out: a render's first run after a load or
   *  at a new size gets the load budget, so the phase alone does not say.
   *  `reason`, when set, is why it was dropped when that was not a timeout (a
   *  port flood, I1) — the text to report instead of "timed out". */
  onTimeout(overlayId: string, phase: "load" | "render", afterMs: number, reason?: string): void;
  /** The supervisor frame kept dying and the host stopped remounting it
   *  (`FRAME_LOST_MESSAGE`, I3): nothing will render any more. Fired once;
   *  the same text also goes to `onUnattributed`. */
  onFrameLost?(message: string): void;
  /** The frame has not loaded after `frameStartingNoticeMs` (a message), or
   *  one that had not now has, or is gone (`null`). At most one notice is up
   *  at a time; a remount while it is up keeps it up. Unattributed: no
   *  overlay is to blame. Unset — the export's case — means no notice. */
  onFrameStarting?(message: string | null): void;
  /** Fired on every `ready` after the first — a fresh worker is up. */
  onRestart?(): void;
  /** A font set the host posted is now installed in the worker (the answer —
   *  `loaded`, or the `compile`/`build` error of a body that failed after its
   *  fonts went in — to the load that carried it). A render answered before
   *  this drew the fallback font, and a paused preview would never ask again. */
  onFontsInstalled?(): void;
  loadTimeoutMs?: number;
  renderTimeoutMs?: number;
  restartBackoffMs?: number;
  frameLoadTimeoutMs?: number;
  frameBootTimeoutMs?: number;
  restartReadyTimeoutMs?: number;
  pingTimeoutMs?: number;
  frameStartingNoticeMs?: number;
  /** Dead frames replaced inside `FRAME_REMOUNT_WINDOW_MS` before the next
   *  death is final. 0: the first death is final (`FRAME_DIED_MESSAGE`) —
   *  the export's setting (R2-M1). */
  maxFrameRemounts?: number;
  /** When set (the export's, R3-M3): a worker restart asked for after a
   *  worker had been up, with no fresh `ready` this long after, fails the
   *  sandbox like a frame death (`onFrameLost`, `workerNotRestartedMessage`)
   *  — a frame that answers every ping while its worker never comes back is
   *  otherwise never declared dead. Unset (the preview): no such deadline;
   *  the preview keeps retrying. Boot is not covered: before the first
   *  `ready` the export's own 20 s budget decides. */
  workerRestartTimeoutMs?: number;
  nonce?: () => string;
  cloneBitmap?: (b: ImageBitmap) => Promise<ImageBitmap>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * One request on the port the worker still owes an answer for, in post order.
 *
 * The worker has one thread, so its requests share one clock: a request's
 * time starts when the one before it has been answered — not when it was
 * POSTED. Timing each from its post charged it for every sibling queued ahead
 * of it: four ~800 ms bodies in one frame and the fourth "timed out after
 * 2 s", was dropped and restarted the worker (Task 12b; reproduced live 2
 * runs in 3 on SwiftShader). So only the HEAD of this queue is timed, and an
 * answer to the head re-arms the watchdog for the next.
 *
 * The worker is NOT strictly serial, though (`attachRuntime`): a render runs
 * the moment it arrives, while one id's loads queue behind each other and a
 * load that awaits fonts or a three build yields the thread. So answers can
 * come out of post order — a render queued behind an awaiting load is
 * answered first. Answers are therefore matched by id and request, never by
 * position; an answer behind the head only leaves the queue and does not touch
 * the head's clock, which keeps running on the load the worker still owes. The
 * cost is known and accepted (Task 12b ruling 4): an awaiting load at the head
 * is charged for renders the worker serves meanwhile.
 *
 * An entry stays until the worker answers it, even when the host no longer
 * waits for the answer (a superseded or disposed load, an abandoned render):
 * the worker still spends that time, and dropping the entry would start the
 * next one's clock while the worker is busy with it.
 */
interface Outstanding {
  kind: "load" | "render";
  id: string;
  /** The body the request is for: a load's own hash; a render's is the hash
   *  of the newest load posted for its id before it (`postedHashes`). */
  sourceHash: string;
  /** Renders: the request id the answer echoes. */
  req?: number;
  /** Renders: the watchdog's budget — `loadTimeoutMs` for a first render
   *  (see `renderBudget`), `renderTimeoutMs` otherwise. */
  budgetMs?: number;
  /** Renders: the device-px size of the layer the host asked for — what the
   *  answering bitmap is held to (`expectedLayerSize`, I2). */
  layer?: { width: number; height: number };
  /** Loads: a font set rode along. */
  fonts?: boolean;
  /** Renders: the worker said it is about to call the body (`started`). */
  started?: boolean;
  /** Renders: when `started` arrived, and in what order among the others —
   *  the newest started render still unanswered holds the thread. */
  startedAt?: number;
  startedSeq?: number;
}

/** What the worker last said is running on its thread, as the watchdog blames
 *  it: an `async` window (a body's timer, helper settlement or build), or a
 *  render that started and is not answered yet. */
interface Holder {
  id: string;
  sourceHash: string;
  since: number;
  budgetMs: number;
  /** `load` for work its body's own load is still waiting on — a three
   *  build's factory, and whatever the factory set running before the load
   *  answered — which is timed, and reported, as that load (N4). */
  phase: "load" | "render";
  /** The render, or the load, the holder is — when it is one. */
  entry?: Outstanding;
}

/** A restart that dropped nobody, and who it could have named — recorded for
 *  the stall breaker before the port's state is cleared. */
interface Stall {
  at: number;
  /** The fallback suspect of an unannounced wedge (`unstartedWedge`), when
   *  the host still holds that body. */
  suspect: { id: string; sourceHash: string } | null;
  /** Overlays whose `async` window, or started render, was open. */
  open: string[];
  /** The overlay whose request the watchdog was timing. */
  heads: string[];
}

interface PendingLoad {
  /** Its place in the port queue: only an answer to THIS post settles it. */
  entry: Outstanding;
  /** What was posted — a second `load` of the SAME hash joins this one. */
  sourceHash: string;
  /** Handed back to every caller that joins, so one post has one outcome. */
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function defaultNonce(): string {
  return crypto.randomUUID();
}

/**
 * The device-px size of the layer a render asks for — the SAME rule the
 * worker allocates by (`LayerEngine.render`): a 2D layer (`code`, `tracked`)
 * covers the box plus its pad, `ceil((pad.left + width + pad.right) ×
 * pixelRatio)` per axis; a three layer is its renderer's canvas at
 * `ceil(width × pixelRatio)`, and ignores any pad. At least 1 px a side.
 */
export function expectedLayerSize(
  kind: LoadInput["kind"] | undefined,
  g: Pick<RenderMessage, "size" | "pixelRatio" | "pad">,
): { width: number; height: number } {
  const pad = kind === "three" ? undefined : g.pad;
  return {
    width: Math.max(1, Math.ceil(((pad?.left ?? 0) + g.size.width + (pad?.right ?? 0)) * g.pixelRatio)),
    height: Math.max(1, Math.ceil(((pad?.top ?? 0) + g.size.height + (pad?.bottom ?? 0)) * g.pixelRatio)),
  };
}

/** The text a worker message carries — every top-level string, which is all
 *  the protocol sends up (a bitmap is not text). Bounded work: at most 32
 *  keys are looked at, and a message with more is not one the runtime sends. */
function textSize(data: unknown): number {
  if (typeof data !== "object" || data === null) return typeof data === "string" ? data.length : 0;
  let chars = 0;
  let keys = 0;
  for (const key in data) {
    if (++keys > 32) return Number.POSITIVE_INFINITY;
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === "string") chars += v.length;
  }
  return chars;
}

/** One port generation's spend in the current one-second window (I1). */
interface PortBudget {
  windowStart: number;
  messages: number;
  chars: number;
  asyncSwitches: number;
  diagnostics: number;
  /** Messages per overlay id — who the flood is charged to when nothing
   *  holds the thread. */
  byId: Map<string, number>;
}

export class OverlaySandbox {
  readonly ready: Promise<void>;
  private readyResolve: (() => void) | null = null;
  /** The current supervisor frame. Replaced only when it is DEAD (I3). */
  private transport!: SandboxTransport;
  private readonly onReply: (data: unknown, source: unknown) => void;
  /** The frame owes a `ready` (first boot, a restart, a remount). */
  private awaitingReady = false;
  /** While it does: the deadline after which the frame is pinged. */
  private readyTimer: unknown = null;
  /** Bumped on every reply the frame sends (`pong`, `ready`,
   *  `supervisorError`): a ping that saw it move was answered, however late. */
  private heardSeq = 0;
  /** When the frame was remounted, inside `FRAME_REMOUNT_WINDOW_MS`. */
  private remounts: number[] = [];
  private frameLost = false;
  /** What `loseFrame` said, fixed when the frame is lost. */
  private lostMessage: string | null = null;
  /** The overlay the restart in flight is recovering from: the one the
   *  watchdog dropped, or a wedge's suspect. Null when the restart names
   *  nobody; cleared when a fresh worker says `ready`. What an export's
   *  first-death text names (`frameDiedMessage`, R3-M2). */
  private restartSuspect: string | null = null;
  private readonly maxFrameRemounts: number;
  /** Until the current frame loads: when to post `FRAME_STARTING_MESSAGE`. */
  private startingTimer: unknown = null;
  /** `FRAME_STARTING_MESSAGE` is up, and owed a withdrawal. */
  private startingShown = false;
  private budget: PortBudget = { windowStart: 0, messages: 0, chars: 0, asyncSwitches: 0, diagnostics: 0, byId: new Map() };
  private readonly nonce: string;
  private port: MessagePort | null = null;
  private gen = 0;
  private destroyed = false;
  private reqSeq = 0;
  /** Every source the host has been asked to load — what a restart replays. */
  private readonly sources = new Map<string, LoadInput>();
  /** id → sourceHash the CURRENT worker acknowledged with `loaded`. */
  private readonly loadedHashes = new Map<string, string>();
  /**
   * id → sourceHash of the newest `load` posted on the CURRENT port — the body
   * a render posted now will run. Not `loadedHashes`: while a new load is in
   * flight the host keeps rendering (hold-last-good), and the worker, which
   * handles one id's loads in order and builds a 2D body without fonts
   * synchronously, runs those renders on the NEW body. Tagging them with the
   * acknowledged one sent a freshly written loop down the no-blame orphan
   * path: a silent restart, then a second 5 s before the badge (Task 12b
   * review I1). A load still awaiting fonts or a three build can leave such a
   * render running the old body; that body already rendered within budget,
   * so the new one is the far likelier culprit.
   */
  private readonly postedHashes = new Map<string, string>();
  /**
   * id → the versions the host sent the CURRENT port a load (or render) for
   * and has since replaced with a newer load, or disposed (fix round 4,
   * NEW-1). The only hashes an `async` window is charged to as the worker
   * names it: any other is charged to the id's newest posted body. The hash a
   * window carries is read inside the worker's shared realm, so the host does
   * not take the worker's word that a version is a superseded one.
   */
  private readonly superseded = new Map<string, Set<string>>();
  /** Restarts since the last drop that dropped nobody, oldest first, kept
   *  for `STALL_EVIDENCE_HALF_LIVES` — who the breaker could name. */
  private stalls: Stall[] = [];
  /** The decaying restart score (`STALL_HALF_LIFE_MS`), as of `stallScoreAt`. */
  private stallScore = 0;
  private stallScoreAt = 0;
  /** id → sourceHash that timed out; retried only when the hash changes. */
  private readonly dropped = new Map<string, string>();
  private readonly pendingLoads = new Map<string, PendingLoad>();
  private readonly inFlight = new Map<string, { req: number }>();
  /** id → the fit keys (`contentFitKeys`) the current worker holds for its
   *  body — a mirror of the worker's LRU, oldest first, `FIT_CACHE_SIZE`
   *  long — and when its last render was posted. What decides a render's
   *  budget (`renderBudget`). */
  private readonly warm = new Map<string, { keys: string[]; postedAt: number }>();
  /** Every request the current port owes an answer for, oldest first. */
  private queue: Outstanding[] = [];
  /** The watchdog on `queue[0]`, the only request that is timed. */
  private headTimer: unknown = null;
  /** Pings the frame owes a `pong`, by the id the `pong` echoes (R-M5). One
   *  whose deadline passed is gone: its late `pong` still counts as hearing
   *  from the frame, and pairs with nothing. */
  private pendingPings = new Map<number, { sentAt: number; resolve: (ms: number) => void; timer: unknown }>();
  private pingSeq = 0;
  private fonts: FontPayload[] = [];
  private fontsSent = false;
  /** The overlay (and body) whose render the CURRENT worker answered last —
   *  the fallback suspect when the worker wedges while it had announced
   *  nothing (`unstartedWedge`). */
  private lastAnswered: { id: string; sourceHash: string } | null = null;
  /** The `async` window the current worker opened and has not closed. */
  private openAsync: { id: string; sourceHash: string; since: number } | null = null;
  private startedSeq = 0;
  /** The suspect of the last unstarted wedge, and when it happened. */
  private lastWedge: { id: string; sourceHash: string; at: number } | null = null;
  /** A boot-failure restart already scheduled; at most one is ever pending. */
  private restartTimer: unknown = null;
  /** `workerRestartTimeoutMs`'s deadline for the restart in flight. */
  private workerRestartTimer: unknown = null;
  private readonly loadTimeoutMs: number;
  private readonly renderTimeoutMs: number;
  private readonly restartBackoffMs: number;
  private readonly frameLoadTimeoutMs: number;
  private readonly frameBootTimeoutMs: number;
  private readonly restartReadyTimeoutMs: number;
  private readonly pingTimeoutMs: number;
  private readonly frameStartingNoticeMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly cloneBitmap: (b: ImageBitmap) => Promise<ImageBitmap>;
  private readonly now: () => number;

  constructor(private readonly opts: OverlaySandboxOptions) {
    this.loadTimeoutMs = opts.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    this.renderTimeoutMs = opts.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
    this.restartBackoffMs = opts.restartBackoffMs ?? RESTART_BACKOFF_MS;
    this.frameLoadTimeoutMs = opts.frameLoadTimeoutMs ?? FRAME_LOAD_TIMEOUT_MS;
    this.frameBootTimeoutMs = opts.frameBootTimeoutMs ?? FRAME_BOOT_TIMEOUT_MS;
    this.restartReadyTimeoutMs = opts.restartReadyTimeoutMs ?? RESTART_READY_TIMEOUT_MS;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? PING_TIMEOUT_MS;
    this.frameStartingNoticeMs = opts.frameStartingNoticeMs ?? FRAME_STARTING_NOTICE_MS;
    this.maxFrameRemounts = opts.maxFrameRemounts ?? MAX_FRAME_REMOUNTS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.cloneBitmap = opts.cloneBitmap ?? ((b) => createImageBitmap(b));
    this.now = opts.now ?? (() => performance.now());
    this.nonce = (opts.nonce ?? defaultNonce)();
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.onReply = (data, source) => {
      // `peer` is null until the iframe attaches and again after it is
      // removed, and `ev.source` is null for a message from a closed window —
      // without this guard those two nulls would compare equal and a stray
      // message would be trusted. A remounted frame's predecessor is a
      // different window, so nothing it sent late is trusted either.
      if (this.destroyed || this.frameLost || !this.transport.peer || source !== this.transport.peer) return;
      const msg = parseSupervisorReply(data);
      if (!msg || msg.nonce !== this.nonce) return;
      this.heard();
      if (msg.t === "pong") {
        // Matched by the id it echoes, never by position: a ping the frame
        // never saw (it was still loading) left no answer to pair with.
        const waiting = msg.id === undefined ? undefined : this.pendingPings.get(msg.id);
        if (waiting) {
          this.pendingPings.delete(msg.id!);
          if (waiting.timer !== null) this.clearTimer(waiting.timer);
          waiting.resolve(this.now() - waiting.sentAt);
        }
        return;
      }
      if (msg.t === "supervisorError") {
        this.handleSupervisorError(msg.message);
        return;
      }
      this.adoptPort(msg.port);
    };
    this.mountFrame();
  }

  // ── liveness of the supervisor frame (I3) ─────────────────────────────────

  /**
   * Mount a supervisor frame and start waiting for its `ready`. A frame whose
   * document is still loading is given `frameLoadTimeoutMs` (R-M4): nothing in
   * it can answer before its script runs, so silence then is not death. Its
   * `load` starts the ordinary `frameBootTimeoutMs` wait — unless a `ready`
   * (or anything else) already arrived.
   */
  private mountFrame(): void {
    const transport = this.opts.createTransport(this.nonce);
    this.transport = transport;
    transport.onReply(this.onReply);
    if (!transport.onLoad) {
      this.awaitReady(this.frameBootTimeoutMs);
      return;
    }
    this.awaitReady(this.frameLoadTimeoutMs);
    this.armStartingNotice();
    let loaded = false;
    transport.onLoad(() => {
      if (loaded || this.transport !== transport) return;
      this.frameStarted();
      if (!this.awaitingReady || this.readyTimer === null) return;
      loaded = true;
      this.awaitReady(this.frameBootTimeoutMs);
    });
  }

  /** Say so if the frame just mounted is still loading `frameStartingNoticeMs`
   *  from now (R2-M1) — unless the notice is already up from the frame it
   *  replaced, which had not loaded either. */
  private armStartingNotice(): void {
    this.cancelStartingNotice();
    if (!this.opts.onFrameStarting || this.startingShown) return;
    this.startingTimer = this.setTimer(() => {
      this.startingTimer = null;
      if (this.destroyed || this.frameLost) return;
      this.startingShown = true;
      this.opts.onFrameStarting?.(FRAME_STARTING_MESSAGE);
    }, this.frameStartingNoticeMs);
  }

  private cancelStartingNotice(): void {
    if (this.startingTimer === null) return;
    this.clearTimer(this.startingTimer);
    this.startingTimer = null;
  }

  /** The frame loaded (or said `ready`, or is gone for good): no notice is
   *  owed, and one that is up is withdrawn. */
  private frameStarted(): void {
    this.cancelStartingNotice();
    if (!this.startingShown) return;
    this.startingShown = false;
    this.opts.onFrameStarting?.(null);
  }

  /** The frame owes a `ready`: past `ms` it is pinged, and a frame that does
   *  not answer the ping either is dead (`remountFrame`). */
  private awaitReady(ms: number): void {
    if (this.destroyed || this.frameLost) return;
    this.awaitingReady = true;
    if (this.readyTimer !== null) this.clearTimer(this.readyTimer);
    this.readyTimer = this.setTimer(() => {
      this.readyTimer = null;
      if (this.destroyed || this.frameLost || !this.awaitingReady) return;
      // One probe at a time: a ping still inside its deadline decides.
      if (this.pendingPings.size > 0) return;
      void this.ping();
    }, ms);
  }

  private clearReadyTimer(): void {
    this.awaitingReady = false;
    if (this.readyTimer !== null) this.clearTimer(this.readyTimer);
    this.readyTimer = null;
  }

  /** The frame answered something, so it is alive. Still owed a `ready` (a
   *  boot failure retrying, a probe's `pong`): keep waiting for it. */
  private heard(): void {
    this.heardSeq++;
    if (this.awaitingReady) this.awaitReady(this.restartReadyTimeoutMs);
  }

  /**
   * The frame is dead: it sent no `ready` in time and did not answer a ping.
   * This is NOT the wedge recovery the AGENTS.md watchdog rule forbids — a
   * wedged worker leaves the supervisor answering, and only terminating the
   * worker frees it; a frame that answers nothing has no thread left to
   * restart. Tear it down, mount a fresh one (a crashed renderer process is
   * gone, so the new frame gets a new one), and let its `ready` replay the
   * source cache (`adoptPort`). Bounded: past `MAX_FRAME_REMOUNTS` inside
   * `FRAME_REMOUNT_WINDOW_MS` the host stops and says why, once.
   */
  private remountFrame(): void {
    if (this.destroyed || this.frameLost) return;
    const now = this.now();
    this.remounts = this.remounts.filter((t) => now - t < FRAME_REMOUNT_WINDOW_MS);
    this.clearReadyTimer();
    if (this.restartTimer !== null) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    this.settlePings();
    this.clearAllPending("the overlay runtime's frame stopped answering");
    this.releasePort();
    this.transport.destroy();
    if (this.remounts.length >= this.maxFrameRemounts) {
      this.loseFrame();
      return;
    }
    this.remounts.push(now);
    this.mountFrame();
  }

  /** What `loseFrame` says: the bounded-remount count; or, for the export's
   *  first-death setting (`maxFrameRemounts: 0`), the overlay the frame died
   *  recovering from, when there is one. Fixed once the frame is lost. */
  get frameLostMessage(): string {
    if (this.lostMessage !== null) return this.lostMessage;
    if (this.maxFrameRemounts !== 0) return FRAME_LOST_MESSAGE;
    const id = this.restartSuspect;
    return id === null ? FRAME_DIED_MESSAGE : frameDiedMessage({ id, kind: this.sources.get(id)?.kind });
  }

  /** Stop: nothing renders from here on, and the preview and the export are
   *  told why — once. A load parked on the first `ready` is let go (it finds
   *  no port and posts nothing). */
  private loseFrame(message: string = this.frameLostMessage): void {
    this.lostMessage = message;
    this.frameLost = true;
    this.clearWorkerRestartDeadline();
    this.readyResolve?.();
    this.readyResolve = null;
    this.frameStarted();
    this.opts.onUnattributed?.({ t: "unattributed", nonce: this.nonce, message: this.frameLostMessage });
    this.opts.onFrameLost?.(this.frameLostMessage);
  }

  /** Every ping still owed an answer gets -1 ("no answer"): nothing that
   *  could answer it is left. */
  private settlePings(): void {
    const owed = Array.from(this.pendingPings.values());
    this.pendingPings.clear();
    for (const waiting of owed) {
      if (waiting.timer !== null) this.clearTimer(waiting.timer);
      waiting.resolve(-1);
    }
  }

  /** The host stopped remounting a frame that kept dying (I3). */
  isFrameLost(): boolean {
    return this.frameLost;
  }

  /** A `ready` — the first, or a restart's: a new worker generation. */
  private adoptPort(port: MessagePort): void {
    const previous = this.port;
    previous?.close();
    this.clearReadyTimer();
    // `ready` comes from the frame's script, so its document has loaded.
    this.frameStarted();
    if (this.restartTimer !== null) {
      // A boot-failure restart we had queued: a worker came up first.
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearAllPending("sandbox restarted");
    this.restartSuspect = null;
    this.clearWorkerRestartDeadline();
    this.loadedHashes.clear();
    this.postedHashes.clear();
    this.superseded.clear();
    this.warm.clear();
    this.lastAnswered = null;
    this.openAsync = null;
    this.fontsSent = false;
    this.gen++;
    this.port = port;
    this.budget = { windowStart: this.now(), messages: 0, chars: 0, asyncSwitches: 0, diagnostics: 0, byId: new Map() };
    port.onmessage = (ev: MessageEvent) => {
      if (this.destroyed || this.port !== port) return;
      // Counted BEFORE `ev.data` is read: Chromium deserializes a port
      // message on that first read, so a flood past the budget costs no more
      // than this check (I1).
      if (!this.spendMessage()) return;
      const data: unknown = ev.data;
      if (!this.spendText(data)) return;
      const msg = parseRuntimeMessage(data);
      if (!msg || msg.nonce !== this.nonce) return;
      if (!this.spendKind(msg)) return;
      this.handle(msg);
    };
    port.onmessageerror = () => {
      if (this.destroyed || this.port !== port) return;
      // A payload that crossed the boundary uncloneable — almost always a
      // `layer` bitmap. Nothing names the overlay, so it is blamed on whatever
      // the worker was working on; with nothing in flight there is no one to
      // tell and the watchdog is what notices.
      this.reportWorkerFailure("a message from the overlay runtime could not be deserialized");
    };
    port.start?.();
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
    } else {
      this.opts.onRestart?.();
    }
    // Replay the source cache into the fresh worker (spec A1 §4, §5).
    for (const [id, input] of this.sources) {
      if (this.dropped.get(id) === input.sourceHash) continue;
      void this.load(input).catch(() => {});
    }
  }

  // ── the port's message budget (I1) ────────────────────────────────────────

  /** The current one-second window, rolled over when it has passed. */
  private window(): PortBudget {
    const now = this.now();
    if (now - this.budget.windowStart >= PORT_BUDGET_WINDOW_MS) {
      this.budget = { windowStart: now, messages: 0, chars: 0, asyncSwitches: 0, diagnostics: 0, byId: new Map() };
    }
    return this.budget;
  }

  /** One more message on the port; false (and the port is gone) past the budget. */
  private spendMessage(): boolean {
    const b = this.window();
    if (++b.messages <= PORT_MESSAGES_PER_SECOND) return true;
    this.flood(`${b.messages} messages`);
    return false;
  }

  /** Its text: a message past `MAX_PORT_MESSAGE_CHARS` is dropped unparsed,
   *  and the window's total is bounded like its count. */
  private spendText(data: unknown): boolean {
    const b = this.budget;
    const chars = textSize(data);
    b.chars += Math.min(chars, PORT_CHARS_PER_SECOND + 1);
    if (b.chars > PORT_CHARS_PER_SECOND) {
      this.flood(`over ${PORT_CHARS_PER_SECOND} characters`);
      return false;
    }
    return chars <= MAX_PORT_MESSAGE_CHARS;
  }

  /**
   * What the message is: `async` / `asyncDone` switches have a budget of
   * their own, and diagnostics that answer nothing — `unattributed`, a
   * `render` error without a `req` — are forwarded only
   * `PORT_DIAGNOSTICS_FORWARDED_PER_SECOND` a second (the rest are dropped
   * before React or the store see them) and flood the port past
   * `PORT_DIAGNOSTICS_PER_SECOND`.
   */
  private spendKind(msg: RuntimeMessage): boolean {
    const b = this.budget;
    if ("id" in msg && b.byId.size < 1000) b.byId.set(msg.id, (b.byId.get(msg.id) ?? 0) + 1);
    if (msg.t === "async" || msg.t === "asyncDone") {
      if (++b.asyncSwitches <= PORT_ASYNC_SWITCHES_PER_SECOND) return true;
      this.flood(`${b.asyncSwitches} async window switches`);
      return false;
    }
    const answersNothing = msg.t === "unattributed" || (msg.t === "error" && msg.phase === "render" && msg.req === undefined);
    if (!answersNothing) return true;
    if (++b.diagnostics > PORT_DIAGNOSTICS_PER_SECOND) {
      this.flood(`${b.diagnostics} diagnostics`);
      return false;
    }
    return b.diagnostics <= PORT_DIAGNOSTICS_FORWARDED_PER_SECOND;
  }

  /**
   * The port went over its budget: the worker is flooding the studio's main
   * thread. That is a wedge in all but name, and it is recovered the same
   * way — the port is closed at once (the queue behind it goes with it) and
   * the worker restarted, through the watchdog's own paths:
   *  - something holds the thread (an open `async` window, a render that
   *    started and is not answered): its owner is blamed and dropped, exactly
   *    as when it wedged (`blameHolder`);
   *  - nothing does: the overlay that sent the most messages this second (or,
   *    failing that, the one whose render was answered last) is the suspect,
   *    as for an unannounced wedge (`unownedWedge`) — nothing is dropped on a
   *    first offence, the same suspect twice within 60 s is, and each restart
   *    feeds the decaying restart score.
   */
  private flood(reason: string): void {
    if (this.destroyed || !this.port) return;
    const message = floodMessage(reason);
    const holder = this.threadHolder();
    if (holder) {
      this.blameHolder(holder, holder.budgetMs, message);
      return;
    }
    let top: string | null = null;
    let most = 0;
    for (const [id, n] of this.budget.byId) {
      if (n > most && this.sources.has(id) && this.dropped.get(id) !== this.sources.get(id)!.sourceHash) {
        top = id;
        most = n;
      }
    }
    const suspect = top !== null ? { id: top, sourceHash: this.sources.get(top)!.sourceHash } : null;
    this.unownedWedge(suspect, message, message);
  }

  /**
   * The supervisor could not keep a worker alive (Task 4 review ruling).
   *
   * AFTER a `ready` the worker exists, so the only way this fires is an
   * uncaught error inside a body: a diagnostic for whatever that worker was
   * working on, NOT a supervisor fault. Recovery stays with the watchdog —
   * restarting here as well would double-restart on every body throw.
   *
   * BEFORE a `ready` (or after the watchdog dropped the port) nothing is
   * running: the worker would not boot. Nothing will ever answer, so say which
   * overlays that costs and ask again, no faster than once per
   * `restartBackoffMs`. The source is deliberately NOT blacklisted — the body
   * never ran, so a transient spawn failure must not strand it forever.
   */
  private handleSupervisorError(message: string): void {
    if (this.destroyed) return;
    if (this.port) {
      this.reportWorkerFailure(message);
      return;
    }
    this.clearAllPending("the overlay runtime could not start");
    for (const [id] of this.sources) {
      if (this.loadedHashes.has(id)) continue;
      this.opts.onError({ t: "error", nonce: this.nonce, id, phase: "build", message });
      this.opts.onTimeout(id, "load", this.loadTimeoutMs);
    }
    if (this.restartTimer !== null) return;
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.requestRestart();
    }, this.restartBackoffMs);
  }

  /** A failure the wire could not attribute to a message: blame whatever the
   *  worker was working on — the oldest request it has not answered. False
   *  when nothing is outstanding — there is then no overlay to hang the
   *  diagnostic on, and the watchdog is what notices. */
  private reportWorkerFailure(message: string): boolean {
    const head = this.queue[0];
    if (!head) return false;
    this.opts.onError({
      t: "error",
      nonce: this.nonce,
      id: head.id,
      phase: head.kind === "render" ? "render" : "build",
      message,
    });
    return true;
  }

  private handle(msg: RuntimeMessage): void {
    switch (msg.t) {
      case "loaded": {
        const entry = this.answerLoad(msg.id, msg.sourceHash);
        const pending = this.pendingLoads.get(msg.id);
        const own = pending !== undefined && pending.entry === entry;
        // Recorded only when it is the host's last word on the id: the host
        // still holds that source, and no newer load for it is outstanding.
        // A superseded load's late `loaded{A}` must not pin A over B; and a
        // font ride answered after its overlay was removed must not claim a
        // body the worker has since disposed — an undo of the same source
        // would then skip the load and every render answer "not loaded"
        // (Task 9 re-review).
        if (this.sources.get(msg.id)?.sourceHash === msg.sourceHash && (!pending || own)) {
          this.loadedHashes.set(msg.id, msg.sourceHash);
        }
        if (entry?.fonts) this.opts.onFontsInstalled?.();
        // Only the pending whose OWN post the worker answered is settled —
        // matching by id alone let a superseded load's late `loaded{A}`
        // resolve its successor (reachable when the watcher revalidates twice
        // in one round trip), and a font ride's `loaded` resolve a same-hash
        // re-post before the worker had processed it.
        if (!own) return;
        this.pendingLoads.delete(msg.id);
        pending.resolve();
        this.flushFonts(); // a font set that changed while nothing was held
        return;
      }
      case "started": {
        // Posted from a new task: whatever window was open is over (the
        // worker closes it first anyway).
        this.openAsync = null;
        const entry = this.queue.find((e) => e.kind === "render" && e.id === msg.id && e.req === msg.req);
        if (entry) {
          entry.started = true;
          entry.startedAt = this.now();
          entry.startedSeq = ++this.startedSeq;
        }
        return;
      }
      case "async": {
        // The body that scheduled the callback, as the worker names it (N3) —
        // but only when the host itself superseded that version on this port
        // (NEW-1): a superseded version's leftover timer must not frame the
        // id's newest source. Any other hash is charged to the newest body the
        // host posted for the id, whatever the worker says: the hash is read
        // in the realm the bodies share, and a body that bent that read would
        // otherwise steer its own wedge into a restart that drops nobody.
        const named = msg.sourceHash;
        const superseded = named !== undefined && this.superseded.get(msg.id)?.has(named) === true;
        this.openAsync = {
          id: msg.id,
          sourceHash: (superseded ? named : undefined) ?? this.postedHashes.get(msg.id) ?? this.loadedHashes.get(msg.id) ?? named ?? "",
          since: this.now(),
        };
        return;
      }
      case "asyncDone":
        if (this.openAsync?.id === msg.id) this.openAsync = null;
        return;
      case "layer": {
        // Held to the size the host asked for (I2), before anything keeps it:
        // a body that resized its canvas would hand the preview and the
        // export a bitmap of up to 1 GiB per overlay per frame.
        const entry = this.renderEntry(msg.id, msg.req);
        const got = { width: msg.bitmap.width, height: msg.bitmap.height };
        if (entry?.layer && oversized(got, entry.layer)) {
          msg.bitmap.close();
          this.dropOversized(entry, got);
          return;
        }
        this.answerRender(msg.id, msg.req);
        const flight = this.inFlight.get(msg.id);
        if (!flight || flight.req !== msg.req) {
          msg.bitmap.close();
          return;
        }
        this.inFlight.delete(msg.id);
        this.opts.onLayer(msg);
        return;
      }
      case "error": {
        // Hash-matched like `loaded` WHEN the worker names the load
        // (`sourceHash`, sent for `compile`/`build` since Task 7): a late error
        // from a superseded load is then reported without settling the pending
        // load that replaced it. Without the field — an older runtime, or a
        // `render` error, which belongs to no load — it falls back to matching
        // by id alone: rejecting is the safer of the two, since `loadedHashes`
        // is never written here, so `isLoaded` stays honest and the next `load`
        // heals it, whereas ignoring it would leave the real failure pending
        // until the 5 s watchdog restarted the whole worker.
        if (msg.phase === "compile" || msg.phase === "build") {
          const entry = this.answerLoad(msg.id, msg.sourceHash);
          // The worker installs a load's fonts BEFORE it compiles or builds
          // the body (`LayerEngine.load`), so a failed body still installed
          // them — and a paused preview is waiting to hear it (Task 12b M2).
          if (entry?.fonts) this.opts.onFontsInstalled?.();
          const pending = this.pendingLoads.get(msg.id);
          const belongsToPending = msg.sourceHash ? pending?.sourceHash === msg.sourceHash : true;
          if (pending && belongsToPending && (entry === undefined || pending.entry === entry)) {
            this.pendingLoads.delete(msg.id);
            pending.reject(new Error(msg.message));
          }
        }
        // The worker refused to transfer an oversized layer (R-M3): the same
        // drop as for the bitmap, but only when the host's own expectation
        // agrees — the worker's measurement is hygiene, never the bound.
        if (msg.phase === "render" && msg.req !== undefined && msg.layerSize) {
          const entry = this.renderEntry(msg.id, msg.req);
          if (entry?.layer && oversized(msg.layerSize, entry.layer)) {
            this.dropOversized(entry, msg.layerSize);
            return;
          }
        }
        if (msg.req !== undefined) this.answerRender(msg.id, msg.req);
        // Only the render this error ANSWERS is cleared. An error that answers
        // none — an async escape, a superseded load's build error — used to
        // clear whatever render was in flight for the id, so its real layer
        // was closed on arrival and the overlay froze (review I3, minor 8).
        const flight = this.inFlight.get(msg.id);
        if (flight && msg.req !== undefined && flight.req === msg.req) this.inFlight.delete(msg.id);
        this.opts.onError(msg);
        return;
      }
      case "unattributed":
        this.opts.onUnattributed?.(msg);
        return;
      case "curve":
        // Effect curves are the effect sampler's (lib/sandbox/effect-sampler.ts);
        // this host never asks for one, so one arriving here answers nothing.
        return;
    }
  }

  /** The render the worker still owes an answer for, by id and request. */
  private renderEntry(id: string, req: number): Outstanding | undefined {
    return this.queue.find((e) => e.kind === "render" && e.id === id && e.req === req);
  }

  /**
   * A render answered with a layer bigger than it asked for (I2): its body
   * resized its canvas. The render is answered and its flight released, and
   * the body is DROPPED for its current source (re-review R-M3) — as the
   * watchdog drops one, it is retried only when its source changes — so it is
   * never asked again and a gigabyte a frame does not keep crossing the port
   * to be closed. Blame is exact: the answer is matched by `req`. The worker
   * is told to let the body go (`dispose`), which frees the canvas it grew and
   * cancels its timers; nothing is restarted. A body the host has since
   * replaced with a newer source is only reported: the new one may be fine.
   */
  private dropOversized(entry: Outstanding, got: { width: number; height: number }): void {
    const id = entry.id;
    const req = entry.req!;
    const asked = entry.layer!;
    this.answerRender(id, req);
    const flight = this.inFlight.get(id);
    if (flight && flight.req === req) this.inFlight.delete(id);
    if (this.sources.get(id)?.sourceHash === entry.sourceHash) {
      this.dropped.set(id, entry.sourceHash);
      this.warm.delete(id);
      if (this.loadedHashes.delete(id) && this.port && !this.destroyed) {
        this.port.postMessage({ t: "dispose", id } satisfies HostMessage, []);
      }
    }
    this.opts.onError({ t: "error", nonce: this.nonce, id, phase: "render", message: oversizedLayerMessage(got, asked), req });
  }

  /** Fonts every body may name; sent once per worker generation (spec §4.8),
   *  and again whenever the set changes. */
  setFonts(fonts: FontPayload[]): void {
    this.fonts = fonts;
    this.fontsSent = false;
    this.flushFonts();
  }

  /**
   * Fonts cross only on a `load`. When the set changes with no body change —
   * a text overlay gains an uploaded font that a body names by family — no
   * load would ever carry it, so ride a same-hash load of a body the worker
   * already holds: the runtime installs the fonts and keeps that entry (and
   * its images, since none are sent). Nothing held yet: the next posted load
   * carries them, or the next `loaded` retries this.
   */
  private flushFonts(): void {
    if (this.fontsSent || !this.fonts.length || this.destroyed || !this.port) return;
    for (const [id, input] of this.sources) {
      if (this.loadedHashes.get(id) !== input.sourceHash || this.pendingLoads.has(id)) continue;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { images, ...rest } = input;
      const fonts = this.fonts.map((f) => ({ ...f, data: f.data.slice(0) }));
      this.fontsSent = true;
      this.warm.delete(id);
      this.enqueue({ kind: "load", id, sourceHash: input.sourceHash, fonts: true });
      this.notePosted(id, input.sourceHash);
      this.port.postMessage({ t: "load", ...rest, fonts } satisfies HostMessage, fonts.map((f) => f.data));
      return;
    }
  }

  generation(): number {
    return this.gen;
  }

  isLoaded(id: string): boolean {
    return this.loadedHashes.has(id);
  }

  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }

  isDropped(id: string): boolean {
    const hash = this.dropped.get(id);
    return hash !== undefined && this.sources.get(id)?.sourceHash === hash;
  }

  /** Round-trip to the supervisor (never the worker): proves the frame is alive
   *  even while its worker is wedged. Resolves with the latency in ms. */
  ping(): Promise<number> {
    return this.probe(false);
  }

  /**
   * One ping, with a deadline. The supervisor never runs a body, so it
   * answers within a task unless its frame is gone (I3). Past the deadline the
   * ping resolves -1, as `destroy` answers, and — unless the frame said
   * anything at all meanwhile — a SECOND ping goes out (`confirming`), whose
   * own miss replaces the frame (R-M5). The first deadline can pass while the
   * host's own main thread was blocked, its timer then running ahead of a
   * `pong` already queued; the confirming ping's deadline starts only once the
   * host has its thread back, so that queued `pong` is heard first.
   */
  private probe(confirming: boolean): Promise<number> {
    if (this.destroyed || this.frameLost) return Promise.resolve(-1);
    return new Promise<number>((resolve) => {
      const id = ++this.pingSeq;
      const heardAtSend = this.heardSeq;
      const waiting = { sentAt: this.now(), resolve, timer: null as unknown };
      waiting.timer = this.setTimer(() => {
        waiting.timer = null;
        this.pendingPings.delete(id);
        resolve(-1);
        if (this.destroyed || this.frameLost || this.heardSeq !== heardAtSend) return;
        if (confirming) this.remountFrame();
        else void this.probe(true);
      }, this.pingTimeoutMs);
      this.pendingPings.set(id, waiting);
      this.transport.command({ t: "ping", nonce: this.nonce, id });
    });
  }

  async load(input: LoadInput): Promise<void> {
    if (this.destroyed) return;
    this.sources.set(input.id, input);
    if (this.dropped.get(input.id) === input.sourceHash) return; // retried on the NEXT source change only
    this.dropped.delete(input.id);
    if (this.loadedHashes.get(input.id) === input.sourceHash) return;
    const joined = this.joinOrSupersede(input);
    if (joined) return joined;
    await this.ready;
    // Every `await` below reopens a window in which another caller posts a load
    // for this same overlay: whoever parked on `ready` before the first `ready`
    // races `adoptPort`'s replay of the same cached source, and a caller
    // cloning bitmaps races anything issued while it clones. Two posts would
    // load the body twice and orphan one promise that never settles, so from
    // here on a load joins an identical one and stands down for a newer one.
    const afterReady = this.raceCheck(input);
    if (afterReady !== "post") return afterReady === "abort" ? undefined : afterReady;
    // A load issued while the port is down resolves WITHOUT posting: the
    // source is cached and `adoptPort` replays it when a worker comes back, so
    // this promise is not a claim that the body is loaded. `isLoaded(id)` is
    // the truth about that.
    if (this.destroyed || !this.port || this.sources.get(input.id) !== input) return;
    const port = this.port;

    const transfer: Transferable[] = [];
    const msg: LoadMessage = { t: "load", ...input };
    // Clones the host makes but does not post are unreachable garbage: the
    // worker never saw them and the caller holds the originals, so every exit
    // below that does not reach `postMessage` closes them itself.
    const clones: ImageBitmap[] = [];
    const bail = <T,>(value: T): T => {
      for (const clone of clones) clone.close();
      clones.length = 0;
      return value;
    };
    if (input.images) {
      const cloned: Record<string, ImageBitmap> = {};
      try {
        for (const [fileId, bitmap] of Object.entries(input.images)) {
          const clone = await this.cloneBitmap(bitmap);
          clones.push(clone);
          cloned[fileId] = clone;
          transfer.push(clone);
        }
      } catch (err) {
        bail(null);
        throw err;
      }
      msg.images = cloned;
    }
    if (this.port !== port) return bail(undefined); // restarted while cloning; adoptPort replays us
    const afterClone = this.raceCheck(input);
    if (afterClone !== "post") return bail(afterClone === "abort" ? undefined : afterClone);
    const entry: Outstanding = { kind: "load", id: input.id, sourceHash: input.sourceHash };
    if (!this.fontsSent && this.fonts.length) {
      msg.fonts = this.fonts.map((f) => ({ ...f, data: f.data.slice(0) }));
      for (const f of msg.fonts) transfer.push(f.data);
      this.fontsSent = true;
      entry.fonts = true;
    }
    let settle!: { resolve: () => void; reject: (err: Error) => void };
    const promise = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    this.pendingLoads.set(input.id, { entry, sourceHash: input.sourceHash, promise, ...settle });
    // Every render posted after this runs on the entry this load builds.
    this.warm.delete(input.id);
    this.enqueue(entry);
    this.notePosted(input.id, input.sourceHash);
    port.postMessage(msg, transfer);
    return promise;
  }

  /** A load of `sourceHash` for `id` goes out on the current port: whatever
   *  it posted for the id before is superseded from here on. (An undo that
   *  re-posts an older version leaves it in the set too; `blameHolder` asks
   *  whether a hash is the CURRENT source first.) */
  private notePosted(id: string, sourceHash: string): void {
    const prev = this.postedHashes.get(id);
    if (prev !== undefined && prev !== sourceHash) this.markSuperseded(id, prev);
    this.postedHashes.set(id, sourceHash);
  }

  private markSuperseded(id: string, sourceHash: string): void {
    let hashes = this.superseded.get(id);
    if (!hashes) this.superseded.set(id, (hashes = new Set()));
    hashes.add(sourceHash);
  }

  /** Called SYNCHRONOUSLY, where this caller is by definition the newest: the
   *  load already in flight for this id when it carries the same source (join
   *  it — one post, one outcome), `null` after rejecting one that this source
   *  supersedes. */
  private joinOrSupersede(input: LoadInput): Promise<void> | null {
    const pending = this.pendingLoads.get(input.id);
    if (!pending) return null;
    if (pending.sourceHash === input.sourceHash) return pending.promise;
    // Its post stays in the port queue: the worker still loads it first.
    this.pendingLoads.delete(input.id);
    pending.reject(new Error("superseded by a newer source"));
    return null;
  }

  /** Called after an `await`, where anything in flight was issued LATER than
   *  this caller: join an identical load, stand down for a different one. */
  private raceCheck(input: LoadInput): Promise<void> | "post" | "abort" {
    const pending = this.pendingLoads.get(input.id);
    if (!pending) return "post";
    return pending.sourceHash === input.sourceHash ? pending.promise : "abort";
  }

  /** Post a render on the port; returns the request id, or -1 when nothing was sent.
   *  The geometry is clamped to the wire's caps first (`clampRenderGeometry`):
   *  the worker drops a message its parser refuses without an answer, which
   *  the watchdog would read as a hang. Callers plan within the caps already
   *  (`planLayer`), so this changes nothing a caller placed a bitmap by. */
  render(input: RenderInput): number {
    if (this.destroyed || !this.port) return -1;
    if (!this.loadedHashes.has(input.id) || this.isDropped(input.id) || this.inFlight.has(input.id)) return -1;
    const req = ++this.reqSeq;
    const geometry = clampRenderGeometry(input);
    const budgetMs = this.renderBudget(input.id, contentFitKeys({ ...input, size: geometry.size }));
    this.inFlight.set(input.id, { req });
    const sourceHash = this.postedHashes.get(input.id) ?? this.loadedHashes.get(input.id) ?? "";
    const layer = expectedLayerSize(this.sources.get(input.id)?.kind, geometry);
    this.enqueue({ kind: "render", id: input.id, sourceHash, req, budgetMs, layer });
    this.port.postMessage({ t: "render", req, ...input, ...geometry } satisfies HostMessage, []);
    return req;
  }

  /**
   * The watchdog's budget for a render about to be posted (fix round 1,
   * ruling 2). A body's FIRST render on the worker's entry for it — after any
   * load, on a fresh worker, or once the worker has idled the layer out
   * (`IDLE_LAYER_MS`, which drops the cached fit) — pays the worker's warm-up
   * (~1.6 s measured on SwiftShader) and the content-fit probe, which runs the
   * body across its timeline within its own `PROBE_BUDGET_MS`
   * (lib/overlays/code-content-fit.ts); so does its first render at a size, a
   * timeline (a trim, a retime) or caption words it has not rendered with,
   * since the fit is keyed on them (`contentFitKey`). Those get the 5 s load
   * budget, plus `PROBE_EXTRA_BUDGET_MS` for each further fit it may measure —
   * a keyframed-size segment's other end and midpoints (up to 20 s on a
   * segment's first frame); every other render keeps 2 s. A body that never
   * returns is still caught: within that budget on such a render, within 2 s
   * on any other.
   *
   * Recorded at POST, which is exact because a render runs the moment it
   * reaches the worker (renders never queue behind one another, see
   * `Outstanding`) and the host keeps one render per id in flight: every
   * render of this id posted after this one runs after it, on the same entry,
   * unless a load is posted in between — and posting a load forgets the id. The idle clock starts at
   * the post, no later than the worker's own, so the host never counts a
   * layer as warm that the worker has already released.
   */
  private renderBudget(id: string, keys: string[]): number {
    const now = this.now();
    const last = this.warm.get(id);
    const held = last && now - last.postedAt < IDLE_LAYER_MS ? last.keys : [];
    // Touch every key in the worker's order (`LayerEngine.fitAt`), counting
    // the ones it will have to probe.
    const lru = held.slice();
    let probes = 0;
    for (const key of keys) {
      const at = lru.indexOf(key);
      if (at >= 0) lru.splice(at, 1);
      else probes++;
      lru.push(key);
      if (lru.length > FIT_CACHE_SIZE) lru.shift();
    }
    this.warm.set(id, { keys: lru, postedAt: now });
    // The first fit measured gets the whole first-render budget (it may also
    // pay the worker's warm-up); every further one — a tween segment's other
    // end and midpoints — `PROBE_EXTRA_BUDGET_MS` more.
    return probes === 0 ? this.renderTimeoutMs : this.loadTimeoutMs + (probes - 1) * PROBE_EXTRA_BUDGET_MS;
  }


  /**
   * The overlay is gone (spec §4.9). Its source leaves the cache, so no restart
   * replays it, and a render in flight is abandoned — its late `layer` finds no
   * in-flight slot and is closed by `handle`.
   *
   * `dispose` is posted only for a body the worker ACKNOWLEDGED. A load still
   * pending was posted but never answered: the host does not know whether the
   * worker holds it, and a `dispose` for an id the worker has no layer for is
   * noise. The worker's own 60 s eviction (§4.9) collects that case; the
   * caller's promise is rejected so nothing waits on a load for an overlay that
   * no longer exists.
   */
  dispose(id: string): void {
    this.sources.delete(id);
    this.dropped.delete(id);
    this.warm.delete(id);
    // What the worker was sent for it is no one's now: a leftover of it is a
    // superseded version's, should the id come back with another source.
    const posted = this.postedHashes.get(id);
    if (posted !== undefined) this.markSuperseded(id, posted);
    this.postedHashes.delete(id);
    this.clearPending(id, "the overlay was disposed");
    if (this.loadedHashes.delete(id) && this.port && !this.destroyed) {
      this.port.postMessage({ t: "dispose", id } satisfies HostMessage, []);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearWorkerRestartDeadline();
    if (this.restartTimer !== null) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearAllPending("the sandbox was destroyed");
    // A `load` parked on `ready` before the first `ready` would otherwise wait
    // forever. The `destroyed` check where it resumes makes it return without
    // posting, so settling here is safe.
    this.readyResolve?.();
    this.readyResolve = null;
    // Nothing will ever pong. -1 is `ping`'s "no answer", matching `render`'s
    // -1, rather than a rejection every diagnostics caller would have to catch.
    this.settlePings();
    this.clearReadyTimer();
    this.frameStarted();
    this.port?.close();
    this.port = null;
    this.transport.destroy();
  }

  /** Every load and render this generation owed an answer for. The port
   *  queue goes with them: nothing on the old port will be answered. */
  private clearAllPending(reason: string): void {
    this.resetQueue();
    for (const id of Array.from(this.pendingLoads.keys())) this.clearPending(id, reason);
    for (const id of Array.from(this.inFlight.keys())) this.clearPending(id, reason);
  }

  /** The host stops waiting on this overlay. Its posts stay in the port
   *  queue — the worker still answers them, and until it does the requests
   *  behind them are not yet its business. */
  private clearPending(id: string, reason = "the sandbox restarted or was destroyed"): void {
    const pending = this.pendingLoads.get(id);
    if (pending) {
      this.pendingLoads.delete(id);
      pending.reject(new Error(reason));
    }
    this.inFlight.delete(id);
  }

  // ── the port queue and its one watchdog ───────────────────────────────────

  private enqueue(entry: Outstanding): void {
    this.queue.push(entry);
    if (this.queue.length === 1) this.armHead();
  }

  /** Remove an answered request; answering the head starts the next one's clock. */
  private answer(entry: Outstanding | undefined): void {
    if (!entry) return;
    const i = this.queue.indexOf(entry);
    if (i < 0) return;
    this.queue.splice(i, 1);
    if (i === 0) this.armHead();
  }

  /** The oldest load for `id` (of `sourceHash`, when the answer names one):
   *  the worker handles one id's loads in arrival order. */
  private answerLoad(id: string, sourceHash: string | undefined): Outstanding | undefined {
    const entry = this.queue.find((e) => e.kind === "load" && e.id === id && (!sourceHash || e.sourceHash === sourceHash));
    this.answer(entry);
    return entry;
  }

  private answerRender(id: string, req: number): void {
    const entry = this.queue.find((e) => e.kind === "render" && e.id === id && e.req === req);
    if (entry) this.lastAnswered = { id: entry.id, sourceHash: entry.sourceHash };
    this.answer(entry);
  }

  private armHead(): void {
    if (this.headTimer !== null) this.clearTimer(this.headTimer);
    this.headTimer = null;
    const head = this.queue[0];
    if (!head || this.destroyed) return;
    this.watchHead(head, this.budgetOf(head));
  }

  private watchHead(head: Outstanding, ms: number): void {
    this.headTimer = this.setTimer(() => {
      this.headTimer = null;
      if (this.queue[0] === head) this.expire(head);
    }, ms);
  }

  /**
   * Who the worker last said holds its thread (Task 13 fix round 2): the open
   * `async` window — always newer than any render, since the worker closes it
   * before it posts the next `started` — else the newest render that started
   * and is not answered. Renders can overlap: a render that arrives while an
   * earlier one waits out its one-task yield starts too, and a wedge in the
   * later body leaves both unanswered.
   */
  private threadHolder(): Holder | null {
    if (this.openAsync) {
      // A window whose body's LOAD the worker still owes an answer for is
      // load-phase work: a three build runs its factory inside that load, and
      // has the load's budget (A4), not a render's (N4).
      const open = this.openAsync;
      const load = this.queue.find((e) => e.kind === "load" && e.id === open.id && e.sourceHash === open.sourceHash);
      return load
        ? { ...open, budgetMs: this.loadTimeoutMs, phase: "load", entry: load }
        : { ...open, budgetMs: this.renderTimeoutMs, phase: "render" };
    }
    let newest: Outstanding | undefined;
    for (const e of this.queue) {
      if (e.kind === "render" && e.started && (!newest || (e.startedSeq ?? 0) > (newest.startedSeq ?? 0))) newest = e;
    }
    if (!newest) return null;
    return { id: newest.id, sourceHash: newest.sourceHash, since: newest.startedAt ?? 0, budgetMs: this.budgetOf(newest), phase: "render", entry: newest };
  }

  private budgetOf(entry: Outstanding): number {
    return entry.kind === "render" ? (entry.budgetMs ?? this.renderTimeoutMs) : this.loadTimeoutMs;
  }

  private resetQueue(): void {
    if (this.headTimer !== null) this.clearTimer(this.headTimer);
    this.headTimer = null;
    this.queue = [];
  }

  /**
   * The worker spent a whole timeout on `head` alone. For the body the host
   * still holds, that is spec §4.7: drop it and restart. For a request the
   * host had already stopped waiting on (its overlay removed, its source
   * superseded) the worker is just as wedged and still needs restarting, but
   * no overlay on screen is to blame: nothing is dropped and nothing reported.
   * Loads still pending are left for the fresh worker's replay (`adoptPort`),
   * which settles them.
   *
   * The head is not necessarily what holds the thread, so the watchdog asks
   * the worker's own account first (`threadHolder`, Task 13 fix round 2):
   *  - an open `async` window means a body's timer, helper settlement or build
   *    is running — its owner is blamed, exactly like a render that wedged,
   *    and the head (a sibling's render the worker never got to) is not;
   *  - a render that started after the head and is not answered wedged in its
   *    own body — it is blamed, not the older head waiting behind it.
   * A holder other than the head is timed from when it took the thread, with
   * the render budget (or the head's own, when it is the head's overlay): the
   * head's clock can run out a moment after a sibling's callback began, and
   * that callback is owed the same 2 s a render gets — or the 5 s of a load,
   * when it is load-phase work (a three build whose load is still owed).
   *
   * A render the worker never said it STARTED, with nothing else announced,
   * was blocked by work no window covers — an async source the runtime does
   * not wrap (async-owner.ts). Blaming the overlay being timed would drop an
   * innocent sibling, so `unstartedWedge` drops no one on a first offence.
   */
  private expire(head: Outstanding): void {
    if (this.destroyed) return;
    const holder = this.threadHolder();
    const own = holder?.id === head.id;
    // A three body's build announces itself inside its own `load`: a wedge
    // there is that load's timeout, handled below as it always was.
    if (holder && holder.entry !== head && !(own && head.kind === "load")) {
      const budgetMs = own ? this.budgetOf(head) : holder.budgetMs;
      const heldFor = this.now() - holder.since;
      if (!own && heldFor < budgetMs) {
        this.watchHead(head, budgetMs - heldFor);
        return;
      }
      this.blameHolder(holder, budgetMs);
      return;
    }
    if (this.sources.get(head.id)?.sourceHash !== head.sourceHash) {
      const evidence = this.stallEvidence(null);
      this.resetQueue();
      this.inFlight.clear();
      this.releasePort();
      this.restartSuspect = null;
      this.restartWithoutDrop(evidence);
      return;
    }
    if (head.kind === "render" && !head.started) {
      this.unstartedWedge();
      return;
    }
    if (head.kind === "load") {
      const pending = this.pendingLoads.get(head.id);
      if (pending?.entry === head) {
        this.pendingLoads.delete(head.id);
        pending.reject(new Error(`timed out after ${Math.round(this.loadTimeoutMs / 1000)} s`));
      }
    }
    this.dropAndRestart(head.id, head.sourceHash, head.kind, this.budgetOf(head));
  }

  /**
   * The worker named who holds its thread: that body is the offender. One
   * the host no longer holds still wedged the worker, which is restarted with
   * nothing dropped, like an orphaned head — but only when the host KNOWS it
   * no longer holds it: the overlay was removed, or the host superseded that
   * very version on this port (`superseded`, NEW-1). A hash the host never
   * superseded is charged to the id's current source.
   */
  private blameHolder(holder: Holder, budgetMs: number, reason?: string): void {
    const current = this.sources.get(holder.id)?.sourceHash;
    if (current === undefined || (current !== holder.sourceHash && this.superseded.get(holder.id)?.has(holder.sourceHash))) {
      // The host KNOWS who held the thread here, and it is not the head: the
      // head is a sibling's render that never got the thread, so it is no
      // evidence for the breaker's last tier (Task 13 re-review 3, M1).
      const evidence = { ...this.stallEvidence(null), heads: [] };
      this.clearAllPending("the overlay runtime stopped answering");
      this.releasePort();
      this.restartSuspect = null;
      this.restartWithoutDrop(evidence);
      return;
    }
    if (current !== holder.sourceHash) holder = { ...holder, sourceHash: current };
    if (holder.phase === "load") {
      // Its load's caller hears what the load's own timeout would have said.
      const pending = this.pendingLoads.get(holder.id);
      if (pending && pending.entry === holder.entry) {
        this.pendingLoads.delete(holder.id);
        pending.reject(new Error(reason ?? `timed out after ${Math.round(budgetMs / 1000)} s`));
      }
    }
    this.dropAndRestart(holder.id, holder.sourceHash, holder.phase, budgetMs, reason);
  }

  /** Spec §4.7 (A1): mark the offender dropped, drop the wedged worker's port
   *  and ask the supervisor for a fresh worker. The replay happens in
   *  `adoptPort` when the new `ready` arrives. */
  private dropAndRestart(id: string, sourceHash: string, phase: "load" | "render", afterMs: number, reason?: string): void {
    if (this.destroyed) return;
    this.dropped.set(id, sourceHash);
    this.restartSuspect = id;
    this.resetStalls();
    this.clearAllPending(`the overlay runtime stopped answering (${phase})`);
    this.releasePort();
    if (reason === undefined) this.opts.onTimeout(id, phase, afterMs);
    else this.opts.onTimeout(id, phase, afterMs, reason);
    this.requestRestart();
  }

  /**
   * The worker wedged while it had announced nothing: no render started, no
   * `async` window open (see `expire`). Since fix round 2 every timer,
   * animation frame and helper settlement a body schedules announces its
   * owner, and a render's own microtasks run inside its bracket, so this is
   * only reached through an async source the runtime does not wrap. It is the
   * FALLBACK, kept because without it such a body would restart the worker
   * forever, freezing every overlay; with it, the worst case is one overlay.
   * Nothing is dropped on a first offence: the worker is restarted and the
   * wedge reported unattributed. The overlay whose render this worker answered
   * LAST is recorded as the suspect; the same suspect (same body) twice within
   * `REPEAT_WEDGE_WINDOW_MS` is dropped, with a diagnostic of its own that
   * names no other overlay.
   */
  private unstartedWedge(): void {
    this.unownedWedge(null, UNSTARTED_WEDGE_MESSAGE, KEEPS_BLOCKING_MESSAGE);
  }

  /** `unstartedWedge`'s path, shared with a port flood nothing holds the
   *  thread for (`flood`): `suspect` is who the evidence names first, else
   *  the overlay whose render was answered last; `report` goes out
   *  unattributed, and `repeat` is what a suspect dropped for a second
   *  offence is told. */
  private unownedWedge(named: Stall["suspect"], report: string, repeat: string): void {
    const last = this.lastAnswered;
    const suspect = named ?? (last && this.sources.get(last.id)?.sourceHash === last.sourceHash ? last : null);
    const evidence = this.stallEvidence(suspect);
    this.clearAllPending("the overlay runtime stopped answering (render)");
    this.releasePort();
    this.lastAnswered = null;
    this.restartSuspect = suspect?.id ?? null;
    this.opts.onUnattributed?.({ t: "unattributed", nonce: this.nonce, message: report });
    if (suspect) {
      const now = this.now();
      const prev = this.lastWedge;
      if (prev && prev.id === suspect.id && prev.sourceHash === suspect.sourceHash && now - prev.at <= REPEAT_WEDGE_WINDOW_MS) {
        this.lastWedge = null;
        this.resetStalls();
        this.dropped.set(suspect.id, suspect.sourceHash);
        this.opts.onError({ t: "error", nonce: this.nonce, id: suspect.id, phase: "render", message: repeat });
        this.requestRestart();
        return;
      }
      this.lastWedge = { ...suspect, at: now };
    }
    this.restartWithoutDrop(evidence);
  }

  /** Who a restart that drops nobody could have named. Read BEFORE the
   *  port's state is cleared. */
  private stallEvidence(suspect: Stall["suspect"]): Omit<Stall, "at"> {
    const open: string[] = [];
    if (this.openAsync) open.push(this.openAsync.id);
    for (const e of this.queue) if (e.kind === "render" && e.started) open.push(e.id);
    const head = this.queue[0];
    return { suspect, open, heads: head ? [head.id] : [] };
  }

  /**
   * Restart a wedged worker without dropping anyone — the orphaned head, the
   * superseded or removed holder, the unannounced wedge's first offence. Each
   * is right on its own, and each can repeat: a version rewritten before its
   * wedge lands, suspects that take turns. So each adds 1 to the decaying
   * restart score, and the one that brings it to `STALL_SCORE_LIMIT` trips
   * the breaker, which drops, in order of evidence:
   *  1. the fallback suspect of the newest unannounced wedge among them;
   *  2. else every overlay whose `async` window or started render was open
   *     at any of them;
   *  3. else every overlay the watchdog was timing at them, where the host
   *     did not know who held the thread —
   * each for its CURRENT source, with `PREVIEW_KEPT_STALLING_MESSAGE`. Only
   * overlays the host still holds are named; when none is left, nothing on
   * screen is stopped and the one diagnostic is unattributed. Any restart
   * that drops someone resets the score.
   */
  private restartWithoutDrop(evidence: Omit<Stall, "at">): void {
    const now = this.now();
    const score = decayStallScore(this.stallScore, now - this.stallScoreAt) + 1;
    const keepFor = STALL_EVIDENCE_HALF_LIVES * STALL_HALF_LIFE_MS;
    this.stalls = this.stalls.filter((s) => now - s.at < keepFor);
    this.stalls.push({ at: now, ...evidence });
    this.stallScore = score;
    this.stallScoreAt = now;
    if (score >= STALL_SCORE_LIMIT) {
      const stalls = this.stalls;
      this.resetStalls();
      this.breakStall(stalls);
    }
    this.requestRestart();
  }

  private resetStalls(): void {
    this.stalls = [];
    this.stallScore = 0;
  }

  private breakStall(stalls: Stall[]): void {
    const held = (id: string): boolean => {
      const source = this.sources.get(id);
      return source !== undefined && this.dropped.get(id) !== source.sourceHash;
    };
    let ids: string[] = [];
    for (let i = stalls.length - 1; i >= 0 && !ids.length; i--) {
      const suspect = stalls[i]!.suspect;
      if (suspect && this.sources.get(suspect.id)?.sourceHash === suspect.sourceHash && held(suspect.id)) ids = [suspect.id];
    }
    if (!ids.length) ids = Array.from(new Set(stalls.flatMap((s) => s.open))).filter(held);
    if (!ids.length) ids = Array.from(new Set(stalls.flatMap((s) => s.heads))).filter(held);
    this.lastWedge = null;
    if (!ids.length) {
      this.opts.onUnattributed?.({ t: "unattributed", nonce: this.nonce, message: PREVIEW_KEPT_STALLING_UNNAMED_MESSAGE });
      return;
    }
    this.restartSuspect = ids[0]!;
    for (const id of ids) {
      this.dropped.set(id, this.sources.get(id)!.sourceHash);
      this.opts.onError({ t: "error", nonce: this.nonce, id, phase: "render", message: PREVIEW_KEPT_STALLING_MESSAGE });
    }
  }

  /** Let go of the wedged worker's port: nothing it holds counts any more. */
  private releasePort(): void {
    this.port?.close();
    this.port = null;
    this.openAsync = null;
    this.loadedHashes.clear();
    this.postedHashes.clear();
    this.superseded.clear();
    this.warm.clear();
  }

  private requestRestart(): void {
    if (this.destroyed || this.frameLost) return;
    this.transport.command({ t: "restart", nonce: this.nonce });
    this.awaitReady(this.restartReadyTimeoutMs);
    this.armWorkerRestartDeadline();
  }

  /** Once per restart cycle — a boot-failure retry inside it does not extend
   *  it — and only after a worker has been up (`gen > 0`). */
  private armWorkerRestartDeadline(): void {
    const ms = this.opts.workerRestartTimeoutMs;
    if (ms === undefined || this.workerRestartTimer !== null || this.gen === 0) return;
    this.workerRestartTimer = this.setTimer(() => {
      this.workerRestartTimer = null;
      if (this.destroyed || this.frameLost || this.port) return;
      const id = this.restartSuspect;
      const message = workerNotRestartedMessage(ms, id === null ? null : { id, kind: this.sources.get(id)?.kind });
      // Given up on like a dead frame: nothing it sends is heard again.
      this.clearReadyTimer();
      if (this.restartTimer !== null) {
        this.clearTimer(this.restartTimer);
        this.restartTimer = null;
      }
      this.settlePings();
      this.clearAllPending("the overlay runtime's worker did not come back");
      this.transport.destroy();
      this.loseFrame(message);
    }, ms);
  }

  private clearWorkerRestartDeadline(): void {
    if (this.workerRestartTimer === null) return;
    this.clearTimer(this.workerRestartTimer);
    this.workerRestartTimer = null;
  }
}
