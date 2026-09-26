/**
 * The helper bag a body sees inside the worker: every documented DRAW_HELPER,
 * with `loadImage` replaced by a shim that honours where it runs — a worker
 * with `fetch` removed and no `Image`. `/api/files/by-id/<id>/content`
 * resolves from the bitmaps the host transferred in `load` (spec §4.3, §4.8);
 * `data:` URLs decode locally (drawing.ts, `createImageBitmap`); `blob:` URLs
 * would need `fetch` and are refused; anything else is refused with a message
 * that says what IS available. `drawSvg` / `svgToImage` still ATTEMPT a
 * decode, but no Chromium rasterizes SVG off the main thread, so inside the
 * worker they reject with a message that says what to use instead (drawing.ts).
 *
 * Every async helper here is wrapped so its rejection carries the id of the
 * overlay whose helper bag it came from (`errorOwner`). A rejection a body
 * leaves unhandled reaches the worker's global `unhandledrejection` in a later
 * task, when the host's per-frame batch has long moved on to another overlay;
 * the tag is the only reliable way to say whose it was (Task 7 review I3).
 *
 * The same wrapper settles each helper's promise inside its owner's `async`
 * window (`async-owner.ts`, Task 13 fix round 2): the `.then` a body chains on
 * `loadImage(...)` runs in a later task, and if it never returns, the host
 * blames the body that chained it — not whichever sibling it was timing.
 */
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import { loadImage as loadImageEngine } from "@/lib/engine/drawing";
import type { AsyncOwner, Owner } from "./async-owner";

/** error object → id of the overlay whose helper rejected with it. Bodies share
 *  one realm, but this map lives in the runtime's module scope, out of reach.
 *  Its operations are captured at module evaluation, before any body exists,
 *  like the Map intrinsics in `layers.ts` and `async-owner.ts` (final security
 *  review, M6): a body that patched `WeakMap.prototype.get` could otherwise
 *  steer which overlay an escaped rejection is charged to. */
const reflectApply = Reflect.apply;
const weakMapGet = WeakMap.prototype.get;
const weakMapHas = WeakMap.prototype.has;
const weakMapSet = WeakMap.prototype.set;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const owners = new WeakMap<object, string>();

/** The overlay an escaped rejection belongs to, or null when nothing ties it
 *  to one (a body's own throw, a non-object reason). */
export function errorOwner(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  return (reflectApply(weakMapGet, owners, [err]) as string | undefined) ?? null;
}

/** Tag a helper's rejection with its owner. An `async` wrapper rather than
 *  `.catch()`, so a patched `Promise.prototype.catch` is not handed this
 *  closure directly. That is not a guarantee against a hostile body: `await`
 *  reads `promise.constructor` (PromiseResolve), and a body that installs a
 *  `Promise.prototype.constructor` getter gets a patched `then` called here,
 *  through which it can tag any object as another overlay's error (Task 7
 *  re-review N2). What holds is the port — no path from here reaches it.
 *  Attribution under a hostile body in the shared realm is not guaranteed:
 *  spec amendment A3. */
function owned<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  who: Owner,
  settle: AsyncOwner["settleAs"] | undefined,
): (...args: A) => Promise<R> {
  const ownerId = who.id;
  const tagged = async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (typeof err === "object" && err !== null && !reflectApply(weakMapHas, owners, [err])) {
        reflectApply(weakMapSet, owners, [err, ownerId]);
      }
      throw err;
    }
  };
  return settle ? (...args: A) => settle(who, tagged(...args)) : tagged;
}

/** Relative only (final security review, M1): the documented form is
 *  `/api/files/by-id/<id>/content` (mcp/templates/instructions.md), and the
 *  studio's port is not stable across launches, so an absolute URL naming
 *  some host was never "this piece's own file". */
const FILE_CONTENT_URL = /^\/api\/files\/by-id\/([^/?#]+)\/content(?:[?#].*)?$/;

export function fileIdFromUrl(src: string): string | null {
  const m = FILE_CONTENT_URL.exec(src);
  return m ? m[1]! : null;
}

export function runtimeLoadImage(
  src: string,
  images: Record<string, ImageBitmap>,
  loadDom: (src: string) => Promise<CanvasImageSource> = loadImageEngine,
): Promise<CanvasImageSource> {
  const fileId = fileIdFromUrl(src);
  if (fileId) {
    // An OWN property only: `constructor` or `__proto__` would otherwise
    // resolve through Object.prototype (final security review, M1).
    const bitmap = reflectApply(hasOwnProperty, images, [fileId]) ? images[fileId] : undefined;
    return bitmap
      ? Promise.resolve(bitmap)
      : Promise.reject(
          new Error(
            `loadImage: file ${fileId} is not one of this piece's image files (only files placed on the timeline as image overlays are available to a body)`,
          ),
        );
  }
  if (/^data:/i.test(src)) return loadDom(src);
  return Promise.reject(
    new Error(
      `loadImage: only data: URLs and this piece's own files (/api/files/by-id/<id>/content) are available inside an overlay body; got ${src.slice(0, 80)}`,
    ),
  );
}

type AsyncHelper = (...args: never[]) => Promise<unknown>;

/** `images` is a getter because the map is per overlay and may be replaced by
 *  a later `load` without recompiling the body. `ownerId` is the overlay this
 *  bag is compiled into — what its helpers' rejections are tagged with — and
 *  `sourceHash` the body: together, whose window their settlements enter
 *  (`owner`, the runtime's). */
export function makeRuntimeHelpers(
  images: () => Record<string, ImageBitmap>,
  ownerId: string,
  owner?: Pick<AsyncOwner, "settleAs">,
  sourceHash: string | null = null,
): Record<string, unknown> {
  const settle = owner?.settleAs;
  const who: Owner = { id: ownerId, sourceHash };
  return {
    ...DRAW_HELPERS,
    loadImage: owned((src: string) => runtimeLoadImage(src, images()), who, settle),
    drawSvg: owned(DRAW_HELPERS.drawSvg as AsyncHelper, who, settle),
    svgToImage: owned(DRAW_HELPERS.svgToImage as AsyncHelper, who, settle),
  };
}
