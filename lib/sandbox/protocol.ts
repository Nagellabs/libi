/**
 * The overlay-sandbox wire protocol (spec §4.2, as amended by A1). Shared by the
 * host (`lib/sandbox/host.ts`), the iframe supervisor (`lib/sandbox/supervisor.ts`)
 * and the worker runtime bundle (`lib/sandbox/runtime-entry.ts`).
 *
 * Every message is validated with zod on BOTH sides: the host never trusts a
 * frame it merely embedded, and the runtime never trusts a window that can
 * reach it. `ImageBitmap` / `ArrayBuffer` / `MessagePort` payloads are
 * structured-clone transferred, so they are checked by duck-typing
 * (`isImageBitmapLike`, `isMessagePortLike`) rather than `instanceof`, which
 * also lets node tests pass fakes.
 *
 * Nonces (spec §4.1 "messages must echo it") ride the legs a hostile page could
 * reach: worker → host and supervisor → host messages all carry the host's
 * nonce, and the host additionally requires `event.source === iframe.contentWindow`.
 * Host → worker messages travel on the private transferred port (A1 §3) and
 * carry none — nothing else holds that port.
 *
 * A parse STRIPS unknown fields rather than rejecting them (zod's default), so
 * consumers must use the parser's return value and never the raw `event.data` —
 * the raw object still carries whatever the other side attached. Free-text
 * fields a body controls are length-bounded here, at the wire, not downstream.
 *
 * This module is imported by the browser main thread, the iframe and the worker
 * bundle alike, so it must stay free of server-only and DOM-only code.
 */
import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol-supervisor";
import { CURVE_FIELDS, MAX_CURVE_SAMPLES } from "@/lib/effects/curve";
import { fitPathSizes } from "@/lib/overlays/code-content-fit";

// The supervisor leg's constants and its one parser live in a zod-free module
// so the supervisor half of the served bundle does not pay for zod a second
// time (see that file's header). Re-exported here so the host and the worker,
// which carry zod anyway, still have one import site.
export {
  PROTOCOL_VERSION,
  WORKER_BOOTED,
  parseSupervisorCommand,
  type SupervisorCommand,
} from "./protocol-supervisor";

export function isImageBitmapLike(v: unknown): v is ImageBitmap {
  if (typeof v !== "object" || v === null) return false;
  const b = v as { width?: unknown; height?: unknown; close?: unknown };
  return typeof b.width === "number" && typeof b.height === "number" && typeof b.close === "function";
}

const id = z.string().min(1).max(200);
const nonce = z.string().min(1);
const bitmap = z.custom<ImageBitmap>(isImageBitmapLike, "expected an ImageBitmap");
const arrayBuffer = z.custom<ArrayBuffer>((v) => v instanceof ArrayBuffer, "expected an ArrayBuffer");
const sourceHash = z.string().regex(/^[0-9a-f]{64}$/, "sourceHash must be 64 lowercase hex chars");
const timing = z.object({
  frame: z.number(),
  time: z.number(),
  totalFrames: z.number(),
  duration: z.number(),
  progress: z.number(),
});
const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
const word = z.object({ text: z.string(), start: z.number(), end: z.number() });
/** Mirrors `CameraPreset` (`lib/engine/three-helpers.ts`) — re-declared, not
 *  imported, so the runtime bundle carries no host code. */
const cameraPreset = z.enum(["billboard", "ground", "lowAngle", "highAngle", "angled"]);
const bodyKind = z.enum(["code", "three", "tracked"]);
const errorPhase = z.enum(["compile", "build", "render"]);

export type BodyKind = z.infer<typeof bodyKind>;
export type ErrorPhase = z.infer<typeof errorPhase>;
export type FrameTiming = z.infer<typeof timing>;

const fontPayload = z.object({ family: z.string().min(1), weight: z.number(), data: arrayBuffer });
export type FontPayload = z.infer<typeof fontPayload>;

// ── host → runtime (on the transferred port; no nonce) ──────────────────────
const loadSchema = z.object({
  t: z.literal("load"),
  id,
  kind: bodyKind,
  source: z.string(),
  sourceHash,
  /** Logical (composition-px) size of the overlay rect at load; the render
   *  message carries the authoritative per-frame size. */
  width: z.number().positive(),
  height: z.number().positive(),
  /** Transferred bitmaps keyed by fileId (spec §4.3 `images`). */
  images: z.record(z.string(), bitmap).optional(),
  /** Sent once per sandbox instance, on the first load that follows a (re)start. */
  fonts: z.array(fontPayload).optional(),
  /** `pixelRatio: 1` is a LITERAL on purpose (spec §4.2): three layers render at
   *  1× and the render message's own `pixelRatio` scales the canvas. Sending
   *  anything else nulls the whole load, which the 5 s watchdog would then see
   *  as a hang and restart in a loop — so a host mistake here fails loudly in
   *  dev rather than being silently accepted. */
  three: z.object({ cameraPreset, pixelRatio: z.literal(1) }).optional(),
});
/** Room around the body's box, in composition px, that the layer also covers.
 *  Tracked `code` only: its body used to draw on the main canvas with no clip,
 *  so a name tag above a face or a glow around a product must still land. The
 *  body keeps `width`/`height` = `size` with its origin at the box's top-left;
 *  the runtime translates by (`left`, `top`) before calling it. */
const pad = z.object({
  left: z.number().finite().nonnegative(),
  top: z.number().finite().nonnegative(),
  right: z.number().finite().nonnegative(),
  bottom: z.number().finite().nonnegative(),
});
export type LayerPad = z.infer<typeof pad>;

/**
 * A layer not rendered for this long releases its canvas and its cached
 * content fit in the worker (spec §4.9), so the next render probes the body
 * again. Shared: the runtime sweeps by it, and the host's watchdog gives that
 * render the first-render budget (`OverlaySandbox.render`).
 */
export const IDLE_LAYER_MS = 60_000;

/**
 * What one measured content fit is keyed on: the size it was measured at, the
 * timeline the probe measured over (`measureCodeContentBox` samples the
 * overlay's real fps / totalFrames / duration), and the caption words it drew
 * with — so a resize, a trim, a retime or new words re-probe.
 */
export function contentFitKey(
  at: { width: number; height: number },
  m: { fps: number; time: { totalFrames: number; duration: number }; words?: ReadonlyArray<{ text: string; start: number; end: number }> },
): string {
  return `${at.width}x${at.height}@${m.fps}/${m.time.totalFrames}/${m.time.duration}${wordsSignature(m.words)}`;
}

/**
 * The fits a render may need: one at its size, or — inside a keyframed-size
 * segment (`fitSegment`) — the ends, the midpoint and the halvings towards the
 * current size (`fitPathSizes`), of which the worker measures a prefix. Shared
 * for the same reason as `IDLE_LAYER_MS`: the host's watchdog budgets a
 * render for every one of these keys it has not seen (`renderBudget`), from
 * an LRU of the same `FIT_CACHE_SIZE`. Because the worker touches a
 * subsequence of these keys in the same order, everything the host counts as
 * held is held by the worker too (for a body whose drawing is deterministic).
 */
export function contentFitKeys(m: {
  size: { width: number; height: number };
  fitSegment?: { from: { width: number; height: number }; to: { width: number; height: number } };
  fps: number;
  time: { totalFrames: number; duration: number };
  words?: ReadonlyArray<{ text: string; start: number; end: number }>;
}): string[] {
  return m.fitSegment
    ? fitPathSizes(m.fitSegment.from, m.fitSegment.to, m.size).map((at) => contentFitKey(at, m))
    : [contentFitKey(m.size, m)];
}

/** Measured fits kept per overlay, least recently used out first: enough for
 *  a few keyframe segments with their midpoints, so scrubbing or looping a tween does not re-probe
 *  its ends. The host's budget bookkeeping mirrors it. */
export const FIT_CACHE_SIZE = 16;

/** A cheap fingerprint of a caption's words — count, text length, first start
 *  and last end. Computed on every render on both sides, so it is not a hash;
 *  an edit that keeps all four (the same-length retyping of one word) keeps
 *  the fit, which is at worst the fit of the words before the edit. */
function wordsSignature(words: ReadonlyArray<{ text: string; start: number; end: number }> | undefined): string {
  if (!words || words.length === 0) return "";
  let chars = 0;
  for (const w of words) chars += w.text.length;
  return `/w${words.length}:${chars}:${words[0]!.start}:${words[words.length - 1]!.end}`;
}

/**
 * Caps on a render's geometry (Task 12b). Whatever asks for a render decides
 * how big a canvas the worker allocates, so the wire bounds it: the body's box
 * is at most 8192 px a side, the backing scale at most 4, and the canvas —
 * box plus pad, times the scale, on each axis — at most 8192 × 8192 device px
 * in all (256 MiB of RGBA), and at most `MAX_CANVAS_SIDE` device px on
 * either axis. A composition is at most 7680 px a side
 * (`update_composition_dimensions`), so nothing real comes near the side cap;
 * the pixel cap can bind for a tracked layer with a full pad at 4K and a
 * high scale, where `clampRenderGeometry` lowers the scale instead.
 */
export const MAX_LAYER_SIDE = 8192;
export const MAX_LAYER_PIXEL_RATIO = 4;
export const MAX_LAYER_PIXELS = 8192 * 8192;
/**
 * Chromium's largest canvas side, 32767 px. The area
 * cap alone does not bound one axis: an 8192 × 1 box at scale 4 is 32768 px
 * wide and a pad can triple a side, and a canvas past this fails to allocate —
 * the worker answers with an error or a broken layer (Task 12b review M4).
 */
export const MAX_CANVAS_SIDE = 32767;

interface RenderGeometry {
  size: { width: number; height: number };
  pixelRatio: number;
  pad?: LayerPad;
}

/** The canvas a render asks for, in LOGICAL px: box + pad on each axis. */
function layerSides(g: Omit<RenderGeometry, "pixelRatio">): { w: number; h: number } {
  return {
    w: g.size.width + (g.pad ? g.pad.left + g.pad.right : 0),
    h: g.size.height + (g.pad ? g.pad.top + g.pad.bottom : 0),
  };
}

/** Device pixels of the canvas a render asks for: (box + pad) × pixelRatio. */
function layerPixels(g: RenderGeometry): number {
  const { w, h } = layerSides(g);
  return w * g.pixelRatio * (h * g.pixelRatio);
}

/** Its longer device-pixel side, as the worker allocates it (ceiled). */
function layerLongestSide(g: RenderGeometry): number {
  const { w, h } = layerSides(g);
  return Math.ceil(Math.max(w, h) * g.pixelRatio);
}

/**
 * The geometry, brought inside the caps above: each side of the box cut to
 * `MAX_LAYER_SIDE`, the pad cut to the box it surrounds (the schema's other
 * rule), and the scale lowered to `MAX_LAYER_PIXEL_RATIO` and then as far as
 * the pixel cap and the per-side canvas cap need. Identity (the same objects) for anything already
 * inside. The planner applies it (`planLayer`), so the geometry a bitmap is
 * placed by is the one it was rendered at; the host applies it again before
 * posting, so no caller can put a render on the wire the worker would refuse.
 */
export function clampRenderGeometry<G extends RenderGeometry>(g: G): Pick<G, "size" | "pixelRatio" | "pad"> {
  const width = Math.min(g.size.width, MAX_LAYER_SIDE);
  const height = Math.min(g.size.height, MAX_LAYER_SIDE);
  const size = width === g.size.width && height === g.size.height ? g.size : { width, height };
  let padOut = g.pad;
  if (g.pad) {
    const p = {
      left: Math.min(g.pad.left, width),
      right: Math.min(g.pad.right, width),
      top: Math.min(g.pad.top, height),
      bottom: Math.min(g.pad.bottom, height),
    };
    if (p.left !== g.pad.left || p.right !== g.pad.right || p.top !== g.pad.top || p.bottom !== g.pad.bottom) padOut = p;
  }
  let pixelRatio = Math.min(g.pixelRatio, MAX_LAYER_PIXEL_RATIO);
  const pixels = layerPixels({ size, pixelRatio, pad: padOut });
  if (pixels > MAX_LAYER_PIXELS) {
    // Floored to 1e-6 so float rounding can never leave it a hair over.
    pixelRatio = Math.floor(pixelRatio * Math.sqrt(MAX_LAYER_PIXELS / pixels) * 1e6) / 1e6;
  }
  if (layerLongestSide({ size, pixelRatio, pad: padOut }) > MAX_CANVAS_SIDE) {
    const { w, h } = layerSides({ size, pad: padOut });
    pixelRatio = Math.floor((MAX_CANVAS_SIDE / Math.max(w, h)) * 1e6) / 1e6;
  }
  return { size, pixelRatio, ...(padOut ? { pad: padOut } : {}) } as Pick<G, "size" | "pixelRatio" | "pad">;
}

const renderSchema = z
  .object({
    t: z.literal("render"),
    id,
    frame: z.number().int(),
    /** Monotonic per overlay; the host discards a layer older than the newest it has. */
    req: z.number().int().nonnegative(),
    /** Logical size of the body's box in composition px (rect, or the tracked
     *  bbox) — what the body sees as `width`/`height`. */
    size: z.object({
      width: z.number().positive().max(MAX_LAYER_SIDE),
      height: z.number().positive().max(MAX_LAYER_SIDE),
    }),
    /** Backing scale: the OffscreenCanvas is (size + pad) × pixelRatio device px. */
    pixelRatio: z.number().positive().max(MAX_LAYER_PIXEL_RATIO),
    /** Composition fps — the body's documented `context.fps`. */
    fps: z.number().positive(),
    /** Element-local timing, computed host-side exactly as today. */
    time: timing,
    words: z.array(word).optional(),
    /** `code` only, while its rect SIZE is keyframed: the sizes at the two
     *  ends of the current keyframe segment. The worker measures the content
     *  fit at each once and interpolates between them for every frame of the
     *  segment (`interpolateContentBox`, lib/overlays/code-content-fit.ts),
     *  so a size tween does not re-probe every frame. */
    fitSegment: z
      .object({
        from: z.object({ width: z.number().positive().max(MAX_LAYER_SIDE), height: z.number().positive().max(MAX_LAYER_SIDE) }),
        to: z.object({ width: z.number().positive().max(MAX_LAYER_SIDE), height: z.number().positive().max(MAX_LAYER_SIDE) }),
      })
      .optional(),
    /** three only — the out-of-plane part; the host rolls the composite. */
    transform3d: z.object({ position: vec3, rotation: vec3 }).optional(),
    /** 2D layers only (the host sends it for tracked `code`); ignored by three. */
    pad: pad.optional(),
  })
  // At most one box size on each side, so a layer is never more than 3 × 3
  // boxes: whatever asks for a render cannot make the worker allocate a canvas
  // out of proportion to the body it draws.
  .refine(
    (m) =>
      !m.pad ||
      (m.pad.left <= m.size.width &&
        m.pad.right <= m.size.width &&
        m.pad.top <= m.size.height &&
        m.pad.bottom <= m.size.height),
    { message: "pad may not exceed the box size on any side", path: ["pad"] },
  )
  .refine((m) => layerPixels(m) <= MAX_LAYER_PIXELS, {
    message: `a layer may not exceed ${MAX_LAYER_PIXELS} device pixels`,
    path: ["pixelRatio"],
  })
  .refine((m) => layerLongestSide(m) <= MAX_CANVAS_SIDE, {
    message: `a layer may not exceed ${MAX_CANVAS_SIDE} device pixels on either side`,
    path: ["pixelRatio"],
  });
const disposeSchema = z.object({ t: z.literal("dispose"), id });

/** A custom effect's `animate.js` at most this long (characters) — the wire's
 *  bound on what the host asks the worker to compile. */
export const MAX_EFFECT_SOURCE_CHARS = 1_000_000;
/**
 * Sample a custom effect's `animate(progress, params)` (lib/sandbox/effect-sampler.ts).
 * The worker compiles the body and calls it `samples` times, at progress
 * i / (samples - 1), and answers with a `curve` (or a `compile` / `render`
 * error). Only the effect sampler sends it — the overlay host never does.
 */
const sampleSchema = z.object({
  t: z.literal("sample"),
  id,
  source: z.string().max(MAX_EFFECT_SOURCE_CHARS),
  sourceHash,
  params: z
    .record(z.string().max(100), z.union([z.number(), z.string().max(200)]))
    .refine((p) => Object.keys(p).length <= 64, "at most 64 params"),
  samples: z.number().int().min(2).max(MAX_CURVE_SAMPLES),
});

export const hostMessageSchema = z.discriminatedUnion("t", [loadSchema, renderSchema, disposeSchema, sampleSchema]);
export type LoadMessage = z.infer<typeof loadSchema>;
export type RenderMessage = z.infer<typeof renderSchema>;
export type DisposeMessage = z.infer<typeof disposeSchema>;
export type SampleMessage = z.infer<typeof sampleSchema>;
export type HostMessage = z.infer<typeof hostMessageSchema>;

// ── worker → host, on the transferred port ──────────────────────────────────
/** Not in spec §4.2's list: the 5 s load watchdog needs a completion signal. */
const loadedSchema = z.object({ t: z.literal("loaded"), nonce, id, sourceHash });
/**
 * Posted the moment before the worker calls a body for a render (Task 13 fix
 * round 1, controller ruling on I2). It tells the host's watchdog WHO held the
 * thread when a render goes unanswered: a render that started and never
 * answered wedged inside its own body; one that never started was blocked by
 * something that ran before it — work a body left behind after it returned (a
 * timer), which must not get the innocent overlay the watchdog happened to be
 * timing dropped.
 */
const startedSchema = z.object({ t: z.literal("started"), nonce, id, req: z.number().int().nonnegative() });
/**
 * Work a body left behind is about to run (Task 13 fix round 2): a timer or
 * animation-frame callback it set, or the settlement of one of its runtime
 * helpers (`loadImage`, `drawSvg`, `svgToImage`, the worker's font readiness),
 * or a three body's build. Every such callback was tagged with its owner when
 * it was scheduled (`lib/sandbox/runtime/async-owner.ts`), so a wedge inside
 * it — or in a microtask it queued, which runs inside the same window — is
 * blamed on `id` exactly, like a render that started and never answered.
 * Posted only when the window changes hands: consecutive callbacks of one
 * owner share one window, and a render's own callbacks ride its `started`.
 *
 * `sourceHash` names the BODY that scheduled the callback (fix round 3, N3):
 * a superseded version's leftover timer still runs until the worker installs
 * the new one, and charging it to the id's newest source dropped the new —
 * possibly fixed — body for the old one's wedge. Optional only for a render
 * of an id the worker holds no body for, which schedules nothing.
 */
const asyncSchema = z.object({ t: z.literal("async"), nonce, id, sourceHash: sourceHash.optional() });
/** The `async` window of `id` closed: the callback returned and every
 *  microtask it queued has run (posted from a later task, or just before the
 *  next `started` / `async` / render answer, whichever comes first). */
const asyncDoneSchema = z.object({ t: z.literal("asyncDone"), nonce, id });
const layerSchema = z.object({
  t: z.literal("layer"),
  nonce,
  id,
  frame: z.number().int(),
  req: z.number().int().nonnegative(),
  bitmap,
});
const errorSchema = z.object({
  t: z.literal("error"),
  nonce,
  id,
  phase: errorPhase,
  /** Bounded at the parser: a body controls this text and it flows into the
   *  render-diagnostics store and its PUT. The wire cap lives here; display
   *  truncation is the store's business. */
  message: z.string().max(2000),
  /** 1-based, mapped to the body's OWN source (runtime prologue subtracted). */
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  stack: z.string().max(8000).optional(),
  /** The `load` this failure belongs to, for `compile`/`build` (Task 5 ruling).
   *  Without it a compile error from a load the host already superseded is
   *  indistinguishable from its successor's, and the host had to reject the
   *  pending load on either. Absent for `render`, which has no load to name. */
  sourceHash: sourceHash.optional(),
  /** The `render` request this error ANSWERS. Only that in-flight render may be
   *  cleared by it: an error that answers nothing — an escape out of a body's
   *  promise, a superseded load's build error — must leave the overlay's next
   *  render in flight, or its real layer is closed on arrival and the overlay
   *  freezes on hold-last-good (Task 7 review I3, minor 8). */
  req: z.number().int().nonnegative().optional(),
  /** A render that failed because the body resized its canvas (re-review
   *  R-M3): the size the worker measured, through canvas getters it captured
   *  before any body ran, when it refused to transfer the layer. The host
   *  holds it to its OWN expected size before acting on it, and then drops
   *  the body exactly as it does for an oversized bitmap. */
  layerSize: z.object({ width: z.number().int().nonnegative(), height: z.number().int().nonnegative() }).optional(),
});
/** The answer to a `sample`: CURVE_FIELDS × samples float64s, field-major.
 *  The host re-checks every number (`sanitizeCurve`); this bounds the size. */
const curveSchema = z.object({
  t: z.literal("curve"),
  nonce,
  id,
  samples: z.number().int().min(2).max(MAX_CURVE_SAMPLES),
  data: z.custom<ArrayBuffer>(
    (v) => v instanceof ArrayBuffer && v.byteLength <= CURVE_FIELDS.length * MAX_CURVE_SAMPLES * 8,
    "expected a curve ArrayBuffer",
  ),
});
/**
 * A runtime diagnostic nothing ties to one overlay: a throw that escaped a
 * body's callback without an owner tag, a CSP refusal, a piece font that would
 * not install. The worker is one realm running every body, so "the overlay
 * last worked on" is a guess — and blaming a healthy sibling dropped its frames
 * (Task 7 review I3). It is reported, and it drops nothing.
 */
const unattributedSchema = z.object({
  t: z.literal("unattributed"),
  nonce,
  message: z.string().max(2000),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  stack: z.string().max(8000).optional(),
});

export const runtimeMessageSchema = z.discriminatedUnion("t", [
  loadedSchema,
  startedSchema,
  asyncSchema,
  asyncDoneSchema,
  layerSchema,
  errorSchema,
  unattributedSchema,
  curveSchema,
]);
export type LoadedMessage = z.infer<typeof loadedSchema>;
export type StartedMessage = z.infer<typeof startedSchema>;
export type AsyncMessage = z.infer<typeof asyncSchema>;
export type AsyncDoneMessage = z.infer<typeof asyncDoneSchema>;
export type LayerMessage = z.infer<typeof layerSchema>;
export type ErrorMessage = z.infer<typeof errorSchema>;
export type UnattributedMessage = z.infer<typeof unattributedSchema>;
export type CurveMessage = z.infer<typeof curveSchema>;
export type RuntimeMessage = z.infer<typeof runtimeMessageSchema>;

export function parseHostMessage(data: unknown): HostMessage | null {
  const r = hostMessageSchema.safeParse(data);
  return r.success ? r.data : null;
}

export function parseRuntimeMessage(data: unknown): RuntimeMessage | null {
  const r = runtimeMessageSchema.safeParse(data);
  return r.success ? r.data : null;
}

// ── the supervisor leg (A1 §1, §3) ──────────────────────────────────────────
// `ready` carries the MessagePort the host will talk to the worker on; `init`
// carries the worker's end. Ports are transferred, so they are duck-typed too.
export function isMessagePortLike(v: unknown): v is MessagePort {
  if (typeof v !== "object" || v === null) return false;
  const p = v as { postMessage?: unknown; close?: unknown };
  return typeof p.postMessage === "function" && typeof p.close === "function";
}
const messagePort = z.custom<MessagePort>(isMessagePortLike, "expected a MessagePort");

const readySchema = z.object({ t: z.literal("ready"), nonce, version: z.literal(PROTOCOL_VERSION), port: messagePort });
/** The supervisor could not bring a worker up (construction threw, or the
 *  worker fired `error`/`messageerror`). Without it the host sees only silence
 *  and its watchdog restarts forever with nothing to report. Bounded like the
 *  worker's own `error` — the text comes from a browser event. */
const supervisorErrorSchema = z.object({ t: z.literal("supervisorError"), nonce, message: z.string().max(2000) });
const supervisorReplySchema = z.discriminatedUnion("t", [
  readySchema,
  /** `id` echoes the ping it answers (re-review R-M5): a ping lost to a frame
   *  that was still loading must not pair every later pong one behind. */
  z.object({ t: z.literal("pong"), nonce, id: z.number().int().nonnegative().optional() }),
  supervisorErrorSchema,
]);
const workerInitSchema = z.object({ t: z.literal("init"), nonce, port: messagePort });

export type ReadyMessage = z.infer<typeof readySchema>;
export type SupervisorErrorMessage = z.infer<typeof supervisorErrorSchema>;
export type SupervisorReply = z.infer<typeof supervisorReplySchema>;
export type WorkerInit = z.infer<typeof workerInitSchema>;

export function parseSupervisorReply(data: unknown): SupervisorReply | null {
  const r = supervisorReplySchema.safeParse(data);
  return r.success ? r.data : null;
}
export function parseWorkerInit(data: unknown): WorkerInit | null {
  const r = workerInitSchema.safeParse(data);
  return r.success ? r.data : null;
}
