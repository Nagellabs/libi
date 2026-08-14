/** Canvas2D-texture 3D text — a synchronous, dependency-free drop-in for the
 *  subset of troika-three-text's `Text` API that three-overlay scene bodies use.
 *
 *  WHY: troika 0.52's unicode-font-resolver throws (`text` undefined) when bundled
 *  by turbopack, so `.sync()` never fires, the export/preview `ready` gate hangs,
 *  and 3D text never renders. This renders glyphs to a 2D canvas, uploads them as
 *  a CanvasTexture on a PlaneGeometry, and resolves `.sync()` synchronously — no
 *  workers, no CDN font fetch, no SDF build, no hang.
 *
 *  Supported `Text` surface (all the templates + three3d.glowText touch):
 *    text, fontSize, color, anchorX, anchorY, outlineColor, outlineBlur,
 *    outlineWidth, font, material (MeshBasicMaterial w/ opacity+transparent),
 *    position/rotation/scale (inherited from Mesh), sync(cb), dispose().
 */

type AnyTHREE = typeof import("three");

/** Drawing resolution: glyph cap-height in canvas pixels. Higher = sharper +
 *  more texture memory. 192 keeps caption text crisp at 1080p while bounding a
 *  ~20-char line to a ~2–3k-px-wide texture. */
const FONT_PX = 192;

/** Default family — a bold sans matching the AI-caption look; Chromium (preview
 *  + headless render page) always has these. troika's default was Roboto. */
const DEFAULT_FAMILY = "Arial, Helvetica, sans-serif";

function toCss(color: string | number): string {
  if (typeof color === "number") return `#${(color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
  return color;
}

/** Resolve troika's `font` (a URL or family) to a CSS family. A URL (woff/ttf)
 *  can't be applied synchronously without @font-face load, so we fall back to the
 *  default family rather than hang — captions read fine in a system bold sans. */
function resolveFamily(font: string | undefined): string {
  if (!font) return DEFAULT_FAMILY;
  if (/^https?:|\.(woff2?|ttf|otf)(\?|$)/i.test(font)) return DEFAULT_FAMILY;
  return font;
}

export interface CanvasTextLike {
  text: string;
  fontSize: number;
  color: string | number;
  anchorX: string | number;
  anchorY: string | number;
  outlineColor: string | number;
  outlineBlur: number;
  outlineWidth: number;
  font?: string;
  sync(cb?: () => void): void;
  dispose(): void;
}

/** Build a `Text`-compatible class bound to a concrete THREE module. The scene
 *  body receives an instance via the injected `Text` param and uses it exactly
 *  as it used troika's Text. */
export function makeCanvasTextClass(THREE: AnyTHREE) {
  return class CanvasText extends THREE.Mesh implements CanvasTextLike {
    /** Marker so dispose() paths that traverse a scene can identify a CanvasText
     *  (which HAS a .geometry, so a geometry-absence check would miss it) and
     *  call its dispose() to free the internal CanvasTexture. */
    readonly isLibiCanvasText = true;
    text = "";
    fontSize = 1;
    color: string | number = "#ffffff";
    anchorX: string | number = "center";
    anchorY: string | number = "middle";
    outlineColor: string | number = "#000000";
    outlineBlur = 0;
    outlineWidth = 0;
    font: string | undefined = undefined;

    private _canvas: HTMLCanvasElement;
    private _texture: import("three").CanvasTexture;

    /** Post-sync font metrics (see the `metrics` getter). Zero until first sync. */
    private _ascent = 0;
    private _descent = 0;
    private _worldH = 0;
    private _baselineOffset = 0;

    constructor() {
      const geometry = new THREE.PlaneGeometry(1, 1);
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
      });
      super(geometry, material);
      this._canvas = canvas;
      this._texture = texture;
    }

    /** Rasterize the current text → texture, resize the plane to match, then
     *  call back synchronously. (troika's async SDF gate is unnecessary here.) */
    sync(cb?: () => void): void {
      const text = String(this.text ?? "");
      const family = resolveFamily(this.font);
      const fontSpec = `bold ${FONT_PX}px ${family}`;

      const canvas = this._canvas;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        cb?.();
        return;
      }

      // Measure at draw resolution.
      ctx.font = fontSpec;
      const metrics = ctx.measureText(text || " ");
      const textW = Math.max(1, Math.ceil(metrics.width));
      const ascent = metrics.actualBoundingBoxAscent ?? FONT_PX * 0.8;
      const descent = metrics.actualBoundingBoxDescent ?? FONT_PX * 0.2;
      const glyphH = Math.max(1, Math.ceil(ascent + descent));

      // Pad for glow/outline so the blur isn't clipped at the texture edge.
      const blurPx = this.outlineBlur > 0 ? this.outlineBlur * FONT_PX : 0;
      const strokePx = this.outlineWidth > 0 ? this.outlineWidth * FONT_PX : 0;
      const pad = Math.ceil(blurPx * 1.5 + strokePx + FONT_PX * 0.15);

      canvas.width = textW + pad * 2;
      canvas.height = glyphH + pad * 2;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      // Resizing the canvas resets its context; re-apply state.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = fontSpec;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const fill = toCss(this.color);

      // Glow: stack a few shadowed fills so the bloom builds up.
      if (blurPx > 0) {
        ctx.shadowColor = toCss(this.outlineColor);
        ctx.shadowBlur = blurPx;
        ctx.fillStyle = fill;
        for (let i = 0; i < 3; i++) ctx.fillText(text, cx, cy);
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }

      // Solid stroke outline (troika outlineWidth > 0).
      if (strokePx > 0) {
        ctx.lineJoin = "round";
        ctx.lineWidth = strokePx;
        ctx.strokeStyle = toCss(this.outlineColor);
        ctx.strokeText(text, cx, cy);
      }

      ctx.fillStyle = fill;
      ctx.fillText(text, cx, cy);

      this._texture.needsUpdate = true;

      // World sizing: map the glyph's pixel height → fontSize world units so the
      // plane (incl. padding) keeps the glyph at the requested fontSize.
      const worldH = this.fontSize * (canvas.height / glyphH);
      const worldW = worldH * (canvas.width / canvas.height);

      // Baseline metrics (world units). The glyph is drawn textBaseline="middle",
      // so the alphabetic baseline sits (ascent−descent)/2 canvas-px BELOW the
      // texture's vertical center (padding cancels). Converting px→world via
      // (worldH/canvas.height) = fontSize/glyphH gives the distance from the
      // MIDDLE-anchored plane's center down to the baseline — i.e. how far UP the
      // plane must move so the baseline lands at the mesh origin. Consumers that
      // stack per-glyph planes (faux 3D text) use this to share one baseline
      // instead of aligning glyph texture centers (descenders would float).
      this._ascent = ascent;
      this._descent = descent;
      this._worldH = worldH;
      this._baselineOffset = ((ascent - descent) / 2) * (this.fontSize / glyphH);

      this.geometry.dispose();
      const geometry = new THREE.PlaneGeometry(worldW, worldH);

      // Anchor: PlaneGeometry is origin-centered; translate so the requested
      // anchor edge sits at the mesh origin (templates use center/middle).
      const ax = this.anchorX;
      const ay = this.anchorY;
      let dx = 0;
      let dy = 0;
      if (ax === "left") dx = worldW / 2;
      else if (ax === "right") dx = -worldW / 2;
      if (ay === "top") dy = -worldH / 2;
      else if (ay === "bottom" || ay === "bottom-baseline") dy = worldH / 2;
      if (dx !== 0 || dy !== 0) geometry.translate(dx, dy, 0);

      this.geometry = geometry;
      cb?.();
    }

    /** Font metrics measured on the last sync(). `ascent`/`descent` are canvas
     *  px; `worldH` is the plane height in world units; `baselineOffset` is the
     *  world-unit y-shift that puts the (middle-anchored) plane's baseline at the
     *  mesh origin. All zero before the first sync(). Additive read-only surface —
     *  existing consumers (default center/middle anchors) are unaffected. */
    get metrics(): { ascent: number; descent: number; worldH: number; baselineOffset: number } {
      return {
        ascent: this._ascent,
        descent: this._descent,
        worldH: this._worldH,
        baselineOffset: this._baselineOffset,
      };
    }

    dispose(): void {
      this.geometry.dispose();
      this._texture.dispose();
      const mat = this.material as import("three").Material | import("three").Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  };
}
