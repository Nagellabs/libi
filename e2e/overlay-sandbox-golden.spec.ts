import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { test, expect } from "./helpers/app";

/**
 * Golden-frame guard for the overlay sandbox (spec §7): a code overlay and a
 * three overlay, rendered through the real export path (/api/render/frames →
 * chromium-render), must produce the SAME pixels (±1 per channel) before and
 * after body execution moves into the sandboxed runtime.
 *
 * Baselines: `LIBI_GOLDEN_UPDATE=1 npm run test:e2e -- e2e/overlay-sandbox-golden.spec.ts`
 * writes e2e/golden/overlay-sandbox/frame-<ms>.png. Without the flag the spec
 * compares and, on a mismatch, writes `<name>.actual.png` beside the baseline.
 * The committed baselines were recaptured from HEAD on 2026-09-27, a
 * deliberate rendering change that brought the 3D-text label back (see below).
 * A capture-path change still regenerates from the pre-refactor renderer
 * (3110575a), never from HEAD. The full
 * provenance is in e2e/golden/overlay-sandbox/README.md.
 *
 * Fonts: `Inter` 700 (bundled) AND an uploaded face (`libifont-<id>`, the
 * repo's JetBrainsMono-Bold.ttf uploaded as a user font) — both must survive
 * the transfer into the runtime (spec §4.8, §8 "Font parity"). The uploaded
 * face reaches the headless render page only because a TEXT overlay carries
 * `fontFileId`: `loadOverlayFonts` (lib/fonts/registry-client.ts) registers
 * fonts off text overlays alone, and a code overlay naming the family in
 * `ctx.font` would otherwise bake in a fallback face. The text overlay is
 * therefore load-bearing, not decoration — it is what makes the code
 * overlay's `libifont-…` line render in the real face.
 *
 * FIDELITY — read this before reporting a result. These are NOT the renderer's
 * raw pixels. `renderCompositionFrames` (lib/render/frame-capture.ts) renders
 * the composition to an H.264 MP4 at 2 Mbps, 720 short side, and extracts each
 * PNG from it with ffmpeg — so "±1 per channel" is measured AFTER a lossy
 * encode/decode round trip. That round trip is deterministic (four consecutive
 * captures agreed exactly), which is what makes the guard usable, but it is
 * also a low-pass filter. So:
 *
 *   Reliably caught — a font falling back to another face, a fill that stops
 *   painting, a helper that silently no-ops, a layout/position shift, a colour
 *   change, an overlay that stops rendering, the three scene going missing.
 *
 *   May NOT be caught — sub-pixel antialiasing differences and other changes
 *   confined to within a macroblock's quantization noise; they can quantize
 *   away before they reach the PNG.
 *
 * A green run therefore means "no visible change at export fidelity", not
 * "byte-identical rasterization". Task 14 should report it at that fidelity.
 *
 * 3D TEXT IS COVERED. The three body puts a `new Text()` label ("Parity")
 * under the cube, so the spec also proves `Text` is still injected into three
 * bodies (it is one of THREE_PARAM_NAMES) and that a label exports the same
 * pixels every time. The label was out of the fixture from 2026-09-23 to
 * 2026-09-27: roughly one run in three differed on its glyphs, two stable
 * outcomes rather than noise. The cause was the label's own canvas. It was a
 * GPU-backed 2D context, and its large-glyph rasterization wasn't repeatable:
 * three different bitmaps in eight runs for the same text, size and metrics.
 * The texture was never uploaded a frame late; it was uploaded on time with
 * different pixels. `lib/engine/canvas-text.ts` now asks for a CPU-backed
 * context (`willReadFrequently`), and 10 of 10 runs are byte-identical
 * (`__tests__/unit/engine/three-text-latch.test.ts` pins both halves). If
 * this label starts flaking again, suspect the label canvas's backing first.
 */
const GOLDEN_DIR = path.resolve(__dirname, "golden", "overlay-sandbox");
const TIMES = [0.5, 1.5];
const UPDATE = process.env.LIBI_GOLDEN_UPDATE === "1";
const USER_FONT = path.resolve(__dirname, "..", "public", "fonts", "2d", "JetBrainsMono-Bold.ttf");

/** Pinned so the baseline never depends on the default aspect ratio: a new
 *  piece takes `DEFAULT_ASPECT_RATIO_ID` (9:16 today), and a change to that
 *  default would silently invalidate every committed frame. */
const FRAME = { width: 1920, height: 1080 };

/** The code overlay's gradient endpoints (#0f172a → #1e3a8a), as RGB. The
 *  update-mode self-check measures everything that is NOT this ramp. */
const GRADIENT_TOP = [0x0f, 0x17, 0x2a] as const;
const GRADIENT_BOTTOM = [0x1e, 0x3a, 0x8a] as const;

/** Floors for the update-mode self-check, set from the committed baselines:
 *  measured, not guessed — frame-500ms 22 182 distinct colours / 18.04%
 *  off-ramp, frame-1500ms 20 098 / 18.02%. A frame that renders the gradient
 *  and little else (the regression this guards) sits near zero on both. The
 *  floors are an order of magnitude below the real values so they fail on
 *  "it painted nothing" without becoming a second, brittle golden that has to
 *  be re-tuned whenever the fixture is touched. */
const MIN_DISTINCT_COLOURS = 1500;
const MIN_OFF_GRADIENT_FRACTION = 0.02;

function frameName(time: number): string {
  return `frame-${Math.round(time * 1000)}ms.png`;
}

async function pixels(file: string): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  const img = await loadImage(await fs.promises.readFile(file));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

/**
 * Does this frame actually show the fixture, or did it render "successfully"
 * while painting almost nothing?
 *
 * This exists because that is not hypothetical: the first capture of these
 * baselines drew the gradient and then silently no-opped every circle and both
 * text lines (the draw helpers were called with the wrong signatures), and the
 * spec was perfectly green over it. Only a human opening the PNG caught it. A
 * re-capture must fail loudly instead.
 *
 * Two cheap, fixture-specific signals, both far below what a correct frame
 * produces and far above what a gradient-only frame does:
 *  - distinct colours: the 12 `hsl()` circles + two text colours + the three
 *    scene put thousands on the frame; a bare vertical gradient has ~the
 *    number of rows.
 *  - non-gradient pixels: pixels whose colour is not on (or near) the
 *    interpolated gradient ramp between its two endpoints. The circles, text
 *    and cube are all off-ramp; a gradient-only frame is ~entirely on it.
 */
function fixtureCoverage(px: { w: number; h: number; data: Uint8ClampedArray }): {
  distinctColours: number;
  offGradientFraction: number;
} {
  const colours = new Set<number>();
  let offRamp = 0;
  const total = px.w * px.h;
  for (let y = 0; y < px.h; y++) {
    // The gradient is vertical between GRADIENT_TOP and GRADIENT_BOTTOM, so the
    // expected ramp colour depends only on the row.
    const t = px.h === 1 ? 0 : y / (px.h - 1);
    const rampR = GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * t;
    const rampG = GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * t;
    const rampB = GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * t;
    for (let x = 0; x < px.w; x++) {
      const i = (y * px.w + x) * 4;
      const r = px.data[i];
      const g = px.data[i + 1];
      const b = px.data[i + 2];
      colours.add((r << 16) | (g << 8) | b);
      // Generous tolerance: the ramp is what H.264 reproduces LEAST exactly
      // (banding), and this check is about "is anything else on the frame",
      // not about grading the gradient.
      if (Math.abs(r - rampR) > 12 || Math.abs(g - rampG) > 12 || Math.abs(b - rampB) > 12) {
        offRamp++;
      }
    }
  }
  return { distinctColours: colours.size, offGradientFraction: offRamp / total };
}

/** Channels differing by more than 1, and the largest delta seen. */
function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): { over1: number; maxDelta: number } {
  let over1 = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxDelta) maxDelta = d;
    if (d > 1) over1++;
  }
  return { over1, maxDelta };
}

/**
 * Helper signatures are the REAL ones (lib/engine/drawing.ts): `drawCircle`
 * takes an explicit `fill` (omit it and the arc is traced, never painted), and
 * `drawTextBlock` takes `maxWidth, lineHeight` BEFORE the style object (pass
 * the style in maxWidth's place and the text renders in the default 10px face
 * with whatever fillStyle was left over). Both mistakes render something, which
 * is exactly why they are spelled out here — a baseline that bakes in a silent
 * no-op proves nothing about the fonts or the fills after the refactor.
 */
const CODE_BODY = (fontFamily: string) => `
const { ctx, width, height, progress } = context;
drawGradient(ctx, 0, 0, width, height, ["#0f172a", "#1e3a8a"], "vertical");
for (let i = 0; i < 12; i++) {
  drawCircle(ctx, 120 + i * 140, 700 + Math.sin(progress * Math.PI * 2 + i) * 120, 48, "hsl(" + (i * 30) + ", 80%, 55%)");
}
drawTextBlock(ctx, "Golden Inter " + Math.round(progress * 100), 80, 160, 1600, 120, { font: "700 96px Inter", color: "#ffffff" });
drawTextBlock(ctx, "Golden uploaded", 80, 300, 1600, 120, { font: "700 96px ${fontFamily}", color: "#fde68a" });
`;

/**
 * The cube plus a `new Text()` label, which guards 3D text (see the "3D text"
 * note in the header). The label also widens the content-fit framing past the
 * cube alone.
 */
const THREE_BODY = `
const geo = new THREE.BoxGeometry(1.4, 1.4, 1.4);
const mesh = new THREE.Mesh(geo, new THREE.MeshNormalMaterial());
scene.add(mesh);
const label = new Text();
label.text = "Parity";
label.fontSize = 0.6;
label.color = 0xffffff;
label.position.set(0, -1.4, 0);
scene.add(label);
return (api) => { mesh.rotation.x = api.time; mesh.rotation.y = api.time * 0.7; };
`;

test.describe("overlay sandbox golden frames", () => {
  test("code + three overlays render pixel-identical to the committed baseline", async ({ request }) => {
    test.setTimeout(180_000);
    const created = await request.post("/api/pieces");
    expect(created.ok()).toBe(true);
    const { id: pieceId } = (await created.json()) as { id: string };

    const dims = await request.patch(`/api/pieces/${pieceId}/composition/dimensions`, { data: FRAME });
    expect(dims.ok(), await dims.text()).toBe(true);

    const font = await request.post("/api/e2e/run-tool", {
      data: { tool: "libi.upload_font", args: { path: USER_FONT, pieceId, name: "Golden Mono" } },
    });
    expect(font.ok()).toBe(true);
    const fontJson = (await font.json()) as { success: boolean; data?: { fileId?: string; family?: string } };
    expect(fontJson.success, JSON.stringify(fontJson)).toBe(true);
    const fontFileId = fontJson.data?.fileId;
    expect(fontFileId, JSON.stringify(fontJson)).toBeTruthy();
    // upload_font returns the css family (`libifont-<fileId>`); fall back to
    // deriving it from fileId if only that is present.
    const family = fontJson.data?.family ?? `libifont-${fontFileId}`;
    expect(family).toMatch(/^libifont-/);

    // The overlay that REGISTERS the uploaded face in the render page (see the
    // header note). It also puts the face on the frame in its own right.
    const text = await request.post("/api/e2e/run-tool", {
      data: {
        tool: "libi.add_overlay",
        args: {
          pieceId, kind: "text", content: "Uploaded face", font: "700 72px " + family, fontFileId,
          color: "#fca5a5", align: "left",
          rect: { x: 80, y: 380, width: 900, height: 120 }, startTime: 0, duration: 3, z: 2, opacity: 1,
        },
      },
    });
    expect(text.ok(), await text.text()).toBe(true);
    expect(((await text.json()) as { success?: boolean }).success).toBe(true);

    const code = await request.post("/api/e2e/run-tool", {
      data: {
        tool: "libi.add_overlay",
        args: {
          pieceId, kind: "code", displayName: "golden-code", body: CODE_BODY(family),
          rect: { x: 0, y: 0, width: FRAME.width, height: FRAME.height }, startTime: 0, duration: 3, z: 0, opacity: 1,
        },
      },
    });
    expect(code.ok(), await code.text()).toBe(true);
    expect(((await code.json()) as { success?: boolean }).success).toBe(true);

    const three = await request.post("/api/e2e/run-tool", {
      data: {
        tool: "libi.add_overlay",
        args: {
          pieceId, kind: "three", displayName: "golden-three", body: THREE_BODY, cameraPreset: "billboard",
          rect: { x: 1100, y: 100, width: 720, height: 540 }, startTime: 0, duration: 3, z: 1, opacity: 1,
        },
      },
    });
    expect(three.ok(), await three.text()).toBe(true);
    expect(((await three.json()) as { success?: boolean }).success).toBe(true);

    const rendered = await request.post("/api/render/frames", { data: { pieceId, atTimes: TIMES } });
    expect(rendered.ok(), await rendered.text()).toBe(true);
    const { frames } = (await rendered.json()) as { frames: Array<{ time: number; path: string }> };
    expect(frames.map((f) => f.time)).toEqual(TIMES);

    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    for (const f of frames) {
      const baseline = path.join(GOLDEN_DIR, frameName(f.time));
      if (UPDATE) {
        // Never capture a frame that does not show the fixture — see
        // fixtureCoverage() for the regression this exists to catch.
        const cov = fixtureCoverage(await pixels(f.path));
        expect(
          cov.distinctColours,
          `frame ${f.time}s has only ${cov.distinctColours} distinct colours — the fixture did not paint. ` +
            `Check the draw-helper signatures and the fonts before capturing a baseline.`,
        ).toBeGreaterThan(MIN_DISTINCT_COLOURS);
        expect(
          cov.offGradientFraction,
          `frame ${f.time}s is ${(cov.offGradientFraction * 100).toFixed(2)}% non-gradient — the circles, text ` +
            `and three scene are missing. Do not capture this as a baseline.`,
        ).toBeGreaterThan(MIN_OFF_GRADIENT_FRACTION);
        fs.copyFileSync(f.path, baseline);
        continue;
      }
      expect(
        fs.existsSync(baseline),
        `missing baseline ${baseline} — capture one with LIBI_GOLDEN_UPDATE=1 (provenance: e2e/golden/overlay-sandbox/README.md)`,
      ).toBe(true);
      const [want, got] = await Promise.all([pixels(baseline), pixels(f.path)]);
      expect({ w: got.w, h: got.h }).toEqual({ w: want.w, h: want.h });
      const d = diff(want.data, got.data);
      const actual = baseline.replace(/\.png$/, ".actual.png");
      if (d.over1 > 0) fs.copyFileSync(f.path, actual);
      expect(
        d.over1,
        `frame ${f.time}s differs: ${d.over1} channels over ±1 (max delta ${d.maxDelta}); see ${actual}`,
      ).toBe(0);
    }
  });
});
