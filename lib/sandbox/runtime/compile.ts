/**
 * Body compilation for the sandboxed runtime (spec §4.3, §4.7).
 *
 * Two jobs: hand a body EXACTLY the documented context and nothing wide (no
 * `sourceCanvas`, `overlays`, `tracks`, `compiledDrawFns`, `threeScenes`,
 * `imageElements`, `videoFrameSources`, `codeContentBoxes`, `spatialQuads` —
 * those were never documented and are gone), and turn a thrown error into a
 * `BodyError` whose line/column point into the body's OWN source.
 *
 * The line mapping: `new Function(params, body)` wraps the body in a synthetic
 * `function anonymous(params\n) {\nBODY\n}`; V8 reports body frames as
 * `<anonymous>:LINE:COL` with LINE counted from that wrapper. The wrapper's
 * line count is MEASURED once at boot (`probeWrapperLineOffset`) rather than
 * assumed, so an engine that wraps differently still maps correctly. Only LINE
 * shifts — the body's first line starts at column 1 of the wrapper line, and
 * the helper names all ride the wrapper's single parameter line, so the offset
 * is independent of how many helpers are injected.
 * A compile-time SyntaxError from V8 carries no position, so `compile`-phase
 * errors ship the message alone.
 *
 * WHAT THE MAPPING IS NOT: a trust boundary. Everything it reads — the message,
 * the name, and `stack` itself — belongs to the body. Skipping the whole
 * `${name}: ${message}` head before looking for frames RESISTS the ordinary
 * case (a frame planted in a multi-line message), but it is not proof against a
 * determined body: a multi-line `name`, or an `e.stack` the body froze or wrote
 * itself, still chooses what the head looks like and which line is named first.
 * That is acceptable, because `line`/`column` are a DIAGNOSTIC AID pointing an
 * agent at its own code, not a claim about what ran. The actual containment is
 * the worker's isolation and the wire's length caps
 * (`lib/sandbox/protocol.ts`); nothing downstream may treat a position as
 * authenticated.
 *
 * This module runs inside the sandbox Worker (Amendment A1): it must never
 * touch `document`, `window`, or anything server-side.
 */
import { createDrawFunction, validateThreeFunction, THREE_PARAM_NAMES } from "@/lib/ai/scene-validator";
import type { CaptionCueWord } from "@/lib/captions/types";
import type { ErrorPhase, FrameTiming } from "@/lib/sandbox/protocol";

/** A body's own failure, positioned in the body's own source. `phase` is the
 *  wire's `ErrorPhase`: `compile` (never runs), `build` (a three body's factory
 *  call) or `render` (a per-frame call). */
export class BodyError extends Error {
  constructor(
    readonly phase: ErrorPhase,
    message: string,
    readonly line?: number,
    readonly column?: number,
    readonly bodyStack?: string,
  ) {
    super(message);
    this.name = "BodyError";
  }
}

/**
 * A render whose body resized its canvas (re-review R-M3): the layer came out
 * bigger than the render asked for, so the worker refuses to transfer it and
 * answers the render with this instead. `layerSize` rides to the host
 * (`ErrorMessage.layerSize`), which checks it against its own expectation and
 * drops the body. The host's own check on every `layer` stays the bound: this
 * only keeps a gigabyte from crossing the port first.
 */
export class OversizedLayerError extends BodyError {
  constructor(
    readonly layerSize: { width: number; height: number },
    asked: { width: number; height: number },
  ) {
    super(
      "render",
      `the body resized its canvas: the layer is ${layerSize.width}×${layerSize.height} device px, but ${asked.width}×${asked.height} was asked for`,
    );
    this.name = "OversizedLayerError";
  }
}

/** Exactly what a `code`/`tracked` body sees (spec §4.3, plus the `fps` the
 *  manual documents). Nothing else is reachable from it. */
export interface DrawBodyContext {
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  width: number;
  height: number;
  fps: number;
  frame: number;
  time: number;
  totalFrames: number;
  duration: number;
  progress: number;
  words?: CaptionCueWord[];
  /** This piece's image files, keyed by fileId (spec §4.3, §4.8). */
  images: Record<string, ImageBitmap>;
}

export type CompiledDraw = (context: DrawBodyContext) => unknown;

export function buildDrawBodyContext(input: {
  ctx: DrawBodyContext["ctx"];
  width: number;
  height: number;
  fps: number;
  time: FrameTiming;
  words?: CaptionCueWord[];
  images: Record<string, ImageBitmap>;
}): DrawBodyContext {
  const c: DrawBodyContext = {
    ctx: input.ctx,
    width: input.width,
    height: input.height,
    fps: input.fps,
    frame: input.time.frame,
    time: input.time.time,
    totalFrames: input.time.totalFrames,
    duration: input.time.duration,
    progress: input.time.progress,
    images: input.images,
  };
  if (input.words) c.words = input.words;
  return c;
}

const ANON_FRAME = /<anonymous>:(\d+):(\d+)/;
const ANON_FRAME_G = /<anonymous>:(\d+):(\d+)/g;
/** A V8 stack FRAME (`    at …`) as opposed to head or message text. Paired
 *  with skipping the whole head block (`headLineCount`), since the message is
 *  body-controlled: without both, a body writing `at <anonymous>:99:1` into its
 *  own `new Error(...)` chooses the line the editor jumps to. */
const STACK_FRAME = /^\s*at\s/;
/** The `eval at <fn> (<runtime file>:L:C), ` prefix V8 puts inside every frame
 *  that came out of a `new Function` body. It names the RUNTIME's own file, so
 *  it is stripped before the stack reaches a body author (spec §4.7). Lazy up to
 *  the first `),` and applied per FRAME: a bracket class cannot span a path that
 *  itself contains parentheses, and this repo ships `app/(app)/…`. */
const EVAL_AT_PREFIX = /\beval at .*?\),\s*/;

/** How many lines V8's `${name}: ${message}` head occupies. The message is
 *  body-controlled and may be multi-line, so the head is NOT always one line —
 *  assuming it was let a body write `at <anonymous>:99:1` into its own message
 *  and have it read as the first frame. */
function headLineCount(message: unknown): number {
  // A body owns its error object and may set `e.message = 5`; `split` on that
  // would crash the mapper, turning the body's bug into a runtime failure.
  // Coerced ONCE, here, so every caller below can treat the head as text.
  const m = typeof message === "string" ? message : String(message ?? "");
  return m ? m.split("\n").length : 1;
}

/** Frames of `stack` that point into a compiled body, message block excluded. */
function bodyFrames(stack: string, message?: string): string[] {
  return stack
    .split("\n")
    .slice(headLineCount(message))
    .filter((l) => STACK_FRAME.test(l) && ANON_FRAME.test(l));
}

export function firstAnonymousFrame(
  stack: string,
  message?: string,
): { line: number; column: number } | null {
  const frame = bodyFrames(stack, message)[0];
  if (!frame) return null;
  const m = frame.match(ANON_FRAME);
  return m ? { line: Number(m[1]), column: Number(m[2]) } : null;
}

/** The FIRST head line, plus only the frames that point into the body — the
 *  runtime's own file location stripped and each frame's line re-based onto the
 *  body's source so the stack agrees with `line`/`column`. The rest of a
 *  multi-line message is deliberately left out: it rides `BodyError.message`,
 *  and reprinting it here would put a body's fake `at …` text back in the stack.
 *  A frame that maps at or above the body's first line is dropped rather than
 *  shown with a wrapper-relative number that means nothing to the author. */
function sanitizeBodyStack(stack: string, wrapperLineOffset: number, message?: string): string {
  const head = stack.split("\n")[0];
  const rebased: string[] = [];
  for (const frame of bodyFrames(stack, message)) {
    let dropped = false;
    const mapped = frame.replace(EVAL_AT_PREFIX, "").replace(ANON_FRAME_G, (whole, ln: string, col: string) => {
      const line = Number(ln) - wrapperLineOffset;
      if (line <= 0) { dropped = true; return whole; }
      return `<anonymous>:${line}:${col}`;
    });
    if (!dropped) rebased.push(mapped);
  }
  return [head, ...rebased].join("\n");
}

/**
 * How many lines `new Function` puts in front of the body, measured by throwing
 * from a one-line body and reading back the line V8 reports. On V8 this is 2
 * (`function anonymous(\n) {\n`) — but it is measured, never assumed.
 */
export function probeWrapperLineOffset(): number {
  try {
    new Function("throw new Error('probe')")();
  } catch (err) {
    const loc = firstAnonymousFrame((err as Error).stack ?? "", (err as Error).message);
    if (loc) return loc.line - 1;
  }
  return 2;
}

let memoizedOffset: number | null = null;
/** The probe, measured once per runtime. Callers that have no offset in hand
 *  (the legacy `buildThreeInstance` callers) default to this. */
export function defaultWrapperLineOffset(): number {
  if (memoizedOffset === null) memoizedOffset = probeWrapperLineOffset();
  return memoizedOffset;
}

export function mapBodyError(err: unknown, phase: ErrorPhase, wrapperLineOffset: number): BodyError {
  if (err instanceof BodyError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  const loc = firstAnonymousFrame(stack, message);
  const line = loc ? loc.line - wrapperLineOffset : 0;
  if (loc && line > 0) {
    return new BodyError(phase, message, line, loc.column, sanitizeBodyStack(stack, wrapperLineOffset, message));
  }
  return new BodyError(
    phase,
    message,
    undefined,
    undefined,
    stack ? sanitizeBodyStack(stack, wrapperLineOffset, message) : undefined,
  );
}

/**
 * Compile a `code`/`tracked` draw body. Throws `BodyError("compile")` when the
 * denylist or the parser rejects it; the returned function throws
 * `BodyError("render")` positioned in the body's own source.
 */
export function compileDrawBody(
  source: string,
  helpers: Record<string, unknown>,
  wrapperLineOffset: number,
): CompiledDraw {
  let fn: (context: Record<string, unknown>) => unknown;
  try {
    fn = createDrawFunction(source, helpers);
  } catch (err) {
    throw mapBodyError(err, "compile", wrapperLineOffset);
  }
  return (context: DrawBodyContext) => {
    try {
      return fn(context as unknown as Record<string, unknown>);
    } catch (err) {
      throw mapBodyError(err, "render", wrapperLineOffset);
    }
  };
}

/**
 * Compile a `three` scene body into its factory over `THREE_PARAM_NAMES`.
 * Throws `BodyError("compile")`. CALLING the factory is the `build` phase and
 * belongs to the caller (`buildThreeInstance`), which wraps it accordingly.
 *
 * An EMPTY body compiles to a no-op factory rather than erroring. Routing the
 * old bare `new Function` through `validateThreeFunction` would otherwise start
 * rejecting a three overlay whose `sceneFunction` is empty — which renders an
 * empty scene today. This seam replaces HOW a body is compiled, not WHICH
 * bodies load; `validateThreeFunction` still rejects empty on the write paths.
 */
export function compileThreeBody(
  source: string,
  wrapperLineOffset: number,
): (...args: unknown[]) => unknown {
  if (source.trim().length === 0) return () => undefined;
  const verdict = validateThreeFunction(source);
  if (!verdict.valid) throw new BodyError("compile", verdict.error ?? "Invalid three scene function");
  try {
    return new Function(...[...THREE_PARAM_NAMES], source) as (...args: unknown[]) => unknown;
  } catch (err) {
    throw mapBodyError(err, "compile", wrapperLineOffset);
  }
}
