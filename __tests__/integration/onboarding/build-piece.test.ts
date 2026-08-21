/**
 * The build is what a new user's first two minutes are. This exercises the
 * real path — real sockets, real bytes, real sha256s, the real persistence
 * seams — because the only untested link is then whether GCS serves the
 * bytes, which is exactly what Friday's release verification covers.
 *
 * Fixtures come from docs-local/onboarding-v1/assets (gitignored). Skip with a
 * loud message rather than a silent pass when they are absent — a green run
 * that downloaded nothing is worse than a red one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import {
  startOnboardingAssetServer,
  haveOnboardingFixtures,
  missingFixturesMessage,
  type OnboardingAssetServer,
} from "../../helpers/onboarding-asset-server";
import { ONBOARDING_ASSETS_V1 } from "@/lib/onboarding/piece/v1/assets";
import { ONBOARDING_PIECE_V1 } from "@/lib/onboarding/piece/v1";
import type { CompositionManifest, PersistedOverlay } from "@/lib/composition/persistence";
import type { DrawContext, Overlay } from "@/lib/engine/types";
import type {
  OnboardingPieceParams,
  OnboardingPieceResult,
} from "@/lib/jobs/runners/onboarding-piece";

let storageRoot: string;

// getStorage() caches a module-level singleton; re-point it at the temp dir
// (mirrors create-piece-empty.test.ts). `storageRoot` is read lazily inside
// the factory, so assigning it in beforeAll is fine.
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

// Record what the build asks the job layer for. `proxy_gen` in particular must
// NOT be among it — see the "enqueues no proxy jobs" test below.
const { enqueueSpy } = vi.hoisted(() => ({ enqueueSpy: vi.fn() }));
vi.mock("@/mcp/jobs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/jobs-client")>();
  return {
    ...actual,
    enqueueJobOnServer: async (...args: unknown[]) => {
      enqueueSpy(...args);
      // No libi server in a unit run; the real call would reject and
      // `logProxyGenEnqueueFailure` would swallow it. Reject the same way so
      // the mock cannot make a broken enqueue path look healthy.
      throw new Error("no libi server in tests");
    },
  };
});

const SLUGS = ONBOARDING_ASSETS_V1.map((a) => a.slug);
const HAVE_FIXTURES = haveOnboardingFixtures(SLUGS);
if (!HAVE_FIXTURES) process.stderr.write(`\n${missingFixturesMessage()}\n\n`);

let server: OnboardingAssetServer;
let result: OnboardingPieceResult;

function pieceStorageDir(pieceId: string): string {
  return join(storageRoot, "storage", pieceId);
}

async function runRunner(
  params: OnboardingPieceParams,
  onProgress: (done: number) => void = () => {},
): Promise<OnboardingPieceResult> {
  const { onboardingPieceRunner } = await import("@/lib/jobs/runners/onboarding-piece");
  return onboardingPieceRunner.run({
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    params,
    resumeState: null,
    reportProgress: (done: number) => onProgress(done),
    checkpoint: async () => {},
    shouldCancel: () => false,
  });
}

async function fileExistsOnDisk(fileId: string): Promise<boolean> {
  const { getDb } = await import("@/lib/db/client");
  const { files } = await import("@/lib/db/schema/sqlite");
  const { eq } = await import("drizzle-orm");
  const [row] = getDb().select().from(files).where(eq(files.id, fileId)).all();
  if (!row || !row.pieceId) return false;
  return fs.existsSync(join(pieceStorageDir(row.pieceId), row.filename));
}

/** The rect slot D's tracking clip is mounted in, straight off the definition
 *  — the region the reticle must live inside. */
const PANEL = (() => {
  const video = ONBOARDING_PIECE_V1.overlays.find(
    (o) => o.kind === "video" && o.assetSlug === "clip-track-demo.mp4",
  );
  if (!video) throw new Error("the definition no longer mounts clip-track-demo.mp4");
  return { x: video.rect.x, y: video.rect.y, w: video.rect.width, h: video.rect.height };
})();

/**
 * The bounding box of RETICLE GREEN inside `region` of a rendered PNG, or null
 * when there is none.
 *
 * Measuring pixels rather than the box the renderer resolved is the point: the
 * box is now baked INTO the draw function, so asserting the number the code
 * was generated from would be circular. `#34d399` at full alpha is drawn by
 * the reticle's corner brackets and by nothing else inside this panel at these
 * timestamps — the scene's telemetry chips use the same green but sit below
 * the panel, and the roaming "scanning" overlay has ended by 17.5 s.
 */
function greenBoxIn(
  canvas: RenderedCanvas,
  region: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
  const { data } = canvas.getContext("2d").getImageData(region.x, region.y, region.w, region.h);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      const i = (y * region.w + x) * 4;
      // Within 25/255 of rgb(52,211,153) on every channel. The corner brackets
      // paint that colour at full alpha, so a tight window still finds them —
      // and it has to be tight: the scene's "track complete ✓" card comes in
      // at 22.0 s in #8ef0c0, whose antialiased edges land in a loose green
      // window and would make "no reticle after the overlay ends" pass or fail
      // for the wrong reason.
      if (
        Math.abs(data[i] - 52) <= 25 &&
        Math.abs(data[i + 1] - 211) <= 25 &&
        Math.abs(data[i + 2] - 153) <= 25
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;
  return {
    x: region.x + minX,
    y: region.y + minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}

/** Just enough of an @napi-rs/canvas surface for what these tests read off it. */
type RenderedCanvas = {
  getContext(kind: "2d"): { getImageData(x: number, y: number, w: number, h: number): ImageData };
  toBuffer(mime: "image/png"): Buffer;
};

/**
 * Render one composited frame with @napi-rs/canvas — the REAL `renderFrame`
 * and the real compiled overlay code. See the reticle tests below for why
 * these are real renders and not structural import-graph assertions.
 *
 * NO TRACKS ARE PASSED, and there is nothing to pass: the film ships none.
 * Slot D's reticle is a plain code overlay whose boxes are baked into its draw
 * function, so the render that used to depend on a sidecar + a `tracks` row +
 * `/api/tracks/:id` now depends on the composition alone.
 */
async function renderFrameToCanvas(
  manifest: CompositionManifest,
  frame: number,
  onOverlayDraw?: Record<string, (ctx: DrawContext) => void>,
): Promise<RenderedCanvas> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const { renderFrame } = await import("@/lib/engine/renderer");
  const { buildComposition } = await import("@/lib/composition/build-composition");
  const { createDrawFunction } = await import("@/lib/ai/scene-validator");
  const { DRAW_HELPERS } = await import("@/lib/engine/draw-helpers");
  const { getOverlayBody } = await import("@/lib/overlays/code-fields");
  const { ensureBundledFontsRegistered } = await import("@/lib/fonts/register-server");
  const { getDb } = await import("@/lib/db/client");
  const { files: filesTable } = await import("@/lib/db/schema/sqlite");
  const { eq } = await import("drizzle-orm");

  ensureBundledFontsRegistered();

  // The REAL file rows, not an empty map: `buildComposition` copies
  // `mediaWidth/mediaHeight` onto each video overlay as `sourceWidth/Height`,
  // and hydrates each overlay's media URL from them. Rendering with an empty
  // map would silently exercise the unprobed-file fallback instead of the path
  // a user's editor takes.
  const fileRows = getDb()
    .select()
    .from(filesTable)
    .where(eq(filesTable.pieceId, result.pieceId))
    .all();
  const filesById = new Map(fileRows.map((f) => [f.id, f]));

  const overlays = (manifest.overlays ?? []) as Overlay[];
  const composition = buildComposition(filesById, overlays, []);

  const compiled: Record<string, (ctx: DrawContext) => void> = {};
  for (const o of manifest.overlays ?? []) {
    const body = getOverlayBody(o);
    if (!body) continue;
    const fn = createDrawFunction(body, DRAW_HELPERS) as unknown as (ctx: DrawContext) => void;
    const spy = onOverlayDraw?.[o.id];
    compiled[o.id] = spy
      ? (ctx: DrawContext) => {
          spy(ctx);
          fn(ctx);
        }
      : fn;
  }

  const canvas = createCanvas(manifest.width, manifest.height);
  renderFrame(
    canvas as unknown as HTMLCanvasElement,
    composition,
    frame,
    {},
    undefined,
    undefined,
    compiled,
    // Deliberately empty. A film that needed a track here could not render one
    // — this is the assertion, not an omission.
    {},
  );
  return canvas as unknown as RenderedCanvas;
}

describe.skipIf(!HAVE_FIXTURES)("onboarding piece build — round trip", () => {
  beforeAll(async () => {
    storageRoot = createTempStorageDir();
    createTestDb();
    server = await startOnboardingAssetServer();
    process.env.LIBI_ONBOARDING_ASSET_BASE = server.baseEnvValue;
    result = await runRunner({ version: "v1", force: false });
  }, 180_000);

  afterAll(async () => {
    delete process.env.LIBI_ONBOARDING_ASSET_BASE;
    await server?.close();
    resetTestDb();
    cleanupTempDir();
  });

  it("downloads and verifies all 21 assets", () => {
    expect(result.assets).toBe(21);
    expect(result.reused).toBe(false);
    expect(result.bytes).toBe(
      ONBOARDING_ASSETS_V1.reduce((n, a) => n + a.bytes, 0),
    );
  });

  it("files the clips as video and the voice-over as audio, despite the bucket", async () => {
    // The fixture server (and any bucket that never set an object's type)
    // declares `application/octet-stream`. Landing as type "other" skips
    // storeFile's ffprobe pass, so the video overlays get no source dims — and
    // the tracked reticle then has nothing to map its boxes with. Two guards
    // now stop that: the asset definition's own contentType, and
    // fetchRemoteBuffer's octet-stream fallback.
    const { getDb } = await import("@/lib/db/client");
    const { files } = await import("@/lib/db/schema/sqlite");
    const rows = getDb().select().from(files).where(eq(files.pieceId, result.pieceId)).all();
    const byType = new Map(rows.map((r) => [r.filename, r.type]));
    expect(byType.get("clip-track-demo.mp4")).toBe("video");
    expect(rows.filter((r) => r.type === "audio").length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.type === "other")).toHaveLength(0);

    const clip = rows.find((r) => r.filename === "clip-track-demo.mp4")!;
    expect(clip.mediaWidth).toBe(1920);
    expect(clip.mediaHeight).toBe(1080);
  });

  it("enqueues no proxy jobs — this film is watched, not scrubbed", () => {
    // A proxy landing mid-playback emits `refresh_query`, re-runs
    // `buildComposition`, and swaps three overlays' `videoUrl` under a
    // brand-new user who is watching the piece for the first time. The
    // sources are already <=1080p, so the only thing given up is GOP density
    // for scrubbing.
    const kinds = enqueueSpy.mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain("proxy_gen");
  });

  it("reloads through loadManifest as the film we defined", async () => {
    const { loadManifest } = await import("@/lib/composition/persistence");
    const { getCompositionFrames } = await import("@/lib/engine/renderer");
    const m = await loadManifest(result.pieceId);
    // No scenes: the six beats are full-frame code overlays at z 0 now.
    expect((m as { scenes?: unknown }).scenes).toBeUndefined();
    expect(m.overlays).toHaveLength(26);
    expect((m.overlays ?? []).filter((o) => o.z === 0)).toHaveLength(6);
    expect(m.audioClips).toHaveLength(15);
    // The 10-second hold has to survive save/load, not just exist in the source.
    expect(getCompositionFrames(m as never)).toBe(1560);
  });

  it("keeps both ducks pointed at all six voice-over clips", async () => {
    const { loadManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest(result.pieceId);
    const ducked = (m.audioClips ?? []).filter((c) => c.duck);
    expect(ducked).toHaveLength(2);
    for (const c of ducked) expect(c.duck?.sidechainClipIds).toHaveLength(6);
  });

  it("resolved every slug to a real local file", async () => {
    const { loadManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest(result.pieceId);
    const ids = [
      ...(m.audioClips ?? []).map((c) => c.fileId),
      ...(m.overlays ?? []).map((o) => (o as { fileId?: string }).fileId),
    ].filter(Boolean) as string[];
    expect(new Set(ids).size).toBe(21);
    for (const id of new Set(ids)) expect(await fileExistsOnDisk(id)).toBe(true);
    // No `assetSlug` survived the rewrite anywhere in the manifest.
    expect(JSON.stringify(m)).not.toContain("assetSlug");
  });

  it("hydrates all ten code-bearing overlays", async () => {
    const { loadManifest } = await import("@/lib/composition/persistence");
    const { getOverlayBody } = await import("@/lib/overlays/code-fields");
    const m = await loadManifest(result.pieceId);
    // `code-c5da91a2` is slot D's reticle — a plain code overlay whose draw
    // function carries the baked track boxes. It is by far the largest of the
    // ten bodies (136 rows of coordinates), so a truncated round trip through
    // the per-overlay file would show up here first. The six `SLOT` bodies
    // joined this list when the canvas-scene layer was retired.
    const coded = (m.overlays ?? []).filter((o) => (getOverlayBody(o) ?? "").length > 0);
    expect(coded.map((o) => o.id).sort()).toEqual([
      "code-558ob5uw",
      "code-5jls8n94",
      "code-89f4sluc",
      "code-c5da91a2",
      "code-mryim9r3",
      "code-n4yq9kv5",
      "code-p7kvftuj",
      "code-sn2li53l",
      "code-t8jwcdp3",
      "code-t9hx2cb7",
    ]);
    expect(coded).toHaveLength(10);
    const reticle = coded.find((o) => o.id === "code-c5da91a2")!;
    expect(getOverlayBody(reticle)).toContain("track: sneaker");
  });

  it("writes no track sidecar and no tracks row — the film ships neither", async () => {
    // The replacement for two tests that asserted the opposite. Slot D's
    // reticle used to be a real `tracked` overlay over a real 145-sample
    // track, which the runner wrote twice (sidecar + `tracks` row) and minted
    // a machine-local id for. All of that existed for ONE overlay, and the
    // overlay no longer needs it: the boxes are baked into its draw function.
    //
    // Asserted at every level the old mechanism touched, because "we stopped
    // doing it" is exactly the kind of change that half-reverts.
    const { getDb } = await import("@/lib/db/client");
    const { tracks } = await import("@/lib/db/schema/sqlite");
    const { loadManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest(result.pieceId);

    expect((m.overlays ?? []).filter((o) => o.kind === "tracked")).toHaveLength(0);
    expect(JSON.stringify(m)).not.toContain('"trackId"');
    expect(getDb().select().from(tracks).all()).toHaveLength(0);
    // Nothing under the piece's storage dir looks like a track sidecar.
    const dir = pieceStorageDir(result.pieceId);
    expect(fs.readdirSync(dir).filter((f) => f.includes("track") && f.endsWith(".json"))).toEqual(
      [],
    );
  });

  it("draws the reticle on the sneaker, from the composition alone", async () => {
    // THE test this feature turns on, and the form of evidence has not
    // changed: real pixels off a real `renderFrame`, at the timestamp the
    // hand-verified target frame was captured at
    // (docs-local/onboarding-v1/slot-d-frames/slotd-timespace-18_5s.png).
    //
    // What changed is what it takes to get them. The old path needed a track
    // sidecar, a `tracks` row, `GET /api/tracks/:id`, `findTrackOwnerVideo`
    // and a source→composition mapping, and it drew NOTHING when any link
    // broke. This render is handed an empty track map on purpose: if the
    // reticle still lands on the shoe, nothing in that chain is load-bearing
    // any more.
    //
    // Measured off the PIXELS rather than the resolved box, because the box is
    // now baked into the draw function — asserting the number the code was
    // generated from would be circular. The reticle's corner brackets are the
    // only #34d399 inside the slot-D panel at this timestamp.
    const { loadManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest(result.pieceId);

    let reticleDraws = 0;
    let drawSize: { w: number; h: number } | null = null;
    const png = await renderFrameToCanvas(m, Math.round(18.5 * 30), {
      "code-c5da91a2": (c) => {
        reticleDraws += 1;
        drawSize = { w: c.width, h: c.height };
      },
    });
    expect(reticleDraws).toBe(1);
    // The draw fn is handed the RECT, full-frame — the box translate happens
    // inside the body now, not in the renderer.
    expect(drawSize).toEqual({ w: 1920, h: 1080 });

    const box = greenBoxIn(png, PANEL);
    expect(box, "no reticle green inside the slot-D panel").not.toBeNull();

    // The sneaker at 18.5 s. Tolerance is 4px: the corner brackets are a 5px
    // round-capped stroke inset 3px from the box, so the ink bbox sits within
    // a couple of pixels of the box itself.
    expect(Math.abs(box!.x - 626.6)).toBeLessThanOrEqual(4);
    expect(Math.abs(box!.y - 299.8)).toBeLessThanOrEqual(4);
    expect(Math.abs(box!.w - 794.3)).toBeLessThanOrEqual(4);
    expect(Math.abs(box!.h - 412.3)).toBeLessThanOrEqual(4);

    // Inside the panel the clip is mounted in — before the engine fix that
    // shipped alongside the real track, this drew at frame scale and overhung.
    expect(box!.x).toBeGreaterThanOrEqual(PANEL.x);
    expect(box!.x + box!.w).toBeLessThanOrEqual(PANEL.x + PANEL.w);
    expect(box!.y).toBeGreaterThanOrEqual(PANEL.y);
    expect(box!.y + box!.h).toBeLessThanOrEqual(PANEL.y + PANEL.h);
  }, 60_000);

  it("follows the sneaker across the shot, and stops when the overlay does", async () => {
    // One frame proves placement; these prove it is a PATH and not a constant.
    // The box travels right and shrinks as the sneaker moves away — measured
    // off pixels at three timestamps, plus a fourth after the overlay's window
    // where there must be no reticle at all.
    const { loadManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest(result.pieceId);

    const at = async (seconds: number) =>
      greenBoxIn(await renderFrameToCanvas(m, Math.round(seconds * 30)), PANEL);

    const early = await at(17.6);
    const mid = await at(20);
    const late = await at(21.9);
    for (const [label, b] of [["17.6", early], ["20", mid], ["21.9", late]] as const) {
      expect(b, `no reticle at ${label}s`).not.toBeNull();
    }
    // Rightward and smaller, monotonically — the shape of this shot.
    expect(mid!.x).toBeGreaterThan(early!.x);
    expect(late!.x).toBeGreaterThan(mid!.x);
    expect(mid!.w).toBeLessThan(early!.w);
    expect(late!.w).toBeLessThan(mid!.w);

    // The overlay ends at 22.0. Nothing green in the panel after that — a
    // draw fn that clamped to its last box forever would fail here.
    expect(await at(22.5)).toBeNull();
  }, 60_000);

  it("needs no tracking engine, and no track, to place it", async () => {
    // The demo has to work on a machine that never downloaded the 2 GB
    // tracking sidecar — and now on one that never provisions the local
    // tracking model either, which is the whole point of the bake.
    //
    // Proof by removal: strip the reticle overlay and the same render has no
    // reticle green in the panel. Nothing else in slot D draws it, so the
    // pixels measured above came from this overlay's baked boxes and from
    // nowhere else.
    const { loadManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest(result.pieceId);
    const without: CompositionManifest = {
      ...m,
      overlays: (m.overlays ?? []).filter((o) => o.id !== "code-c5da91a2") as PersistedOverlay[],
    };
    const canvas = await renderFrameToCanvas(without, Math.round(18.5 * 30));
    expect(canvas.toBuffer("image/png").byteLength).toBeGreaterThan(0);
    expect(greenBoxIn(canvas, PANEL)).toBeNull();
  }, 60_000);

  it("dedupes: a second build of the same version returns the same piece", async () => {
    const before = server.servedCount();
    const again = await runRunner({ version: "v1", force: false });
    expect(again.pieceId).toBe(result.pieceId);
    expect(again.reused).toBe(true);
    // Reuse means reuse: not one byte was re-downloaded.
    expect(server.servedCount()).toBe(before);
  }, 60_000);

  it("ignores a marked piece that a killed build left without a manifest", async () => {
    // The rollback covers a THROWN failure. It cannot cover the user quitting
    // the app mid-download, an OOM, or a power cut — and what those would leave
    // behind, if the marker were stamped at creation, is a half-built piece
    // that every later force:false build hands back as `reused: true`. That is
    // the worst outcome available on a first-run demo: the user gets exactly
    // the broken artifact the rollback exists to prevent, and cannot escape it
    // without knowing to pass `force`.
    const { getDb } = await import("@/lib/db/client");
    const { pieces } = await import("@/lib/db/schema/sqlite");
    const { onboardingMarker } = await import("@/lib/jobs/runners/onboarding-piece");

    // Backdate the real demo so the ghost is unambiguously the NEWEST marked
    // row. Without this the two share a `unixepoch()` second and the
    // `desc(id)` tiebreak decides by random UUID — the test would then pass
    // half the time with the manifest guard removed, which is no test at all.
    // (Verified by mutation: with the guard dropped, this now fails every run.)
    getDb()
      .update(pieces)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(pieces.id, result.pieceId))
      .run();

    // A marked piece with no composition on disk — the shape a kill would
    // leave if anything ever stamped the marker early.
    const [ghost] = getDb()
      .insert(pieces)
      .values({ name: "Welcome to libi", description: onboardingMarker("v1") })
      .returning()
      .all();
    expect(ghost.description).toBe("libi:onboarding:v1");

    const again = await runRunner({ version: "v1", force: false });
    expect(again.pieceId).not.toBe(ghost.id);
    expect(again.pieceId).toBe(result.pieceId);
    expect(again.reused).toBe(true);

    getDb().delete(pieces).where(eq(pieces.id, ghost.id)).run();
  }, 60_000);

  it("marks the piece only after the manifest is written", async () => {
    // The other half of the same guarantee: while a build is IN FLIGHT the new
    // piece carries the PROVISIONAL description, so a process killed at any
    // point before `saveManifest` leaves an orphan the next build ignores
    // rather than a marked shell it reuses. Stamping the marker at creation
    // would fail here.
    const { getDb } = await import("@/lib/db/client");
    const { pieces } = await import("@/lib/db/schema/sqlite");
    const { deletePieceCompletely } = await import("@/lib/pieces/delete-piece");
    const { provisionalDescription } = await import("@/lib/jobs/runners/onboarding-piece");

    const idsBefore = new Set(getDb().select({ id: pieces.id }).from(pieces).all().map((p) => p.id));
    let inFlightDescription: string | null | undefined;
    const built = await runRunner({ version: "v1", force: true }, (done) => {
      if (done !== 3 || inFlightDescription !== undefined) return;
      const fresh = getDb().select().from(pieces).all().find((p) => !idsBefore.has(p.id));
      inFlightDescription = fresh?.description ?? null;
    });

    expect(inFlightDescription).toBe(provisionalDescription("v1"));
    expect(inFlightDescription).not.toBe("libi:onboarding:v1");

    const [row] = getDb().select().from(pieces).where(eq(pieces.id, built.pieceId)).all();
    expect(row.description).toBe("libi:onboarding:v1");
    await deletePieceCompletely(built.pieceId);
  }, 180_000);

  it("finds the built piece by its marker, not by its name", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { pieces } = await import("@/lib/db/schema/sqlite");
    const { eq } = await import("drizzle-orm");
    getDb()
      .update(pieces)
      .set({ name: "My own title" })
      .where(eq(pieces.id, result.pieceId))
      .run();

    const again = await runRunner({ version: "v1", force: false });
    expect(again.pieceId).toBe(result.pieceId);
    expect(again.reused).toBe(true);
  }, 60_000);

  it("force builds a second, separate piece, and that one becomes the answer", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { pieces } = await import("@/lib/db/schema/sqlite");

    // `pieces.createdAt` is `mode: "timestamp"` over `unixepoch()` — WHOLE
    // SECONDS. Two builds inside one second tie, and the `desc(id)` tiebreak
    // then resolves by random UUID. Loopback fixtures make that tie routine in
    // this suite and effectively impossible in real use (a user rejects a demo
    // minutes later, not milliseconds). Backdating the original is how the
    // realistic case is expressed without a sleep, and without the assertion
    // riding on UUID luck.
    getDb()
      .update(pieces)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(pieces.id, result.pieceId))
      .run();

    const forced = await runRunner({ version: "v1", force: true });
    expect(forced.pieceId).not.toBe(result.pieceId);
    expect(forced.reused).toBe(false);
    expect(fs.existsSync(pieceStorageDir(forced.pieceId))).toBe(true);

    // NEWEST WINS. `force` means "the current one is bad, make me a new one",
    // so every later dedupe hit must return the rebuild — never the piece the
    // user just rejected. Oldest-first ordering would return `result.pieceId`
    // here and silently hand back the stale demo.
    const after = await runRunner({ version: "v1", force: false });
    expect(after.pieceId).toBe(forced.pieceId);
    expect(after.reused).toBe(true);
  }, 180_000);

  it("survives two forced builds in a row, and each rolls back cleanly", async () => {
    // This test began as a track-id collision guard: `tracks.id` is a primary
    // key over the WHOLE install, so an id copied out of the shipped
    // definition worked exactly once per machine and then threw
    // SQLITE_CONSTRAINT, taking the build and its rollback down with it on a
    // user who did nothing but ask for the demo twice.
    //
    // The film ships no track any more, so that particular collision cannot
    // happen — but "two forced builds in a row both work, and both delete
    // completely" is the property that mattered, and it is not track-specific.
    // Kept, minus the track: a second build must produce a second piece with
    // its OWN copies of the 21 files, and `deletePieceCompletely` (what the
    // runner's catch block calls) must take every one of them with it.
    const { getDb } = await import("@/lib/db/client");
    const { files, pieces, tracks } = await import("@/lib/db/schema/sqlite");
    const { loadManifest } = await import("@/lib/composition/persistence");
    const { deletePieceCompletely } = await import("@/lib/pieces/delete-piece");

    const first = await runRunner({ version: "v1", force: true });
    const second = await runRunner({ version: "v1", force: true });
    expect(second.pieceId).not.toBe(first.pieceId);

    for (const built of [first, second]) {
      const m = await loadManifest(built.pieceId);
      const fileIds = new Set(
        [
          ...(m.audioClips ?? []).map((c) => c.fileId),
          ...(m.overlays ?? []).map((o) => (o as { fileId?: string }).fileId),
        ].filter(Boolean) as string[],
      );
      expect(fileIds.size).toBe(21);
      // Every file this build's composition points at belongs to THIS piece —
      // neither build may borrow the other's copy.
      for (const id of fileIds) {
        const [file] = getDb().select().from(files).where(eq(files.id, id)).all();
        expect(file.pieceId).toBe(built.pieceId);
      }
    }
    // And neither build registered a track, on either pass.
    expect(getDb().select().from(tracks).all()).toHaveLength(0);

    for (const built of [first, second]) {
      expect(await deletePieceCompletely(built.pieceId)).toBe(true);
      expect(
        getDb().select().from(files).where(eq(files.pieceId, built.pieceId)).all(),
      ).toHaveLength(0);
      expect(
        getDb().select().from(pieces).where(eq(pieces.id, built.pieceId)).all(),
      ).toHaveLength(0);
    }
  }, 300_000);
});
