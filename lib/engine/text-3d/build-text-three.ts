/** buildTextThreeInstance — the engine entry that turns a TextOverlay with a
 *  `threeD` config into a ThreeOverlayInstance (the same shape three-overlay.ts
 *  returns), driven by the unified overlay renderer's `case "text"`.
 *
 *  Architecture: text is laid out PER GLYPH (one object per visible glyph,
 *  positioned by font advance width) so reveal modes can toggle/emphasize
 *  individual glyphs and words in 3D. Premium path builds an ExtrudeGeometry mesh
 *  per glyph; faux fallback builds a stacked-plane Group per glyph.
 *
 *  Dependency injection: the font resolver + loaders + builders are injected via
 *  `deps` so the unit test can verify path selection WITHOUT touching real WebGL
 *  or the opentype/three runtime. Production wires the real implementations. */

import type { TextOverlay } from "@/lib/engine/types";
import type { ThreeOverlayInstance, SharedThreeRenderer, ThreeFrameApi } from "@/lib/engine/three-overlay";
import type { FontResolution } from "@/lib/engine/text-3d/font-resolve";
import type { ExtrudeOpts } from "@/lib/engine/text-3d/extrude";
import { isCachedGeometry } from "@/lib/engine/text-3d/extrude";
import type { FauxOpts } from "@/lib/engine/text-3d/faux";
import { normalizeThreeDForWorld, fitScaleForFrame } from "@/lib/engine/text-3d/scale";
import { flythroughFrame, glyphPainted } from "@/lib/engine/text-3d/flythrough";
import { applyCameraPreset } from "@/lib/engine/three-helpers";
import { activeWordIndexByProgress, revealFraction } from "@/lib/engine/text-anim/caption-reveal";
import {
  activeWordIndex,
  fadeWordsAlphaByTime,
  typewriterVisibleGlyphCount,
} from "@/lib/engine/text-anim/caption-logic";
import { geometryCacheKey } from "@/lib/engine/text-3d/font-resolve";
import { glyphRevealState } from "@/lib/engine/text-3d/word-reveal";
import { fadeWordsAlpha } from "@/lib/overlays/caption-style";

type AnyTHREE = typeof import("three");
type Object3DLike = import("three").Object3D;

/** A loaded font's minimal surface (opentype.Font) the builder needs. Kept
 *  structural so the test can pass a stub. */
export interface LoadedFontLike {
  getAdvanceWidth(text: string, fontSize: number): number;
}

/** Injected dependencies. Production passes the real implementations; tests pass
 *  spies/stubs so no WebGL/opentype is touched. */
export interface BuildTextThreeDeps {
  /** Resolve the overlay's font to a file path or a faux fallback. */
  resolveFont: (overlay: TextOverlay) => FontResolution;
  /** Load a parsed font from a resolved path (node fs or browser fetch). */
  loadFont: (path: string) => Promise<LoadedFontLike>;
  /** Build ONE glyph's extruded mesh (premium path). */
  buildGlyphMesh: (THREE: AnyTHREE, font: LoadedFontLike, glyph: string, size: number, opts: ExtrudeOpts, cacheKey: string) => Object3DLike;
  /** Build ONE glyph's faux stacked-plane group (fallback path). */
  buildGlyphFaux: (THREE: AnyTHREE, glyph: string, opts: FauxOpts) => Object3DLike;
  /** Lazy three import — injected so the test never loads the real module. */
  importThree: () => Promise<AnyTHREE>;
}

/** Layout/visual constants. Font size is in world units; the camera framing
 *  (applyCameraPreset) is tuned for objects roughly within ±3 units. */
const WORLD_FONT_SIZE = 1.0;

interface GlyphEntry {
  obj: Object3DLike;
  /** Index of the word this glyph belongs to (spaces increment the word). */
  wordIndex: number;
  /** Running glyph index over visible (non-space) glyphs. */
  glyphIndex: number;
  /** Layout Y at build time — the rest position slide-up animates back to. */
  baseY: number;
  /** Set an override color (null restores the base). PREMIUM: mutates this
   *  glyph's OWN materials — buildExtrudedMesh makes a FRESH MeshStandardMaterial
   *  pair per mesh (only the GEOMETRY is cached), so this never touches a shared
   *  buffer. FAUX: delegates to the group's build-time highlight hook (a pre-
   *  rasterized front plane toggled by visibility — never a per-frame raster). */
  setColor: (color: string | null) => void;
  /** 0..1 opacity. PREMIUM: material.transparent+opacity. FAUX: plane materials. */
  setOpacity: (alpha: number) => void;
}

/** A per-mesh MeshStandardMaterial's mutable surface (color + opacity). */
interface MutableGlyphMaterial {
  color?: { set: (c: string) => void; getHexString: () => string };
  transparent?: boolean;
  opacity?: number;
}

/** Build the per-glyph color/opacity closures for the reveal `update()`. Premium
 *  meshes own their materials (fresh per glyph — mutable), faux groups delegate to
 *  the hooks `buildFauxText` installed on `userData`. Robust to a glyph object with
 *  no material (unmappable-glyph empty Group) — the closures become safe no-ops. */
function glyphColorOpacityControls(
  obj: Object3DLike,
  premium: boolean,
): { setColor: (c: string | null) => void; setOpacity: (a: number) => void } {
  if (!premium) {
    const ud = (obj as unknown as {
      userData?: { setColor?: (c: string | null) => void; setOpacity?: (a: number) => void };
    }).userData;
    return {
      setColor: (c) => ud?.setColor?.(c),
      setOpacity: (a) => ud?.setOpacity?.(a),
    };
  }
  const raw = (obj as unknown as { material?: MutableGlyphMaterial | MutableGlyphMaterial[] }).material;
  const mats: MutableGlyphMaterial[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  // Precompute the `#`-prefixed base color strings ONCE at build. The karaoke
  // restore path calls setColor(null) per inactive glyph EVERY frame; a plain
  // for-loop over these avoids allocating a template string + a forEach closure
  // per glyph per frame.
  const baseColorHex = mats.map((m) => `#${m.color?.getHexString?.() ?? ""}`);
  return {
    setColor: (c) => {
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (!m.color) continue;
        m.color.set(c ?? baseColorHex[i]);
      }
    },
    setOpacity: (a) => {
      for (const m of mats) {
        m.transparent = a < 1;
        m.opacity = a;
      }
    },
  };
}

type LightingPreset = NonNullable<TextOverlay["threeD"]>["lighting"];

/** Map a lighting preset to a light rig added to the scene. */
function addLights(THREE: AnyTHREE, scene: import("three").Scene, preset: LightingPreset): void {
  const p = preset ?? "studio";
  const add = (light: import("three").Light) => scene.add(light);
  switch (p) {
    case "flat":
      add(new THREE.AmbientLight(0xffffff, 1.0));
      break;
    case "soft": {
      add(new THREE.AmbientLight(0xffffff, 0.65));
      const key = new THREE.DirectionalLight(0xffffff, 0.6);
      key.position.set(-2, 2, 4);
      add(key);
      break;
    }
    case "dramatic": {
      add(new THREE.AmbientLight(0xffffff, 0.15));
      const key = new THREE.DirectionalLight(0xffffff, 1.4);
      key.position.set(3, 3, 2);
      add(key);
      const rim = new THREE.DirectionalLight(0x88aaff, 0.6);
      rim.position.set(-3, -1, -2);
      add(rim);
      break;
    }
    case "studio":
    default: {
      add(new THREE.AmbientLight(0xffffff, 0.5));
      const key = new THREE.DirectionalLight(0xffffff, 0.9);
      key.position.set(2, 3, 4);
      add(key);
      const fill = new THREE.DirectionalLight(0xffffff, 0.4);
      fill.position.set(-3, 1, 2);
      add(fill);
      break;
    }
  }
}

/**
 * Build a 3D-text overlay instance for a TextOverlay carrying `threeD`. Mirrors
 * buildThreeInstance's returned shape (update?/applyTransform/render/dispose/ready).
 * The font resolution picks the premium (file) vs faux (name-only) builder.
 */
export async function buildTextThreeInstance(
  overlay: TextOverlay,
  deps: BuildTextThreeDeps,
  shared: SharedThreeRenderer,
): Promise<ThreeOverlayInstance> {
  const threeD = overlay.threeD!;
  const THREE = await deps.importThree();

  const scene = new THREE.Scene();
  const camera = applyCameraPreset(THREE, threeD.tilt ?? "billboard");
  // LONG-LENS for fronto-parallel text: a flat glyph run's edges sit √(d²+x²)
  // from a close camera, so wide text visibly recedes/bows at the sides ("the
  // sides feel behind"). Triple the distance with an equal-framing FOV
  // (tan(fov/2)·d preserved) — same framing (fitScaleForFrame reads fov +
  // camDistance), ~9× less lateral recession, a hint of perspective kept on
  // the extrusion. Scoped to TEXT + billboard: the tilt presets exist for
  // dramatic perspective, `three` scene bodies own their camera expectations,
  // and flythrough drives the camera itself (its travel math assumes the
  // stock lens).
  if ((threeD.tilt ?? "billboard") === "billboard" && overlay.reveal?.mode !== "flythrough") {
    const LENS_K = 3;
    const halfTan = Math.tan((camera.fov * Math.PI) / 360);
    camera.position.z *= LENS_K;
    camera.fov = (Math.atan(halfTan / LENS_K) * 360) / Math.PI;
    camera.updateProjectionMatrix();
  }
  addLights(THREE, scene, threeD.lighting);

  // Root group holds all glyph objects so applyTransform can move the whole text.
  const root = new THREE.Group();
  scene.add(root);

  const resolution = deps.resolveFont(overlay);
  // Author depth/bevel are a pixel-ish "amount" (default 20) — normalize to the
  // WORLD font size (≈1.0/glyph) or they over-extrude ~30× (see scale.ts).
  const world = normalizeThreeDForWorld(threeD.depth, threeD.bevel ?? 0, WORLD_FONT_SIZE);
  const extrudeOpts: ExtrudeOpts = {
    depth: world.worldDepth,
    bevel: world.worldBevel,
    frontColor: threeD.frontColor ?? overlay.color,
    sideColor: threeD.sideColor,
  };
  // Only karaoke reads highlightColor — pre-build the faux highlight plane just
  // for it (a wasted texture otherwise). The premium path recolors materials live.
  const fauxHighlight = overlay.reveal?.mode === "karaoke" ? overlay.reveal.highlightColor : undefined;
  const fauxBaseOpts: Omit<FauxOpts, "content"> = {
    color: threeD.frontColor ?? overlay.color,
    depth: world.worldDepth,
    sideColor: threeD.sideColor,
    font: overlay.fontFamily,
    layers: world.fauxLayers,
    highlightColor: fauxHighlight,
  };

  const text = overlay.content ?? "";

  // ── Layout glyphs left→right, centered on the root ──
  const glyphs: GlyphEntry[] = [];
  let font: LoadedFontLike | null = null;
  let usedPremium = false;
  if (resolution.kind === "file") {
    try {
      font = await deps.loadFont(resolution.path);
      usedPremium = true;
    } catch (err) {
      // Unparseable font bytes (an uploaded non-font file, a corrupt ttf, a
      // format opentype can't read). The resolver can only gate by extension,
      // so the load itself is the real test — downgrade to the faux
      // stacked-plane path instead of failing the whole build, the same
      // fallback resolve3DFont applies for known-unsupported formats.
      console.warn("[text-3d] font load failed; falling back to faux", resolution.path, err);
      font = null;
      usedPremium = false;
    }
  }

  let penX = 0;
  let wordIndex = 0;
  let glyphIndex = 0;
  const advanceFor = (ch: string): number => {
    if (font) return font.getAdvanceWidth(ch, WORLD_FONT_SIZE);
    // Faux fallback: approximate monospace-ish advance.
    return WORLD_FONT_SIZE * 0.6;
  };

  for (const ch of text) {
    if (ch === " ") {
      penX += advanceFor(" ");
      wordIndex++;
      continue;
    }
    if (ch === "\n") {
      // Single-line model: treat newline as a space (3D captions are short).
      penX += advanceFor(" ");
      wordIndex++;
      continue;
    }
    let obj: Object3DLike;
    if (usedPremium && font) {
      const key = geometryCacheKey(resolution.kind === "file" ? resolution.path : "faux", ch, world.worldDepth, world.worldBevel);
      obj = deps.buildGlyphMesh(THREE, font, ch, WORLD_FONT_SIZE, extrudeOpts, key);
    } else {
      obj = deps.buildGlyphFaux(THREE, ch, { ...fauxBaseOpts, content: ch });
    }
    obj.position.x = penX;
    root.add(obj);
    const ctrls = glyphColorOpacityControls(obj, usedPremium && !!font);
    glyphs.push({ obj, wordIndex, glyphIndex, baseY: obj.position.y, setColor: ctrls.setColor, setOpacity: ctrls.setOpacity });
    penX += advanceFor(ch);
    glyphIndex++;
  }

  // Center the glyph RUN in LOCAL space (keep root at origin so the per-render
  // fit scale scales about the center). X: shift by half the total advance.
  // Y: shift by the run's vertical bbox center — glyphs keep their RELATIVE
  // baseline alignment; only the block moves. (Centering via root.position would
  // drift under scale.)
  for (const g of glyphs) g.obj.position.x -= penX / 2;
  const runBox = new THREE.Box3().setFromObject(root);
  const runCy = Number.isFinite(runBox.min.y + runBox.max.y)
    ? (runBox.min.y + runBox.max.y) / 2
    : 0;
  for (const g of glyphs) {
    g.obj.position.y -= runCy;
    g.baseY = g.obj.position.y; // rest position for slide-up/fade-words
  }

  // Measure the laid-out text + the camera distance so render() can fit the text
  // to a target fraction of the camera frame (the shared presets otherwise frame
  // auto-laid-out text at ~13% — tiny in its caption box).
  const textBox = new THREE.Box3().setFromObject(root);
  const textW = Number.isFinite(textBox.max.x - textBox.min.x) ? textBox.max.x - textBox.min.x : 0;
  const textH = Number.isFinite(textBox.max.y - textBox.min.y) ? textBox.max.y - textBox.min.y : 0;
  const camDistance = camera.position.length(); // text sits near the origin

  const visibleGlyphCount = glyphs.length;
  const wordCount = wordIndex + 1;
  const reveal = overlay.reveal && overlay.reveal.mode !== "none" ? overlay.reveal : null;
  // Flythrough drives the camera in world units, so it must NOT be re-framed by
  // the static fit-scale — the text stays at world scale and the camera travels.
  const isFlythrough = reveal?.mode === "flythrough";

  // ── Per-frame reveal ──
  const update = (api: ThreeFrameApi): void => {
    if (!reveal) return; // no reveal ⇒ everything stays visible (built visible)
    const progress = api.progress;
    // Discovery modes pace off `revFrac` (the portion of THIS element's window the
    // reveal occupies) — derived from reveal.durationMs when set, so an 800ms
    // typewriter stays 800ms regardless of the overlay's full duration. api.duration
    // is element-local seconds.
    const revFrac = revealFraction(reveal, api.duration);
    // VOICE SYNC: when the overlay carries real per-word STT timings, the
    // word-indexed reveals (typewriter / word-current / karaoke / fade-words)
    // drive off `caption.words` + element-local `api.time` — the SAME math the 2D
    // path and code overlays use — instead of the linear even-spacing `progress`.
    // Absent ⇒ the progress-based fallbacks below (unchanged). The 3D `wordIndex`
    // counts words by spaces in `content`, which is the join of `caption.words`,
    // so the indices align.
    const words = api.words;
    const useTime = !!(words && words.length);
    switch (reveal.mode) {
      case "typewriter": {
        const fraction = revFrac;
        const eff = fraction > 0 ? Math.min(1, progress / fraction) : 1;
        // `round` (not `floor`), matching the 2D path's typewriterCharCount: with
        // `floor`, the final glyph needed eff===1 EXACTLY, so a clip shorter than
        // the overlay (progress never reaches `fraction`) permanently dropped the
        // last letter ("test" → "tes"); `floor` also delayed the FIRST glyph until
        // eff>=1/N. `round` lands the last glyph at progress≈fraction and the first
        // almost immediately. Clamped so it never exceeds the glyph count.
        const n = useTime
          ? Math.min(visibleGlyphCount, typewriterVisibleGlyphCount(words!, api.time))
          : Math.min(visibleGlyphCount, Math.round(eff * visibleGlyphCount));
        for (const g of glyphs) g.obj.visible = g.glyphIndex < n;
        break;
      }
      case "word-current": {
        const active = useTime
          ? activeWordIndex(words!, api.time)
          : activeWordIndexByProgress(
              Array.from({ length: wordCount }, (_, i) => String(i)),
              progress,
            );
        for (const g of glyphs) g.obj.visible = g.wordIndex === active;
        break;
      }
      case "karaoke": {
        // Whole text visible; emphasize the active word by scaling it up AND
        // (2D parity) recoloring it to reveal.highlightColor. When no
        // highlightColor is set we skip color writes entirely — scale-only.
        const active = useTime
          ? activeWordIndex(words!, api.time)
          : activeWordIndexByProgress(
              Array.from({ length: wordCount }, (_, i) => String(i)),
              progress,
            );
        const hl = reveal.highlightColor ?? null;
        for (const g of glyphs) {
          g.obj.visible = true;
          const isActive = g.wordIndex === active;
          const s = isActive ? 1.18 : 1.0;
          g.obj.scale.set(s, s, s);
          if (hl) g.setColor(isActive ? hl : null);
        }
        break;
      }
      case "flythrough": {
        // Side camera tracks the painting letter; each glyph is simply painted on
        // at full size as the front passes it (no grow-in), finishing on the last.
        const dir = reveal.direction ?? "ltr";
        const f = flythroughFrame(progress, textW, { direction: dir, sideOffset: reveal.sideOffset });
        camera.position.set(f.camX, f.camY, f.camZ);
        camera.lookAt(f.lookX, f.lookY, f.lookZ);
        camera.updateProjectionMatrix();
        for (const g of glyphs) {
          g.obj.visible = glyphPainted(f.writeFront, g.obj.position.x, dir);
          g.obj.scale.setScalar(1);
        }
        break;
      }
      case "fade-words": {
        // Voice-synced fade-words: each word fades in (REAL per-glyph opacity, 2D
        // parity — this instance owns its materials, so mutating opacity never
        // touches the shared GEOMETRY cache) at its OWN spoken start, from real
        // word timings. Falls back to the even-spaced `fadeWordsAlpha` stagger —
        // the SAME helper the 2D path uses — when there are no word times.
        const alphas = useTime
          ? fadeWordsAlphaByTime(words!, api.time)
          : fadeWordsAlpha(wordCount, progress);
        for (const g of glyphs) {
          const a = alphas[g.wordIndex] ?? 1;
          g.obj.visible = a > 0;
          g.obj.position.y = g.baseY;
          g.obj.scale.setScalar(1);
          g.setOpacity(a);
        }
        break;
      }
      case "slide-up":
      case "pop": {
        // Per-WORD staggered ENTRANCE (cumulative — earlier words stay revealed),
        // animated via per-object transform only (no color/opacity writes). These
        // are decorative entrances (not per-word voice sync), so they stay
        // progress-paced — same as the 2D path. Math is the pure `glyphRevealState`
        // helper.
        const rise = WORLD_FONT_SIZE * 0.9; // slide-up travel in world units
        const opts = { fraction: revFrac, wordCount, rise };
        for (const g of glyphs) {
          const st = glyphRevealState(reveal.mode, g.wordIndex, progress, opts);
          g.obj.visible = st.visible;
          g.obj.position.y = g.baseY + st.dy;
          g.obj.scale.setScalar(st.scale);
        }
        break;
      }
      default: {
        // Unknown reveal mode — show all glyphs at rest.
        for (const g of glyphs) {
          g.obj.visible = true;
          g.obj.position.y = g.baseY;
          g.obj.scale.setScalar(1);
        }
        break;
      }
    }
  };

  const ready = Promise.resolve();

  // Last GL drawing-buffer size requested — see three-overlay.ts for why setSize
  // is guarded (per-overlay renderer + skip-if-unchanged avoids per-frame realloc).
  let _lastW = -1;
  let _lastH = -1;

  return {
    update: reveal ? update : undefined,
    applyTransform(t) {
      // Apply gizmo transform to the ROOT group (not the scene) so the glyph
      // centering offset on root.position.x is preserved — we compose by setting
      // position relative to the centering, but the simplest correct behavior is
      // to put the transform on the scene root (matching three-overlay.ts).
      scene.position.set(t.position.x, t.position.y, t.position.z);
      scene.rotation.set(t.rotation.x, t.rotation.y, t.rotation.z);
      // Scale is no longer part of Transform3D (flip is handled via flipH/flipV
      // booleans on the overlay). Reset to identity so the scene uses its defaults.
      scene.scale.set(1, 1, 1);
    },
    render(baseW, baseH, expandedW = baseW, expandedH = baseH, offsetX = 0, offsetY = 0) {
      if (expandedW !== _lastW || expandedH !== _lastH) {
        shared.renderer.setSize(expandedW, expandedH, false);
        _lastW = expandedW;
        _lastH = expandedH;
      }
      if (baseW > 0 && baseH > 0) {
        // Fit and framing are always keyed to the BASE aspect so text size stays
        // stable when the buffer expands to cover out-of-bounds projected content.
        camera.aspect = baseW / baseH;
        // Flythrough keeps world scale (the camera handles framing) — skip fit.
        if (!isFlythrough) {
          const s = fitScaleForFrame(textW, textH, camera.fov, camDistance, baseW / baseH);
          root.scale.setScalar(s);
        }
        if (expandedW !== baseW || expandedH !== baseH) {
          // Super-frame: the base framing occupies [offsetX, offsetY, baseW, baseH]
          // of the expanded output.
          camera.setViewOffset(baseW, baseH, -offsetX, -offsetY, expandedW, expandedH);
        } else {
          camera.clearViewOffset();
        }
        camera.updateProjectionMatrix();
      }
      shared.renderer.render(scene, camera);
      return shared.renderer.domElement;
    },
    contentBoundsNDC() {
      const box = new THREE.Box3().setFromObject(scene);
      if (box.isEmpty()) return null;
      // Measure through the BASE frustum: render() may have left a setViewOffset on
      // the camera from the previous frame; projecting through that stale offset
      // poisons the bounds (clipping + box jump + flicker). Clear it before measuring.
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
      const v = new THREE.Vector3();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        v.project(camera); // → NDC [-1,1]
        const sx = (v.x + 1) / 2;
        const sy = (1 - v.y) / 2; // flip Y to top-left origin
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
      return { minX, minY, maxX, maxY };
    },
    dispose() {
      scene.traverse((obj) => {
        const m = obj as unknown as {
          geometry?: { dispose?: () => void };
          material?: { dispose?: () => void } | Array<{ dispose?: () => void }>;
          dispose?: () => void;
          isLibiCanvasText?: boolean;
        };
        // CanvasText-backed faux planes (kind:"three" faux path) HAVE a
        // .geometry, so a geometry-absence check would miss them. Their own
        // dispose() frees both the plane geometry/material AND the internal
        // CanvasTexture (which three does NOT cascade from material.dispose()).
        // Route them through dispose() exclusively — never the geometry/material
        // branch below (which would double-dispose).
        if (m.isLibiCanvasText && typeof m.dispose === "function") {
          m.dispose();
          return;
        }
        // Premium glyph meshes: free the geometry ONLY when it isn't a shared,
        // cache-owned ExtrudeGeometry. Disposing a cached geometry would corrupt
        // every other overlay instance still sharing that glyph and hand a dead
        // handle to future builds — the cache owns its lifetime, not the instance.
        if (m.geometry && !isCachedGeometry(m.geometry)) m.geometry.dispose?.();
        if (Array.isArray(m.material)) m.material.forEach((mm) => mm.dispose?.());
        else m.material?.dispose?.();
      });
    },
    ready,
  };
}
