"use client";

import { useEffect, useRef, useState } from "react";
import type { Composition, Overlay } from "@/lib/engine/types";
import type { LayerRequest } from "@/lib/engine/layer-source";
import { compositionFrameAt } from "@/lib/engine/overlay-timing";
import { getOverlayBody } from "@/lib/overlays/code-fields";
import type { PersistedOverlay } from "@/lib/composition/persistence";
import { OverlaySandbox, type LoadInput, type RenderInput } from "@/lib/sandbox/host";
import { createIframeTransport } from "@/lib/sandbox/iframe-transport";
import { createInOriginTransport } from "@/lib/sandbox/in-origin-transport";
import { readOverlaySandboxMode } from "@/lib/sandbox/mode";
import { sha256Hex } from "@/lib/sandbox/hash";
import { collectSandboxFonts } from "@/lib/sandbox/fonts";
import { collectSandboxImages, sandboxImageElements } from "@/lib/sandbox/images";
import { PreviewLayerSource } from "@/lib/sandbox/preview-layers";
import type { BodyKind, ErrorMessage, ErrorPhase, FontPayload } from "@/lib/sandbox/protocol";

/** One overlay's body failure, as the render-diagnostics store records it. */
export interface RenderDiagnosticInput {
  overlayId: string;
  kind: BodyKind;
  phase: ErrorPhase;
  message: string;
  line?: number;
  column?: number;
  /** `render` errors: the composition time (seconds) of the frame that failed. */
  time?: number;
  /** `render` errors: that frame's absolute composition index. */
  frame?: number;
}

/** A runtime diagnostic no overlay can be blamed for (protocol `unattributed`:
 *  an untagged async throw, a CSP refusal, a font that would not install). A
 *  separate channel rather than an optional `overlayId` on
 *  `RenderDiagnosticInput`, so the per-overlay store keeps its key. */
export interface UnattributedDiagnosticInput {
  message: string;
  line?: number;
  column?: number;
}

export interface UseOverlayLayersOptions {
  /** The preview's resolved `<img>` elements, keyed by overlayId (useOverlayImages). */
  images: Record<string, HTMLImageElement>;
  /** The piece's render-diagnostics store (`lib/preview/render-diagnostics.ts`)
   *  — what the agent reads through `libi.get_piece_state`. */
  onDiagnostic?: (d: RenderDiagnosticInput) => void;
  onDiagnosticCleared?: (overlayId: string) => void;
  onUnattributed?: (d: UnattributedDiagnosticInput) => void;
  /** An unattributed diagnostic that no longer holds is withdrawn — today only
   *  the sandbox's "still starting" notice, once its frame loads (R2-M1). */
  onUnattributedCleared?: (message: string) => void;
  /** Which store the callbacks file under (the piece). When it changes every
   *  failure still on screen is announced again: an overlay the new piece
   *  shares with the old one (a duplicate keeps its overlay ids) is neither
   *  reloaded nor re-reported, so the new store would otherwise never hear. */
  diagnosticsKey?: string;
  /** False: no sandbox, no source (the player draws no body layers). */
  enabled?: boolean;
}

interface Body {
  overlay: Overlay;
  kind: BodyKind;
  source: string;
}

/** Everything one sandbox instance owns; a fresh one per sandbox, so a
 *  StrictMode remount or a re-enable starts from nothing. */
interface SandboxState {
  sb: OverlaySandbox;
  disposed: boolean;
  /** What was last handed to `sb.load` per overlay, and the key it was loaded
   *  under (source hash + whatever else forces a re-post). */
  loads: Map<string, { key: string; input: LoadInput }>;
  kinds: Map<string, BodyKind>;
  hashes: Map<string, { source: string; hash: string }>;
  /** Bumped by every error / timeout reported for an overlay: a load
   *  rejection after one is already explained. */
  errorSeq: Map<string, number>;
  /** Bumped by every restart and watchdog timeout: every load it rejected is
   *  replayed by the host, so the rejection explains nothing. */
  epoch: number;
  /** The last diagnostic sent per overlay: a boot failure repeats itself every
   *  backoff and a throwing body every frame, and the store needs it once.
   *  Kept whole so a new store (another piece) can be told again. */
  lastDiagnostic: Map<string, { signature: string; input: RenderDiagnosticInput }>;
  /** Overlays whose CURRENT diagnostic is a render error that answered request
   *  `req` for `frame`: only a layer answering a later request for that SAME
   *  frame proves the body now renders cleanly, and clears it. A clean
   *  different frame proves nothing — a body that throws from frame 60 on
   *  renders frame 20 fine, and clearing there told the agent a broken body
   *  was fixed. Any other diagnostic (compile, build, timeout, an async
   *  escape with no `req`) is absent here and holds until the source changes. */
  renderFailed: Map<string, { req: number; frame: number }>;
  /** Overlays that just got a compile/build error: a boot failure reports
   *  `build` and a `load` timeout for the same overlay in the same tick, and
   *  the timeout must not paper over the real reason. */
  failedThisTick: Set<string>;
  fontsKey: string | null;
  /** The "still starting" notice while it is up (R2-M1): announced again to a
   *  new store, like `lastDiagnostic`. */
  startingNotice: string | null;
  images: { key: string; bitmaps: Record<string, ImageBitmap> } | null;
  /** Image sets replaced by a reconcile that did not get to re-post every
   *  body holding them (a newer reconcile cancelled it). Closed by the next
   *  reconcile that finishes, once no load input references them. */
  retiredImages: Array<Record<string, ImageBitmap>>;
  /** Hand `input` to the sandbox and react to how that load ends. */
  issue(id: string, input: LoadInput): void;
  /** The overlay's body is healthy again (or gone): drop its badge and
   *  diagnostic. Called when a new source loads cleanly, when the overlay goes,
   *  and when the frame that failed renders cleanly (`renderFailed`). */
  clear(id: string): void;
  /** The overlay is gone: it no longer counts as loaded. */
  forgetLoaded(id: string): void;
}

function bodyKindOf(o: Overlay): BodyKind | null {
  if (o.kind === "code") return "code";
  if (o.kind === "three") return "three";
  if (o.kind === "tracked" && o.content.kind === "code") return "tracked";
  return null;
}

function bodiesOf(composition: Composition | null): Map<string, Body> {
  const out = new Map<string, Body>();
  for (const o of composition?.overlays ?? []) {
    const kind = bodyKindOf(o);
    if (kind) out.set(o.id, { overlay: o, kind, source: getOverlayBody(o as unknown as PersistedOverlay) ?? "" });
  }
  return out;
}

/** A body can reach piece images only through `loadImage`, so only such a body
 *  is handed (and re-posted for) the piece's bitmaps. */
function usesImages(source: string): boolean {
  return source.includes("loadImage");
}

function fontsKeyOf(fonts: readonly FontPayload[]): string {
  return fonts.map((f) => `${f.family}:${f.weight}:${f.data.byteLength}`).join("|");
}

function toRenderInput(req: LayerRequest): RenderInput {
  // Spread, never hand-copy: every field the request carries (pad above all —
  // tracked code renders offset without it) reaches the runtime.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { overlayId, kind, ...rest } = req;
  return { id: overlayId, ...rest };
}

function closeAll(bitmaps: Record<string, ImageBitmap>): void {
  for (const b of Object.values(bitmaps)) b.close();
}

function describeError(msg: Pick<ErrorMessage, "message" | "line" | "column">): string {
  const where = msg.line ? ` (line ${msg.line}${msg.column ? `:${msg.column}` : ""})` : "";
  return `${msg.message}${where}`;
}

function mountElement(): HTMLElement {
  let el = document.getElementById("libi-overlay-sandbox-mount");
  if (!el) {
    el = document.createElement("div");
    el.id = "libi-overlay-sandbox-mount";
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;";
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Owns the preview's OverlaySandbox (spec §4.5). Loads every code / three /
 * tracked-code body when its SOURCE HASH changes (not on composition identity —
 * which also fixes the old recompile-on-any-refetch), disposes removed
 * overlays, and exposes a PreviewLayerSource whose arrivals the player
 * subscribes to for an imperative repaint. `errors` drives the overlay badge.
 *
 * The sandbox (an iframe plus a worker) boots on the first body overlay, not
 * on mount — most pieces have none — and lives until unmount. No body ever
 * executes in this origin.
 */
export function useOverlayLayers(
  composition: Composition | null,
  opts: UseOverlayLayersOptions,
): {
  layers: PreviewLayerSource | null;
  errors: Record<string, string>;
  /** Overlays whose body the runtime has loaded cleanly at least once (the
   *  sandbox analogue of the old "has a compiled draw fn"). Changes only when a
   *  load lands or an overlay goes — never per frame. */
  loadedBodies: ReadonlySet<string>;
} {
  const enabled = opts.enabled !== false;
  // One source for the life of the hook, so the player's subscription never
  // churns; the lifecycle effect connects it to whichever sandbox is live.
  const [source] = useState(() => new PreviewLayerSource());
  const stateRef = useRef<SandboxState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const errorsRef = useRef<Record<string, string>>({});
  const [loadedBodies, setLoadedBodies] = useState<ReadonlySet<string>>(() => new Set());
  const optsRef = useRef(opts);
  const compositionRef = useRef(composition);
  useEffect(() => {
    optsRef.current = opts;
    compositionRef.current = composition;
  });

  // Latched: once a body has appeared the sandbox stays up, so deleting the
  // last code overlay and undoing does not reboot a worker.
  const hasBodies = bodiesOf(composition).size > 0;
  const [active, setActive] = useState(false);
  if (enabled && hasBodies && !active) setActive(true);
  const live = enabled && active;

  useEffect(() => {
    if (!live) return;
    const setError = (id: string, message: string | null) => {
      // A body that throws on every frame reports on every frame: re-publishing
      // an unchanged map would re-render the whole preview surface at 30 Hz.
      if (message === null ? !(id in errorsRef.current) : errorsRef.current[id] === message) return;
      const next = { ...errorsRef.current };
      if (message === null) delete next[id];
      else next[id] = message;
      errorsRef.current = next;
      setErrors(next);
    };
    const markLoaded = (id: string, loaded: boolean) => {
      setLoadedBodies((prev) => {
        if (prev.has(id) === loaded) return prev;
        const next = new Set(prev);
        if (loaded) next.add(id);
        else next.delete(id);
        return next;
      });
    };
    const report = (id: string, phase: ErrorPhase, message: string, line?: number, column?: number, at?: { time: number; frame: number }) => {
      st.errorSeq.set(id, (st.errorSeq.get(id) ?? 0) + 1);
      st.renderFailed.delete(id);
      setError(id, describeError({ message, line, column }));
      const signature = JSON.stringify([phase, message, line ?? null, column ?? null]);
      if (st.lastDiagnostic.get(id)?.signature === signature) return;
      const kind = st.kinds.get(id);
      if (!kind) return;
      const input: RenderDiagnosticInput = { overlayId: id, kind, phase, message, line, column, ...(at ?? {}) };
      st.lastDiagnostic.set(id, { signature, input });
      optsRef.current.onDiagnostic?.(input);
    };
    /** An overlay-local frame on the composition timeline: its absolute
     *  frame, and that frame's second to the millisecond (a request's `fps` is
     *  the composition's). */
    const compositionAt = (id: string, frame: number, fps: number): { time: number; frame: number } | undefined => {
      const start = compositionRef.current?.overlays?.find((o) => o.id === id)?.startTime;
      if (start === undefined || !(fps > 0)) return undefined;
      return compositionFrameAt(frame, start, fps);
    };
    // Constructed before the state that holds it; every callback reads `st`
    // when it fires, which is never during construction.
    const sb = new OverlaySandbox({
      // The layout's meta says "in-origin" only under the dev-only
      // LIBI_OVERLAY_SANDBOX=0 (lib/sandbox/mode.ts): the same worker, no iframe.
      createTransport: (nonce) =>
        readOverlaySandboxMode(document) === "in-origin"
          ? createInOriginTransport(nonce)
          : createIframeTransport(mountElement(), nonce),
      onLayer: (msg) => {
        source.accept(msg);
        const failed = st.renderFailed.get(msg.id);
        if (failed && msg.req > failed.req && msg.frame === failed.frame) st.clear(msg.id);
      },
      onError: (msg) => {
        const loaded = st.loads.get(msg.id);
        if (!loaded) return; // an overlay already gone
        // A late compile/build error from a load that was superseded says
        // nothing about the body on screen now.
        if (msg.sourceHash && msg.sourceHash !== loaded.input.sourceHash) return;
        // What the failed render was for — read before `release` forgets it.
        const failedRequest = msg.req !== undefined ? source.requestFor(msg.id, msg.req) : undefined;
        if (msg.phase === "compile" || msg.phase === "build") {
          // The load failed: nothing will render for it.
          source.release(msg.id);
          st.failedThisTick.add(msg.id);
          queueMicrotask(() => st.failedThisTick.delete(msg.id));
        } else if (msg.req !== undefined) {
          // Ends exactly the render it answers — an error for an OLDER render
          // leaves the newer one in flight. An async escape with no `req`
          // ends none: dropping one would freeze a working layer.
          source.release(msg.id, msg.req);
        }
        const at =
          msg.phase === "render" && failedRequest ? compositionAt(msg.id, failedRequest.frame, failedRequest.fps) : undefined;
        report(msg.id, msg.phase, msg.message, msg.line, msg.column, at);
        if (msg.phase === "render" && msg.req !== undefined && failedRequest) {
          st.renderFailed.set(msg.id, { req: msg.req, frame: failedRequest.frame });
        }
      },
      onUnattributed: (msg) => {
        optsRef.current.onUnattributed?.({ message: msg.message, line: msg.line, column: msg.column });
      },
      onTimeout: (id, phase, afterMs, reason) => {
        // The host abandoned EVERY pending load and render and asked for a
        // fresh worker; the offender stays dropped for its current source.
        st.epoch++;
        source.releaseAll();
        // A boot failure names its real reason as a `build` error just before
        // this; "timed out" would overwrite it with a symptom.
        if (phase === "load" && st.failedThisTick.has(id)) return;
        // The budget that actually ran out: a first render gets the load one.
        // A drop that was not a timeout (a port flood) says what it was.
        report(id, phase === "render" ? "render" : "build", reason ?? `timed out after ${Math.round(afterMs / 1000)} s`);
      },
      onRestart: () => {
        // A fresh worker: nothing in flight will be answered, and the host is
        // about to replay its source cache. Re-issuing the same inputs joins
        // those replays (one post each) and is how this hook learns they
        // landed — the replay's own promises are the host's.
        st.epoch++;
        source.releaseAll();
        for (const [id, { input }] of st.loads) st.issue(id, input);
      },
      onFrameStarting: (message) => {
        // A frame that has not loaded after 20 s is said so, unattributed,
        // and withdrawn once it loads — rather than bodies drawing nothing,
        // with nothing said, until the frame is given up on minutes later.
        const was = st.startingNotice;
        st.startingNotice = message;
        if (message) optsRef.current.onUnattributed?.({ message });
        else if (was) optsRef.current.onUnattributedCleared?.(was);
      },
      onFontsInstalled: () => {
        // A font-only change re-renders nothing by itself: a paused preview's
        // next request equals the one its held bitmap answers and is skipped,
        // so that bitmap keeps the fallback font (Task 9 re-review). Every
        // body may name the new family.
        for (const id of st.loads.keys()) source.markStale(id);
        source.invalidate();
      },
    });
    const st: SandboxState = {
      sb,
      disposed: false,
      loads: new Map(),
      kinds: new Map(),
      hashes: new Map(),
      errorSeq: new Map(),
      epoch: 0,
      lastDiagnostic: new Map(),
      renderFailed: new Map(),
      failedThisTick: new Set(),
      fontsKey: null,
      startingNotice: null,
      images: null,
      retiredImages: [],
      clear(id) {
        st.lastDiagnostic.delete(id);
        st.renderFailed.delete(id);
        setError(id, null);
        optsRef.current.onDiagnosticCleared?.(id);
      },
      forgetLoaded(id) {
        markLoaded(id, false);
      },
      issue(id, input) {
        const seq = st.errorSeq.get(id) ?? 0;
        const epoch = st.epoch;
        const current = () => !st.disposed && st.loads.get(id)?.input === input;
        st.sb.load(input).then(
          () => {
            // A load also resolves WITHOUT posting (port down, source dropped
            // after a timeout): only a body the worker holds clears the badge.
            if (!current() || !st.sb.isLoaded(id)) return;
            st.clear(id);
            markLoaded(id, true);
            // The held bitmap is the previous body's, and frames drawn while
            // this one could not render asked for nothing that will arrive: a
            // paused preview must ask again, even for the same frame.
            source.markStale(id);
            source.invalidate();
          },
          (err: unknown) => {
            // Superseded, removed, replayed after a restart, or already
            // reported through onError / onTimeout: nothing new to say. What
            // is left is a failure only this promise knows about (a bitmap
            // that would not clone for transfer).
            if (!current() || st.epoch !== epoch || (st.errorSeq.get(id) ?? 0) !== seq) return;
            report(id, "build", err instanceof Error ? err.message : String(err));
          },
        );
      },
    };
    stateRef.current = st;
    source.connect((req) => st.sb.render(toRenderInput(req)));

    return () => {
      st.disposed = true;
      if (stateRef.current === st) {
        stateRef.current = null;
        source.connect(null);
      }
      st.sb.destroy();
      source.reset();
      if (st.images) closeAll(st.images.bitmaps);
      for (const set of st.retiredImages.splice(0)) closeAll(set);
      // The badges go with the sandbox; the diagnostics store is NOT cleared —
      // the bodies did not get healthier because the preview went away.
      errorsRef.current = {};
      setErrors({});
      setLoadedBodies(new Set());
    };
  }, [live, source]);

  useEffect(() => {
    const st = stateRef.current;
    if (!live || !st || !composition) return;
    let cancelled = false;
    const stale = () => cancelled || st.disposed;
    const bodies = bodiesOf(composition);
    for (const id of Array.from(st.loads.keys())) {
      if (bodies.has(id)) continue;
      st.loads.delete(id);
      st.kinds.delete(id);
      st.hashes.delete(id);
      st.sb.dispose(id);
      source.forget(id);
      st.clear(id);
      st.forgetLoaded(id);
    }
    if (bodies.size === 0) return;

    const overlays = composition.overlays ?? [];
    const imageElements = opts.images;
    (async () => {
      // Set when this pass swaps the image set; the old set is closed only
      // once every body holding it has been re-posted with the new one.
      let retired: Record<string, ImageBitmap> | null = null;
      let finished = false;
      try {
        const fonts = await collectSandboxFonts(overlays);
        if (stale()) return;
        const fontsKey = fontsKeyOf(fonts);
        if (fontsKey !== st.fontsKey) {
          // The host posts a changed set at once when a worker holds a body,
          // else with the next load.
          st.fontsKey = fontsKey;
          st.sb.setFonts(fonts);
        }

        // Piece images, as bitmaps, only when some body can use them — and
        // decoded again only when the set of loaded image files changed.
        let images: Record<string, ImageBitmap> | undefined;
        if (Array.from(bodies.values()).some((b) => usesImages(b.source))) {
          const elements = sandboxImageElements(overlays, imageElements);
          const key = Array.from(elements.keys()).sort().join(",");
          if (st.images?.key !== key) {
            const bitmaps = await collectSandboxImages(overlays, imageElements);
            if (stale()) {
              closeAll(bitmaps);
              return;
            }
            retired = st.images?.bitmaps ?? null;
            st.images = { key, bitmaps };
          }
          images = st.images.bitmaps;
        } else if (st.images) {
          // No body reads images any more: stop holding decoded bitmaps. Every
          // body that did is re-posted below without them (its key changed).
          retired = st.images.bitmaps;
          st.images = null;
        }
        const imageKey = st.images?.key ?? "";

        for (const [id, body] of bodies) {
          let hash = st.hashes.get(id);
          if (hash?.source !== body.source) {
            hash = { source: body.source, hash: await sha256Hex(body.source) };
            if (stale()) return;
            st.hashes.set(id, hash);
          }
          const withImages = usesImages(body.source);
          const cameraPreset = body.overlay.kind === "three" ? (body.overlay.cameraPreset ?? "billboard") : null;
          const key = `${hash.hash}|${cameraPreset ?? ""}|${withImages ? imageKey : ""}`;
          const prev = st.loads.get(id);
          if (prev?.key === key) continue;
          const input: LoadInput = {
            id,
            kind: body.kind,
            source: body.source,
            sourceHash: hash.hash,
            // The protocol requires a positive load size (the render carries the
            // real per-frame one); a zero here would null the load and loop the
            // 5 s watchdog.
            width: Math.max(1, body.overlay.rect?.width || 1),
            height: Math.max(1, body.overlay.rect?.height || 1),
            ...(withImages && images ? { images } : {}),
            ...(cameraPreset ? { three: { cameraPreset, pixelRatio: 1 as const } } : {}),
          };
          if (prev && prev.input.sourceHash === hash.hash) {
            // The host skips a load whose hash the worker already holds, so a
            // new camera preset or image set for the SAME body goes through a
            // dispose first (the held bitmap stays on screen meanwhile). The
            // dispose abandons a render in flight without an answer, so the
            // slot is freed with it — else it waits on that render for good.
            st.sb.dispose(id);
            source.release(id);
          }
          st.loads.set(id, { key, input });
          st.kinds.set(id, body.kind);
          st.issue(id, input);
        }
        finished = true;
      } catch (err) {
        // Nothing awaited here is meant to throw (the font and image helpers
        // swallow their own failures), but a throw would otherwise end this
        // pass as an unhandled rejection and leave every body after it
        // unloaded with nothing said. No one overlay is to blame.
        if (!stale()) {
          optsRef.current.onUnattributed?.({
            message: `the preview could not prepare its code overlays: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } finally {
        if (retired) st.retiredImages.push(retired);
        if (st.disposed) {
          for (const set of st.retiredImages.splice(0)) closeAll(set);
        } else if (finished) {
          // A retired set is closed once no load input holds it. Normally every
          // body that held it was re-posted with the current set (its key
          // changed); but a pass cut short and a key that then REVERTED can
          // leave a body skipped with the old set, which it and the host's
          // replay cache still reference (Task 9 re-review). That set stays
          // retired until the body lets go of it — or the sandbox goes.
          const held = new Set<Record<string, ImageBitmap>>();
          for (const { input } of st.loads.values()) if (input.images) held.add(input.images);
          st.retiredImages = st.retiredImages.filter((set) => {
            if (held.has(set)) return true;
            closeAll(set);
            return false;
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [composition, live, source, opts.images]);

  // After the reconcile above (effects run in order), so an overlay the new
  // piece does not have has already been dropped and is not re-announced.
  const diagnosticsKey = opts.diagnosticsKey;
  const announcedKey = useRef(diagnosticsKey);
  useEffect(() => {
    if (announcedKey.current === diagnosticsKey) return;
    announcedKey.current = diagnosticsKey;
    const st = stateRef.current;
    if (!st || st.disposed) return;
    for (const { input } of st.lastDiagnostic.values()) optsRef.current.onDiagnostic?.(input);
    if (st.startingNotice) optsRef.current.onUnattributed?.({ message: st.startingNotice });
  }, [diagnosticsKey]);

  return { layers: enabled ? source : null, errors, loadedBodies };
}
