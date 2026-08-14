# Rough-canvas illustration unit

## What it is

The default storyboard sketch is a black-and-white hand-drawn illustration rendered with Rough.js onto a node Canvas2D context. Its job is to convey **scene organization** — composition, framing, subject placement, lighting direction — NOT character likeness. Loose and gestural figures are expected and fine; the image model decides the final look. Think of it as a quick director's thumbnail: a guide, not finished art.

## How the sketch is used downstream

The rendered sketch is fed to the image model as a **loose layout reference the model varies on** — not a drawing to reproduce. Expect and *want* the model to improve proportions, realism, and detail; the sketch only fixes blocking (where things sit, framing, lighting direction). So **don't over-invest in sketch fidelity** — a quick, clear thumbnail is the goal. The sketch is also **optional**: a keyframe can be generated from the prompt + character reference alone, and a sketch that's hurting the keyframe should be dropped (see the `using-storyboard` skill, "What's optional").

## The canvas unit contract

- The unit **must** use `kind: "canvas"`.
- The body destructures: `const { ctx, rough, width, height, INK, GRAYS } = context;`
- Paper background is a plain `ctx` fill: `ctx.fillStyle = "#f3f1ec"; ctx.fillRect(0, 0, width, height)`
- Draw everything else with `rough` (hand-drawn primitives) and `ctx` (plain fills/strokes).
- **FULL-BLEED — never draw a caption bar, shot-tag, border, or frame.** Any chrome baked into the PNG leaks into the image-gen composition reference and corrupts it.
- Use `INK` (`"#1a1a1a"`) for all linework.
- Pick depth from `GRAYS` (a light→dark grayscale array): distant elements → lower index (lighter); foreground → higher index (darker).

## The `rough` API

Primitives:
- `rough.rectangle(x, y, w, h, opts)`
- `rough.circle(cx, cy, diameter, opts)`
- `rough.ellipse(cx, cy, w, h, opts)`
- `rough.line(x1, y1, x2, y2, opts)`
- `rough.polygon([[x,y], …], opts)`
- `rough.path("M…", opts)`
- `rough.linearPath([[x,y], …], opts)`

`opts` keys: `{ fill, fillStyle: "solid"|"hachure"|"cross-hatch", stroke, strokeWidth, roughness, hachureGap, hachureAngle }`

## Worked exemplar

9:16 portrait (720×1280) — UGC creator MCU presenting a product by a window.

```js
// canvas unit body — full-bleed rough sketch. context: { ctx, rough, width, height, INK, GRAYS }
const { ctx, rough, width: W, height: H, INK, GRAYS } = context;

// paper background (plain ctx)
ctx.fillStyle = "#f3f1ec";
ctx.fillRect(0, 0, W, H);

// soft window light, upper-right — a light value block + mullions
rough.rectangle(W * 0.52, H * 0.06, W * 0.42, H * 0.30, { fill: "#faf8f4", fillStyle: "solid", stroke: "#c7c3ba", strokeWidth: 2 });
rough.line(W * 0.73, H * 0.06, W * 0.73, H * 0.36, { stroke: "#c7c3ba", strokeWidth: 2 });
rough.line(W * 0.52, H * 0.21, W * 0.94, H * 0.21, { stroke: "#c7c3ba", strokeWidth: 2 });

// SUBJECT — medium close-up, centered. One connected figure: shoulders → neck → head.
const cx = 288;            // ~0.40 W
const cy = 384;            // face center, ~0.30 H
// shoulders mass — top meets the neck (~y514), flares to frame width at the bottom
rough.path(`M${cx - 46} 512 C ${cx - 235} 560, ${cx - 262} 840, ${cx - 262} ${H} L ${cx + 262} ${H} C ${cx + 262} 840, ${cx + 235} 560, ${cx + 46} 512 Z`, { fill: GRAYS[2], fillStyle: "solid", stroke: INK, strokeWidth: 2.6 });
// neck — connects head to shoulders
rough.path(`M${cx - 42} 470 q42 26 84 0 l4 46 q-46 26 -92 0 Z`, { fill: GRAYS[3], fillStyle: "solid", stroke: INK, strokeWidth: 2 });
// hair mass (behind the face)
rough.path(`M${cx - 128} 386 q-22 -172 128 -172 q150 0 128 172 q-34 -80 -128 -73 q-94 -7 -128 73 Z`, { fill: GRAYS[4], fillStyle: "hachure", hachureGap: 6, stroke: INK, strokeWidth: 2.2 });
// face
rough.ellipse(cx, cy, 168, 210, { fill: GRAYS[1], fillStyle: "solid", stroke: INK, strokeWidth: 2.4 });
// loose features (composition, not likeness)
rough.line(cx - 46, cy - 24, cx - 14, cy - 30, { stroke: INK, strokeWidth: 3 });
rough.line(cx + 16, cy - 30, cx + 48, cy - 24, { stroke: INK, strokeWidth: 3 });
rough.circle(cx - 30, cy - 6, 11, { fill: INK, fillStyle: "solid", stroke: INK });
rough.circle(cx + 32, cy - 6, 11, { fill: INK, fillStyle: "solid", stroke: INK });
rough.path(`M${cx + 2} ${cy - 2} l-10 30 q9 9 18 0`, { stroke: INK, strokeWidth: 2.6 });
rough.path(`M${cx - 30} ${cy + 52} q32 24 62 0`, { stroke: INK, strokeWidth: 3.2 });

// raised hand presenting the product, over the shoulder (foreground)
const hx = 470, hy = 760;
rough.path(`M${hx - 34} ${hy + 58} q-28 -10 -22 -56 q5 -28 28 -24 l44 9 q28 6 24 32 l-9 44 Z`, { fill: GRAYS[2], fillStyle: "solid", stroke: INK, strokeWidth: 2.2 });
// the product bottle
rough.rectangle(hx - 6, hy - 96, 56, 98, { fill: "#e9e6df", fillStyle: "solid", stroke: INK, strokeWidth: 2.6 });
rough.rectangle(hx + 8, hy - 128, 30, 34, { fill: GRAYS[3], fillStyle: "solid", stroke: INK, strokeWidth: 2.2 });
rough.rectangle(hx, hy - 66, 44, 42, { fill: GRAYS[0], fillStyle: "hachure", hachureGap: 5, stroke: INK, strokeWidth: 1.8 });
```

## Other scene patterns

Adapt these starting points — do NOT copy full bodies for scenes that don't match:

- **Establishing wide:** horizon via `rough.line`/`linearPath`; houses as `rough.polygon`; tree canopies as hachured `rough.circle`; long ground-shadows as hachured `rough.polygon`.
- **Product macro:** dark `ctx` background + chalk-light strokes (`stroke: "#ece9e2"`); bottle on a plinth; hard rim-light line.
- **Interior:** window light block; furniture as gray masses; depth via `GRAYS`.
- **Cinematic wide:** S-curve road as a thick `rough.path`; hachured headlands.
