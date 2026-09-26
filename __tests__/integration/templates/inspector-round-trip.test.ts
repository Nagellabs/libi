/**
 * Final re-review 1, New breakage 3: the overlay allowlist
 * (lib/templates/fields.ts) dropped `place3d`, and the test that was meant to
 * guard the round trip checked the allowlist against itself — it could never
 * see a field the list left out.
 *
 * This test is built from the EDITOR, not from the allowlist:
 *  1. Every control in the inspector registry (`lib/overlays/inspector-fields.ts`,
 *     the single source of truth for what the editor can set) is mapped to the
 *     persisted field(s) it writes. A new inspector control with no mapping here
 *     fails the suite, so nobody can add a control without deciding whether a
 *     template carries it.
 *  2. One overlay per templatable kind is built as a `Required<…>` of the
 *     engine's overlay type — TypeScript refuses the fixture when a kind gains a
 *     field it does not set — with a non-default value everywhere.
 *  3. extract → create → apply, and every mapped field, and every field the
 *     fixture sets, must come back equal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { seedTemplateFixturePiece, type FixtureIds } from "@/__tests__/helpers/template-fixture-piece";
import { loadManifest, saveManifest, type PersistedOverlay } from "@/lib/composition/persistence";
import { INSPECTOR_FIELDS } from "@/lib/overlays/inspector-fields";
import type { CodeOverlay, ImageOverlay, TextOverlay, ThreeOverlay, VideoOverlay } from "@/lib/engine/types";

let testDb: ReturnType<typeof createTestDb>;
let storageDir: string;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(storageDir) }));
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(async () => ({ status: "new", jobId: "j", clientKey: "k" })),
  LibiServerUnavailableError: class extends Error {},
  logProxyGenEnqueueFailure: () => {},
}));

import { extractScaffold } from "@/lib/templates/extract";
import { createTemplate } from "@/lib/templates/store";
import { applyScaffold, type UrlFetcher } from "@/lib/templates/materialize";

const noUrls: UrlFetcher = async (urls) => urls.map((url) => ({ url, error: "unexpected fetch" }));

type Kind = "text" | "image" | "video" | "code" | "three";
const TEMPLATABLE: readonly Kind[] = ["text", "image", "video", "code", "three"];

/**
 * The persisted field paths an inspector control writes, for a kind — or why it
 * writes none. `undefined` means nobody decided, and fails the first test.
 */
function writesOf(key: string, kind: Kind): string[] | { none: string } | undefined {
  switch (key) {
    case "content":
    case "fontFamily":
    case "fontWeight":
    case "align":
    case "fontSize":
    case "color":
    case "background":
    case "background.color":
    case "background.padding":
    case "background.radius":
    case "stroke":
    case "shadow":
    case "place3d":
    case "opacity":
    case "flipH":
    case "flipV":
    case "startTime":
      return [key];
    // The style grid spreads a caption style's look (lib/captions/styles.ts
    // STYLE_FIELD_KEYS); it never touches `reveal`.
    case "style":
      return ["color", "stroke", "shadow", "background", "fontFamily", "fontWeight"];
    case "text3dEnabled":
      return ["threeD"];
    case "text3dDepth":
      return ["threeD.depth"];
    case "text3dBevel":
      return ["threeD.bevel"];
    case "text3dFrontColor":
      return ["threeD.frontColor"];
    case "text3dSideColor":
      return ["threeD.sideColor"];
    case "text3dLighting":
      return ["threeD.lighting"];
    case "transform.reset":
      return { none: "a button that resets transform3d, whose fields the transform3d keys cover" };
    case "transform3d.pose":
    case "transform3d.rotation":
      return ["transform3d.rotation"];
    case "transform3d.position":
      return ["transform3d.position"];
    case "transformPosZ":
      return ["transform3d.position.z"];
    // In-plane spin: text's "Rotate", three's "Spin", every other kind's
    // transformSpin — all the single rotation authority.
    case "rotation":
    case "transformSpin":
      return ["transform3d.rotation.z"];
    case "zOrder":
      return ["z"];
    case "endTime":
      return ["duration"];
    // Text pins a point (`position`); a box kind re-centres its `rect`. (The box
    // panel also writes `position`, which only a text overlay's renderer reads —
    // PersistedOverlay declares it on text alone.)
    case "transformPosX":
      return kind === "text" ? ["position.x"] : ["rect.x"];
    case "transformPosY":
      return kind === "text" ? ["position.y"] : ["rect.y"];
    case "position":
      return ["rect.x", "rect.y"];
    case "size":
    case "transformSize":
      return ["rect.width", "rect.height"];
    default:
      return undefined;
  }
}

function at(o: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((v, k) => (v == null ? v : (v as Record<string, unknown>)[k]), o);
}

// ── One full overlay per kind ─────────────────────────────────────────────
// `Omit`ted keys are the ones a template never carries, each for a stated
// reason: `id`/`fileId`/`fontFileId` are re-minted (asserted by
// materialize.test.ts), `caption` travels as `captionStyles[]`, `version` is the
// edit store's save counter, and the rest are runtime-only (never persisted).
type Full<T, Drop extends keyof T> = Required<Omit<T, Drop | "id" | "caption" | "version">>;

const common = {
  startTime: 0.5,
  duration: 3.5,
  z: 3,
  opacity: 0.8,
  flipH: true,
  flipV: true,
  hidden: true,
  group: "brand",
  anchor: "top-right" as const,
  place3d: true,
  transform3d: { position: { x: 12, y: -8, z: 40 }, rotation: { x: 0.2, y: -0.3, z: 0.4 } },
  keyframes: { opacity: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1, easing: "ease-out" }] } },
  effects: { in: { effectId: "fade-in", durationMs: 300 }, out: { effectId: "fade-out" }, loop: { effectId: "pulse", params: { amount: 0.1 } } },
};

const TEXT: Full<TextOverlay, "fontFileId"> & { kind: "text" } = {
  ...common,
  kind: "text",
  displayName: "Full text",
  rect: { x: 100, y: 1500, width: 800, height: 120 },
  content: "Round trip",
  font: "700 64px Inter",
  color: "#ffd400",
  align: "right",
  fontFamily: "Inter",
  fontSize: 64,
  fontWeight: 700,
  lineHeight: 1.3,
  background: { color: "#111", padding: 12, radius: 8 },
  stroke: { color: "#000", width: 4 },
  shadow: { color: "#0008", blur: 6, dx: 2, dy: 3 },
  reveal: { mode: "fade-words", durationMs: 800, highlightColor: "#f0f" },
  highlightColor: "#0ff",
  threeD: { depth: 18, bevel: 2, frontColor: "#fff", sideColor: "#333", lighting: "dramatic", tilt: "angled" },
  position: { x: 900, y: 1550 },
  maxWidthPct: 0.7,
};

const IMAGE: Full<ImageOverlay, "fileId" | "missing" | "unfilledSlot"> & { kind: "image" } = {
  ...common,
  kind: "image",
  displayName: "Full image",
  rect: { x: 10, y: 20, width: 300, height: 200 },
};

const VIDEO: Full<VideoOverlay, "fileId" | "missing" | "unfilledSlot" | "videoUrl" | "sourceWidth" | "sourceHeight" | "sourceName"> & {
  kind: "video";
} = {
  ...common,
  kind: "video",
  displayName: "Full video",
  rect: { x: 0, y: 100, width: 1080, height: 1200 },
  trim: { start: 0.25, end: 3.75 },
  fit: "contain",
};

const CODE: Full<CodeOverlay, never> & { kind: "code" } = {
  ...common,
  kind: "code",
  displayName: "Full code",
  rect: { x: 40, y: 40, width: 500, height: 500 },
  drawFunction: "const { ctx } = context;\nctx.fillRect(0, 0, 10, 10);",
};

// `scale` is on PersistedOverlay's three arm (the Size control's uniform scene
// scale) but not on the engine type.
const THREE: Full<ThreeOverlay, never> & { kind: "three"; scale: number } = {
  ...common,
  kind: "three",
  displayName: "Full three",
  rect: { x: 0, y: 0, width: 1080, height: 1920 },
  sceneFunction: "return { update() {} };",
  cameraPreset: "lowAngle",
  scale: 1.5,
};

const FULL: Record<Kind, Record<string, unknown>> = { text: TEXT, image: IMAGE, video: VIDEO, code: CODE, three: THREE };

/** Re-minted by apply, or compared elsewhere. */
const REMINTED = new Set(["id", "fileId", "version"]);

describe("every overlay field the editor can set survives extract → apply", () => {
  let pieceId: string;
  let ids: FixtureIds;

  beforeEach(async () => {
    storageDir = createTempStorageDir();
    testDb = createTestDb();
    ({ pieceId, ids } = await seedTemplateFixturePiece(testDb as never, storageDir));
  });
  afterEach(() => {
    resetTestDb();
    cleanupTempDir(storageDir);
  });

  it("every inspector control of a templatable kind names the fields it writes", () => {
    const kinds = new Set(INSPECTOR_FIELDS.map((f) => f.kind));
    // `tracked` becomes a `code` overlay on extract (its track is footage); a
    // new kind must be decided here.
    expect([...kinds].filter((k) => k !== "tracked" && !TEMPLATABLE.includes(k as Kind))).toEqual([]);
    const undecided = INSPECTOR_FIELDS.filter((f) => f.kind !== "tracked")
      .filter((f) => writesOf(f.key, f.kind as Kind) === undefined)
      .map((f) => `${f.kind}:${f.key}`);
    expect(undecided).toEqual([]);
  });

  it("the fixture sets every field an inspector control writes", () => {
    const unset: string[] = [];
    for (const f of INSPECTOR_FIELDS) {
      if (f.kind === "tracked") continue;
      const paths = writesOf(f.key, f.kind as Kind);
      if (!Array.isArray(paths)) continue;
      for (const p of paths) if (at(FULL[f.kind as Kind], p) === undefined) unset.push(`${f.kind}:${f.key} → ${p}`);
    }
    expect(unset).toEqual([]);
  });

  it("apply restores each one", async () => {
    const m = await loadManifest(pieceId);
    m.overlays = [
      { ...TEXT, id: "t-full" },
      { ...IMAGE, id: "i-full", fileId: ids.imageFileId },
      { ...VIDEO, id: "v-full", fileId: ids.videoFileId },
      { ...CODE, id: "c-full" },
      { ...THREE, id: "3-full" },
    ] as unknown as PersistedOverlay[];
    m.audioClips = [];
    await saveManifest(pieceId, m);
    const src = await loadManifest(pieceId);

    const ex = await extractScaffold(pieceId);
    const tid = (
      await createTemplate({ name: "Full", description: "d", tags: ["t"], scaffold: ex.scaffold, instructions: "", copies: ex.copies, writes: ex.writes })
    ).id;
    const dst = seedPiece(testDb, { id: "dst-full" });
    await applyScaffold({ templateId: tid, pieceId: dst, fetchUrls: noUrls });
    const out = await loadManifest(dst);

    const byName = (list: PersistedOverlay[]) => Object.fromEntries(list.map((o) => [o.displayName, o as Record<string, unknown>]));
    const before = byName(src.overlays!);
    const after = byName(out.overlays!);
    const lost: string[] = [];
    for (const kind of TEMPLATABLE) {
      const name = FULL[kind].displayName as string;
      const a = before[name];
      const b = after[name];
      expect(b, name).toBeDefined();
      // Every field the fixture set …
      for (const k of Object.keys(FULL[kind])) {
        if (REMINTED.has(k)) continue;
        if (JSON.stringify(at(b, k)) !== JSON.stringify(at(a, k))) lost.push(`${kind}.${k}`);
      }
      // … and every field an inspector control writes.
      for (const f of INSPECTOR_FIELDS.filter((x) => x.kind === kind)) {
        const paths = writesOf(f.key, kind);
        if (!Array.isArray(paths)) continue;
        for (const p of paths) {
          if (JSON.stringify(at(b, p)) !== JSON.stringify(at(a, p))) lost.push(`${kind}:${f.key} → ${p}`);
        }
      }
    }
    expect([...new Set(lost)]).toEqual([]);
  });
});
