/**
 * Per-overlay layers inside the sandbox WORKER (spec §4.4, §4.9, A1 §2).
 *
 * For every loaded overlay id: the compiled body and one OffscreenCanvas sized
 * to the last render (or, for `three`, the built instance, whose layer is its
 * renderer's own GL canvas), the transferred images, and the content-fit probe
 * cached per size and timeline. `render` clears the layer, applies the
 * pixelRatio, the pad offset (tracked code: the layer reaches past the box so
 * a label above it still lands) and the SAME contain-fit the host applied
 * before (moved here so the body's coordinate space is unchanged), runs the body under
 * `drawWithBalancedState`, and hands back `transferToImageBitmap()`.
 *
 * Everything the worker provides is injected (canvas factory, clock, font
 * installer, three deps) so the engine runs under jsdom in unit tests. Fonts
 * install on `self.fonts` — the worker's FontFaceSet (there is no document).
 */
import { drawWithBalancedState } from "@/lib/engine/canvas-state";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";
import type { DrawContext } from "@/lib/engine/types";
import { contentFitOps, measureCodeContentBox, segmentContentBox, type ContentBox, type ProbeBudgetStop } from "@/lib/overlays/code-content-fit";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";
import { FIT_CACHE_SIZE, IDLE_LAYER_MS, contentFitKey, type FontPayload, type LoadMessage, type RenderMessage } from "@/lib/sandbox/protocol";
import { BodyError, OversizedLayerError, buildDrawBodyContext, compileDrawBody, mapBodyError, type CompiledDraw } from "./compile";
import type { AsyncOwner, OwnedTimers } from "./async-owner";
import { makeRuntimeHelpers } from "./helpers";
import type { ThreeRuntimeDeps } from "./three";

/**
 * `Map.prototype.get`, captured at module evaluation — before any body exists
 * (fix round 4, NEW-1). `sourceHashOf` names the body a render runs, and that
 * name is the hash every `async` window the render opens carries to the host.
 * Read through the realm's live `get`, a body that patched it could hand its
 * own windows the hash of a version the host has superseded, and a wedge in
 * them would restart the worker without dropping the body that did it.
 */
const reflectApply = Reflect.apply;
const mapGet = Map.prototype.get;
/**
 * `Map.prototype.set` and `delete`, captured with `get` (Task 13 re-review 3,
 * M5): an entry stored through a patched `set` could carry any hash — a body's
 * NEXT version claiming the one the host just superseded — and a patched
 * `delete` could leave a disposed entry answering `sourceHashOf`.
 */
const mapSet = Map.prototype.set;
const mapDelete = Map.prototype.delete;
/**
 * `has`, `values` and the Map iterator's `next`, captured with the rest (Task
 * 14 review m2): a patched `has` could make `isLoaded` lie, and a patched
 * `values` or `next` could hide entries from `evictIdle` and keep their pixels
 * alive. Iteration goes through the captured `next` by hand — `for…of` would
 * read the realm's live one.
 */
const mapHas = Map.prototype.has;
const mapValues = Map.prototype.values;
const mapIteratorNext = (Object.getPrototypeOf(new Map().values()) as Iterator<unknown>).next;
/**
 * `OffscreenCanvas`'s `width` / `height` getters, captured with the rest
 * (re-review R-M3), so a layer is measured before it is transferred by what
 * the canvas really is: a body can shadow `width` on its canvas, or patch the
 * prototype's getter, but neither reaches a getter captured before it ran,
 * called through the captured `Reflect.apply`. A three body that swapped its
 * renderer's canvas is measured too — `render` reads whatever canvas the
 * renderer returns. Undefined where the realm has no `OffscreenCanvas` (unit
 * tests under jsdom, which inject plain canvases).
 */
const canvasWidth: (() => number) | undefined =
  typeof OffscreenCanvas === "undefined" ? undefined : Object.getOwnPropertyDescriptor(OffscreenCanvas.prototype, "width")?.get;
const canvasHeight: (() => number) | undefined =
  typeof OffscreenCanvas === "undefined" ? undefined : Object.getOwnPropertyDescriptor(OffscreenCanvas.prototype, "height")?.get;
/**
 * `console.debug`, captured before any body runs, for the one runtime notice
 * that is not a failure: a content-fit probe stopped by its own time budget
 * (tag `overlay-sandbox`). The worker has no logger; its console is the
 * page's DevTools. Undefined where the realm has none.
 */
const debugLog: ((...args: unknown[]) => void) | undefined =
  typeof console !== "undefined" && typeof console.debug === "function" ? console.debug.bind(console) : undefined;
/** How far a layer may exceed its asked size, per axis — the host's own slack. */
const LAYER_SIZE_SLACK_PX = 1;

/**
 * The layer about to be transferred, held to the size this render allocated:
 * bigger, and it is not transferred — the render answers with an
 * `OversizedLayerError`, which the host turns into a drop. Hygiene only: the
 * host checks every `layer` it receives against its own expectation.
 */
function checkLayerSize(canvas: OffscreenCanvas, asked: { width: number; height: number }): void {
  let got: { width: number; height: number };
  try {
    got =
      canvasWidth && canvasHeight
        ? { width: reflectApply(canvasWidth, canvas, []) as number, height: reflectApply(canvasHeight, canvas, []) as number }
        : { width: canvas.width, height: canvas.height };
  } catch {
    // Not an OffscreenCanvas at all (a three body that swapped its
    // renderer's canvas for something else): nothing that can be sized.
    throw new BodyError("render", "the body replaced its canvas: the layer is not a canvas the runtime can measure");
  }
  if (got.width > asked.width + LAYER_SIZE_SLACK_PX || got.height > asked.height + LAYER_SIZE_SLACK_PX) {
    throw new OversizedLayerError(got, asked);
  }
}

/** Layers not rendered for this long release their canvas (spec §4.9). The
 *  constant lives in the protocol: the host times the re-probe it causes. */
export { IDLE_LAYER_MS };

export interface LayerEngineDeps {
  makeCanvas(width: number, height: number): OffscreenCanvas;
  now(): number;
  wrapperLineOffset: number;
  three?: ThreeRuntimeDeps;
  installFont?(font: FontPayload): Promise<void>;
  measureContentBox?: typeof measureCodeContentBox;
  /** The runtime's owner tracking (async-owner.ts): helper settlements and a
   *  three body's build run inside the body's own window. */
  asyncOwner?: Pick<AsyncOwner, "enter" | "settleAs">;
  /** The runtime's wrapped timers: a body that is disposed or replaced loses
   *  the timers, intervals and animation frames it left pending. */
  ownedTimers?: Pick<OwnedTimers, "cancelOwnedBy">;
  /** Debug notices (a content-fit probe stopped by its time budget).
   *  Defaults to the worker's `console.debug`, captured before any body ran. */
  debug?(message: string, data: Record<string, unknown>): void;
}

interface FitOps {
  scale: number;
  dx: number;
  dy: number;
}

interface Fit {
  key: string;
  /** The union ink box, in the coordinates of the size it was measured at
   *  (`at`); null when there is nothing to fit (no ink, a failed probe). */
  box: ContentBox | null;
  at: { width: number; height: number };
}

/** Below this, a fit is the identity: float noise, never a real zoom (M10). */
const FIT_IDENTITY_EPS = 1e-9;

interface Entry {
  kind: LoadMessage["kind"];
  sourceHash: string;
  threeKey: string | null;
  /** The 2D layer a `code`/`tracked` body paints; null for `three`, whose
   *  layer is its renderer's own GL canvas. */
  layer: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null;
  draw: CompiledDraw | null;
  three: ThreeOverlayInstance | null;
  images: Record<string, ImageBitmap>;
  /** Measured fits, oldest first, at most `FIT_CACHE_SIZE` — a plain array
   *  walked by index, so no realm method a body could patch is involved. */
  fits: Fit[];
  lastRenderedAt: number;
  /** Nothing allocated at its render size: never rendered, or evicted since. */
  released: boolean;
}

/** A piece font that would not install (corrupt, or a format the browser
 *  refuses). Not fatal: text drawn in it falls back to another font. */
export interface FontFailure {
  family: string;
  weight: number;
  message: string;
}

export interface LoadResult {
  fontFailures: FontFailure[];
}

/** WorkerGlobalScope.fonts — the worker's own FontFaceSet (spec §4.8, A1 §2). */
async function installFontDefault(font: FontPayload): Promise<void> {
  const face = new FontFace(font.family, font.data, { weight: String(font.weight) });
  await face.load();
  (self as unknown as { fonts: FontFaceSet }).fonts.add(face);
}

function threeKeyOf(msg: LoadMessage): string | null {
  return msg.kind === "three" ? `${msg.three?.cameraPreset ?? "billboard"}::${msg.sourceHash}` : null;
}

export class LayerEngine {
  readonly stats = { compiles: 0, builds: 0 };
  private readonly entries = new Map<string, Entry>();
  /** `family/weight` → its install, settled or in progress. A failed install
   *  is removed again, so the next load that carries the font retries it. */
  private readonly fontInstalls = new Map<string, Promise<void>>();
  private readonly installFont: (font: FontPayload) => Promise<void>;
  private readonly measure: typeof measureCodeContentBox;

  constructor(private readonly deps: LayerEngineDeps) {
    this.installFont = deps.installFont ?? installFontDefault;
    this.measure = deps.measureContentBox ?? measureCodeContentBox;
  }

  isLoaded(id: string): boolean {
    return reflectApply(mapHas, this.entries, [id]) as boolean;
  }

  /** The entry installed for `id`, looked up through the captured `get`. */
  private entryOf(id: string): Entry | undefined {
    return reflectApply(mapGet, this.entries, [id]) as Entry | undefined;
  }

  private setEntry(id: string, entry: Entry): void {
    reflectApply(mapSet, this.entries, [id, entry]);
  }

  private deleteEntry(id: string): void {
    reflectApply(mapDelete, this.entries, [id]);
  }

  /** Every installed entry, walked with the captured `values` and `next`. */
  private allEntries(): Entry[] {
    const out: Entry[] = [];
    const it = reflectApply(mapValues, this.entries, []) as Iterator<Entry>;
    for (let r = reflectApply(mapIteratorNext, it, []) as IteratorResult<Entry>; !r.done; r = reflectApply(mapIteratorNext, it, []) as IteratorResult<Entry>) {
      out[out.length] = r.value;
    }
    return out;
  }

  /** The body installed for `id` — what a render of it runs. */
  sourceHashOf(id: string): string | null {
    return this.entryOf(id)?.sourceHash ?? null;
  }

  /**
   * Install the fonts, then compile (or build) the body. Loads and disposes of
   * ONE id must be serialized by the caller (`attachRuntime` does): across the
   * awaits below an older load would otherwise install over a newer one, or
   * two three builds would share the id's renderer (Task 7 review I2).
   *
   * A font that fails to install does NOT fail the load — the fonts ride
   * whichever load comes first after a (re)start, so failing it would blame an
   * unrelated overlay and park it; it is returned for the caller to report.
   */
  async load(msg: LoadMessage): Promise<LoadResult> {
    const fontFailures = msg.fonts ? await this.installFonts(msg.fonts) : [];
    const prev = this.entryOf(msg.id);
    const images = msg.images ?? prev?.images ?? {};
    const threeKey = threeKeyOf(msg);
    if (prev && prev.kind === msg.kind && prev.sourceHash === msg.sourceHash && prev.threeKey === threeKey) {
      // New bitmaps for an unchanged body: the old ones are nobody's now.
      if (images !== prev.images) for (const bitmap of Object.values(prev.images)) bitmap.close();
      prev.images = images;
      return { fontFailures };
    }

    // A changed body replaces the entry: dispose the old one FIRST, so the
    // three pool's per-id renderer is released before it is re-acquired below
    // (the host keeps the last-good bitmap; the runtime keeps nothing stale).
    // The timers it left pending go with it only when the SOURCE changed: a
    // recompile of the same 2D body (a new kind) is still that body, and one
    // that started a timer once, behind state that outlives the recompile,
    // would lose it for good (fix round 4, NEW-3). A three body is the
    // exception (Task 13 re-review 3, M3): a rebuild re-runs its factory with
    // fresh closure state, so the old instance's timers are nobody's — kept,
    // they would run beside the new instance's and pin the disposed scene.
    if (prev) {
      const rebuildsThree = prev.kind === "three" || msg.kind === "three";
      this.disposeEntry(msg.id, prev, {
        keepImages: images === prev.images,
        keepTimers: prev.sourceHash === msg.sourceHash && !rebuildsThree,
      });
      this.deleteEntry(msg.id);
    }
    let draw: CompiledDraw | null = null;
    let three: ThreeOverlayInstance | null = null;
    const entryRef: { current: Entry | null } = { current: null };
    let layer: Entry["layer"] = null;
    if (msg.kind === "three") {
      if (!this.deps.three) throw new BodyError("build", "three.js is not available in this runtime");
      const threeDeps = this.deps.three;
      try {
        // Inside the try: a renderer that will not come up (no WebGL context)
        // is this load's failure too, and must reach the host as `build`.
        const shared = await threeDeps.acquire(msg.id);
        three = await threeDeps.build(
          msg.source,
          msg.three?.cameraPreset,
          shared,
          { width: msg.width, height: msg.height },
          this.deps.wrapperLineOffset,
          () => this.deps.asyncOwner?.enter({ id: msg.id, sourceHash: msg.sourceHash }),
        );
        await three.ready;
      } catch (err) {
        // The renderer was acquired for an id that now holds no entry; hand it
        // back or the pool's cap leaks one dedicated WebGL context per failure.
        three?.dispose();
        threeDeps.release(msg.id);
        throw mapBodyError(err, "build", this.deps.wrapperLineOffset);
      }
      this.stats.builds++;
    } else {
      draw = compileDrawBody(
        msg.source,
        makeRuntimeHelpers(() => entryRef.current?.images ?? images, msg.id, this.deps.asyncOwner, msg.sourceHash),
        this.deps.wrapperLineOffset,
      );
      this.stats.compiles++;
      const canvas = this.deps.makeCanvas(1, 1);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new BodyError("build", "OffscreenCanvas 2D context unavailable");
      layer = { canvas, ctx: ctx as OffscreenCanvasRenderingContext2D };
    }

    const entry: Entry = {
      kind: msg.kind,
      sourceHash: msg.sourceHash,
      threeKey,
      layer,
      draw,
      three,
      images,
      fits: [],
      lastRenderedAt: this.deps.now(),
      released: true,
    };
    entryRef.current = entry;
    this.setEntry(msg.id, entry);
    // The contain-fit probe is deliberately NOT run here. It EXECUTES the body,
    // and a load that runs the body puts a body that never returns on the wrong
    // side of the watchdog: the 5 s load timeout instead of the 2 s render one,
    // with the host's `load` promise rejected for a body that compiled fine
    // (measured live, 2026-09-23, with `while (true) {}`). The first render
    // probes and caches it (spec §4.7).
    return { fontFailures };
  }

  private async installFonts(fonts: FontPayload[]): Promise<FontFailure[]> {
    const failures: FontFailure[] = [];
    for (const font of fonts) {
      const key = `${font.family}/${font.weight}`;
      let install = this.fontInstalls.get(key);
      if (!install) {
        install = (async () => this.installFont(font))();
        this.fontInstalls.set(key, install);
      }
      try {
        await install;
      } catch (err) {
        if (this.fontInstalls.get(key) === install) this.fontInstalls.delete(key);
        failures.push({ family: font.family, weight: font.weight, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }

  render(msg: RenderMessage): ImageBitmap {
    const entry = this.entryOf(msg.id);
    if (!entry) throw new BodyError("render", `overlay ${msg.id} is not loaded`);
    entry.lastRenderedAt = this.deps.now();
    entry.released = false;

    if (entry.kind === "three") {
      const w = Math.max(1, Math.ceil(msg.size.width * msg.pixelRatio));
      const h = Math.max(1, Math.ceil(msg.size.height * msg.pixelRatio));
      const inst = entry.three;
      if (!inst) throw new BodyError("render", `overlay ${msg.id} has no three instance`);
      let gl: OffscreenCanvas;
      try {
        inst.update?.({
          frame: msg.time.frame,
          time: msg.time.time,
          totalFrames: msg.time.totalFrames,
          duration: msg.time.duration,
          progress: msg.time.progress,
          transform3d: msg.transform3d,
          words: msg.words,
        });
        inst.applyTransform(msg.transform3d ?? IDENTITY_TRANSFORM3D);
        gl = inst.render(w, h) as OffscreenCanvas;
      } catch (err) {
        throw mapBodyError(err, "render", this.deps.wrapperLineOffset);
      }
      checkLayerSize(gl, { width: w, height: h });
      return gl.transferToImageBitmap();
    }

    const layer = entry.layer;
    if (!layer) throw new BodyError("render", `overlay ${msg.id} has no layer`);
    // A 2D layer covers the body's box plus its pad (tracked code: room for a
    // label above the box, a glow around it). The body still sees the box as
    // width/height with its origin at the box's top-left.
    const pad = msg.pad ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const w = Math.max(1, Math.ceil((pad.left + msg.size.width + pad.right) * msg.pixelRatio));
    const h = Math.max(1, Math.ceil((pad.top + msg.size.height + pad.bottom) * msg.pixelRatio));
    if (layer.canvas.width !== w || layer.canvas.height !== h) {
      layer.canvas.width = w;
      layer.canvas.height = h;
    }
    const ctx = layer.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(msg.pixelRatio, 0, 0, msg.pixelRatio, 0, 0);
    ctx.save();
    if (pad.left || pad.top) ctx.translate(pad.left, pad.top);
    if (entry.kind === "code") {
      const fit = this.contentFit(entry, msg);
      if (fit) {
        ctx.translate(fit.dx, fit.dy);
        ctx.scale(fit.scale, fit.scale);
      }
    }
    try {
      drawWithBalancedState(ctx as unknown as CanvasRenderingContext2D, () => {
        entry.draw!(
          buildDrawBodyContext({
            ctx,
            width: msg.size.width,
            height: msg.size.height,
            fps: msg.fps,
            time: msg.time,
            words: msg.words,
            images: entry.images,
          }),
        );
      });
    } finally {
      ctx.restore();
    }
    checkLayerSize(layer.canvas, { width: w, height: h });
    return layer.canvas.transferToImageBitmap();
  }

  /** The host's old `codeContentBoxes` probe, now here. Each measured box is
   *  cached per `contentFitKey` — measured size, timeline and caption words —
   *  in a small LRU, so a resize, trim, retime or new words re-probe and
   *  scrubbing back over a tween does not. Inside a keyframed-size segment
   *  (`msg.fitSegment`) the box is measured at the segment's ends and
   *  midpoint(s) and interpolated for this frame's size
   *  (`segmentContentBox`). The keys are touched in `contentFitKeys` order
   *  (a prefix of it), which the host's budget LRU mirrors. Best-effort like the host's: a probe that blows up leaves the
   *  layer un-fitted rather than failing the load or the frame. */
  private contentFit(entry: Entry, msg: RenderMessage): FitOps | null {
    let box: ContentBox | null;
    if (msg.fitSegment) {
      box = segmentContentBox(msg.fitSegment.from, msg.fitSegment.to, msg.size, (at) => this.fitAt(entry, msg, at).box);
    } else {
      box = this.fitAt(entry, msg, msg.size).box;
    }
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const f = contentFitOps(box, msg.size.width, msg.size.height);
    const identity = Math.abs(f.scale - 1) < FIT_IDENTITY_EPS && Math.abs(f.dx) < FIT_IDENTITY_EPS && Math.abs(f.dy) < FIT_IDENTITY_EPS;
    return identity ? null : f;
  }

  /** The fit measured at `at`, from the LRU or probed now; either way it
   *  becomes the most recently used. */
  private fitAt(entry: Entry, msg: RenderMessage, at: { width: number; height: number }): Fit {
    const key = contentFitKey(at, msg);
    const fits = entry.fits;
    let fit: Fit | null = null;
    for (let i = 0; i < fits.length; i++) {
      if (fits[i]!.key === key) {
        fit = fits[i]!;
        for (let j = i; j < fits.length - 1; j++) fits[j] = fits[j + 1]!;
        fits.length = fits.length - 1;
        break;
      }
    }
    if (!fit) fit = this.probeFit(entry, msg, key, at);
    fits[fits.length] = fit;
    if (fits.length > FIT_CACHE_SIZE) {
      for (let j = 0; j < fits.length - 1; j++) fits[j] = fits[j + 1]!;
      fits.length = fits.length - 1;
    }
    return fit;
  }

  private probeFit(entry: Entry, msg: RenderMessage, key: string, at: { width: number; height: number }): Fit {
    // The probe must see EXACTLY the render context, or it measures a body
    // that behaves differently from the one that will paint: `measureCodeContentBox`
    // hands out the host renderer's older, wider shape (`assets`, `renderScale`),
    // so only the documented fields are carried across — on THIS render's
    // timeline (fps / totalFrames / duration), with its caption words.
    const probe = (probeCtx: DrawContext) =>
      void entry.draw!(
        buildDrawBodyContext({
          ctx: probeCtx.ctx,
          width: probeCtx.width,
          height: probeCtx.height,
          fps: probeCtx.fps,
          time: {
            frame: probeCtx.frame,
            time: probeCtx.time,
            totalFrames: probeCtx.totalFrames,
            // `DrawContext` types these optional (the host renderer always
            // populates them, and so does `measureCodeContentBox`).
            duration: probeCtx.duration ?? 0,
            progress: probeCtx.progress ?? 0,
          },
          words: msg.words,
          images: entry.images,
        }),
      );
    let box: ContentBox | null = null;
    try {
      box = this.measure(
        probe,
        at.width,
        at.height,
        { fps: msg.fps, totalFrames: msg.time.totalFrames, duration: msg.time.duration },
        {
          makeCanvas: (w, h) => this.deps.makeCanvas(w, h),
          now: this.deps.now,
          onBudgetStop: (stop: ProbeBudgetStop) =>
            (this.deps.debug ?? debugLog)?.("[overlay-sandbox] content-fit probe stopped by its time budget", {
              tag: "overlay-sandbox",
              op: "fit_probe_budget",
              id: msg.id,
              ...stop,
            }),
        },
      );
    } catch {
      box = null;
    }
    return { key, box, at };
  }

  dispose(id: string): void {
    const entry = this.entryOf(id);
    if (!entry) return;
    // Both flags spelled out (Task 13 re-review 3, M2): an options object
    // without its own properties reads them off `Object.prototype`, which a
    // body in this realm can set — `keepTimers: true` there kept every
    // disposed body's timers alive.
    this.disposeEntry(id, entry, { keepImages: false, keepTimers: false });
    this.deleteEntry(id);
  }

  /** `keepImages`: a reload of the same id without new bitmaps carries the
   *  old ones forward, so they must not be closed here. `keepTimers`: the
   *  reload installs the same 2D source, whose pending timers are still its
   *  own. Both are required — see `dispose`. */
  private disposeEntry(id: string, entry: Entry, keep: { keepImages: boolean; keepTimers: boolean }): void {
    // First: nothing the old body left pending may run once it is gone.
    if (keep.keepTimers !== true) this.deps.ownedTimers?.cancelOwnedBy(id);
    entry.three?.dispose();
    if (entry.kind === "three") this.deps.three?.release(id);
    if (keep.keepImages !== true) for (const bitmap of Object.values(entry.images)) bitmap.close();
    if (entry.layer) {
      entry.layer.canvas.width = 1;
      entry.layer.canvas.height = 1;
    }
  }

  /** Release the pixels of every layer idle longer than `olderThanMs` — a code
   *  layer's canvas, a three layer's GL drawing buffer. The body stays compiled
   *  (or built) so the next render is one clear + draw away. */
  evictIdle(olderThanMs: number = IDLE_LAYER_MS): number {
    const cutoff = this.deps.now() - olderThanMs;
    let evicted = 0;
    const entries = this.allEntries();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.released || entry.lastRenderedAt >= cutoff) continue;
      if (entry.layer) {
        entry.layer.canvas.width = 1;
        entry.layer.canvas.height = 1;
      } else {
        entry.three?.releaseDrawingBuffer?.();
      }
      entry.fits = [];
      entry.released = true;
      evicted++;
    }
    return evicted;
  }
}
