# Golden frames — overlay sandbox

Baselines for `e2e/overlay-sandbox-golden.spec.ts`. A code overlay (bundled Inter 700, an uploaded JetBrains Mono face, a gradient and 12 filled circles), a text overlay carrying that uploaded font, and a three overlay (a cube and a `new Text()` "Parity" label), rendered through `/api/render/frames` → chromium-render at 0.5 s and 1.5 s. The piece is pinned to 1920×1080 and the verify render caps the short side at 720, so each PNG is 1280×720.

The spec asserts ±1 per channel. The current frames were captured from HEAD on 2026-09-27, because the fixture gained its 3D-text label in a deliberate rendering change; see [Provenance](#provenance). Before that, the frames came from the renderer as it was BEFORE overlay bodies moved into the sandboxed runtime, and the spec was a refactor-parity check against that output. A capture-path change still regenerates from that pre-refactor renderer ([Regenerating](#regenerating)).

## Provenance

- **Why recaptured:** the fixture changed. The three body has its `new Text()` label again, in place of the bar mesh that stood in for it, so the label's pixels are new. It could come back because `lib/engine/canvas-text.ts` now draws the label on a CPU-backed canvas (`willReadFrequently`), which is a deliberate rendering change for the two paths that draw through `CanvasText`: a three body's `Text`, and the faux fallback of host-built 3D text (an uploaded font in a format the extruder can't use, `lib/engine/text-3d/browser-deps.ts`). Ordinary 3D text overlays are extruded geometry and did not change. A deliberate rendering change is the one case AGENTS.md → Overlay sandbox allows to re-baseline from HEAD, so these frames come from HEAD. A capture-path change still may not (see [Regenerating](#regenerating)).
- **What else moved:** nothing unrelated to the label, as far as the old frames can show. The unchanged fixture (the bar) passed against the 2026-09-24 baselines at the parent commit just before this change. Old against new: on the 500 ms I-frame the code and text overlays (x < 700) are byte-identical, and every difference sits in the three overlay's rect and its macroblock rows. On the 1.5 s P-frame the spill reaches the whole frame (re-predicted from the changed I-frame, the mechanism recorded below for 2026-09-24). The cube itself could not be compared, because the label moved the content-fit framing.
- **Tree:** `week/2026-10-02` at the TF-3 commit (a detached worktree of it with its own `node_modules`, since the week worktree had a dev server running).
- **Command:** `LIBI_GOLDEN_UPDATE=1 npx playwright test e2e/overlay-sandbox-golden.spec.ts`, with a fresh `LIBI_E2E_HOME` whose `bin/` was seeded with the provisioned ffmpeg/ffprobe, on **2026-09-27**, under macOS 27.0.
- **Checked:** two further runs of `--repeat-each=10`, each under its own fresh home, rendered all 20 compares byte-identical to the capture (SHA-256 of every rendered PNG). SHA-256 of the committed files:
  - `frame-500ms.png`: `c4843943568a543d18c1a10e5c59970048c7374a8f7663632bac54e03c4023fc`
  - `frame-1500ms.png`: `4d2f1db0b3342fb63cd4f798ba5b3b796c79ffb69ce8e9c093c6c99c3a322203`

### The pre-refactor baselines (2026-09-24), kept for their history

- **Renderer:** commit `3110575a` ("Make the golden fixture deterministic…"). This is the Task 2 commit, made before any renderer change in the sandbox refactor.
- **Capture path:** `3110575a` plus the capture change from `40bd30c6` ("Render only the frames render_overlay_frames asks for"), cherry-picked on top. In `lib/engine/export.ts`, the only conflict was resolved by keeping `3110575a`'s `exportVideo` signature and widening `frameRange` to `FrameRange | FrameList`. Two other files conflict, and neither affects rendering. `__tests__/unit/export/export-body-layers.test.ts` does not exist at `3110575a`, so it is dropped. `mcp/templates/instructions.md` keeps `3110575a`'s text. From `40bd30c6` onward, `renderCompositionFrames` encodes **only the requested frames** (here 15 and 45) into the MP4. It no longer encodes the whole 90-frame piece.
- **Command:** `LIBI_GOLDEN_UPDATE=1 npx playwright test e2e/overlay-sandbox-golden.spec.ts`, run on that tree (a throwaway detached worktree, `npm ci`, a fresh `LIBI_HOME` per capture) on **2026-09-24**, under macOS 27.0.
- **Checked twice:** two independent captures by that method were byte-identical. SHA-256 of the committed files:
  - `frame-500ms.png`: `526e4c775db11c14478fe6684be40a7485779b79aab6b1820df7d355fb4b5a3f`
  - `frame-1500ms.png`: `cfe8a56a702c8139c77e93b12b714dc9c493e3a40251ef146cee02ee8eef7919`
- **Parity at the time of capture:** the spec at `feat/templates` `52815e39` then passed three times against these files, and every frame it rendered was byte-identical to them.

#### Why the 2026-09-24 baselines replaced the 2026-09-23 ones

The 2026-09-23 capture (same tree, same method; SHA-256 `c916e8a7…` for 500 ms, `b0b93427…` for 1500 ms) was taken under **macOS 26.6.2**. On 2026-09-24 the machine upgraded to **macOS 27.0** (26A428), and from then on the spec failed on every run with one signature, at HEAD and (as reported) at `6d80c830` alike: 47,541 channels over ±1, max delta 61, on the 500 ms frame. No rendering code had changed. The OS upgrade changed **text rasterization**.

This recapture comes from the **pre-refactor** tree, exactly as above, never from HEAD. Diffing it against the 2026-09-23 files confirms the cause:
- The pre-refactor tree reproduces HEAD's failing 500 ms frame byte for byte. The pre-refactor tree and HEAD render identically on macOS 27. Only the OS changed.
- Every large delta sits on the glyphs of the three text lines (max 61 at 500 ms, 59 at 1500 ms).
- Every differing pixel lies in the 16-px macroblock rows that carry that text (y 64–335 of 720). Nothing below them differs: the circles, the cube's lower half and the bar are byte-identical.
- Off the glyphs, inside those rows, the deltas are encoder spill. On the 500 ms I-frame, flat gradient in those rows shifts by up to 3. Right of x 700, nothing differs by more than 3. On the 1500 ms P-frame, the cube's left edge shifts by up to 11 inside those rows (392 pixels), because that frame is predicted from the changed I-frame. The intra-coded 500 ms frame shows no such shift on the cube, so the cube's own rasterization did not change.

#### Why the 2026-09-23 baselines replaced the first ones

The first baselines, committed in `b97672ce` and `3110575a`, were cut from an MP4 of the **whole piece**. Frame 15 was a P-frame, 15 frames after the keyframe at 0. After `40bd30c6`, the MP4 holds only the requested frames. Frame 15 becomes the file's first frame, an I-frame, and frame 45 is predicted from it.

The rendered pixels do not change, but quantisation and prediction do, so every decoded PNG shifts slightly everywhere:
- 954,199 channels exceeded ±1, with a max delta of 82;
- the differences sit on every edge, including the host-drawn text overlay, which is never sandboxed;
- flat gradient areas band by ±3–4.

That is **encoder noise from the frames-only encode, not a rendering change.** Two checks confirm it:
- HEAD with the capture forced back to the whole-piece encode passes against the first baselines.
- The pre-refactor renderer with the frames-only encode reproduces the same 954,199 / 82 failure signature, with no sandbox code involved.

Bisect and evidence: Task 14 of the overlay-sandbox plan.

## What this guard does and does not catch

These are **not** the renderer's raw pixels. `renderCompositionFrames` (`lib/render/frame-capture.ts`) renders the composition to an H.264 MP4 at 2 Mbps, 720 short side, then extracts each PNG from it with ffmpeg — so "±1 per channel" is measured **after a lossy encode/decode round trip**. The round trip is deterministic — for the current baselines, two independent captures were byte-identical and every compare run since has matched them byte for byte (three at HEAD on 2026-09-24; the 2026-09-23 baselines had six in Task 14: three on the capture tree, three at HEAD) — which is what makes the guard usable, but it is also a low-pass filter.

- **Reliably caught:** a font falling back to another face, a fill that stops painting, a draw helper that silently no-ops, a layout or position shift, a colour change, an overlay that stops rendering, the three scene going missing.
- **May NOT be caught:** sub-pixel antialiasing differences and other changes confined to within a macroblock's quantization noise — they can quantize away before reaching the PNG.

A green run means *"no visible change at export fidelity"*, not *"byte-identical rasterization"*. Report it at that fidelity.

## 3D text is covered again

The three overlay puts a "Parity" label (`new Text()`) under the cube. So the spec proves again that `Text` is injected into three bodies (it is one of `THREE_PARAM_NAMES`), and that a label exports the same pixels every run.

The label was out of the fixture from 2026-09-23 to 2026-09-27. About one run in three differed on its glyphs, with two or three stable outcomes rather than noise. It was first read as a latching race: the texture uploaded a frame late. Instrumenting the real export path (TF-3, 2026-09-27) showed otherwise:
- The label is drawn synchronously when the body is built. Its metrics were identical on every run, and `needsUpdate` is set before the first render.
- The label canvas ITSELF differed. Hashed right after `fillText` in the sandbox worker, the same text, size and face gave three different bitmaps in eight runs. The canvas was a GPU-backed 2D context, and its large-glyph rasterization is not repeatable.
- The raw composed frame then differed by ±1 on a 2×2 block of the "y". The encoder turned that into 506 channels (max delta 23) on the 1.5 s P-frame.
- With a CPU-backed context (`willReadFrequently`), twelve runs out of twelve gave one bitmap, and the golden went byte-identical.

`__tests__/unit/engine/three-text-latch.test.ts` pins both the context attributes and the draw → `needsUpdate` → render order. If the label starts flaking again, suspect the label canvas's backing first.

## Capture environment

The baselines are specific to this machine. A different Chromium revision, ffmpeg build, or GPU/rasterizer can legitimately shift them, so re-measure before treating them as a CI gate.

- Chromium: Playwright revision **1217** (Chromium 147.0.7727.15, `channel: "chromium"`, full build; Playwright 1.59.1 in both the capture tree and HEAD), launched GPU-first with a SwiftShader fallback
- ffmpeg: **9.0.1** for the 2026-09-27 capture (martin-riedl.de build, copied from this machine's provisioned `~/.libi/bin` into the e2e home). The 2026-09-24 capture used **9.0.2**, re-read then from both capture homes and the HEAD compare homes (an earlier version of this README said 8.1.2; that was wrong).
- Render mode: GPU (`ANGLE Metal Renderer: Apple M5 Pro`), hardware H.264 encode (`hwEncode: true`), as logged in `export.render_gpu_mode`. On macOS that encoder is the OS's own, so an OS upgrade can move these files even with no code or ffmpeg change.
- Platform: **macOS 27.0 (26A428), arm64**. The 2026-09-23 baselines were captured on macOS 26.6.2, and the upgrade to 27.0 changed text rasterization enough to fail the spec. An OS upgrade is not a code change: recapture from the pre-refactor tree (with the TF-3 cherry-pick) as described in [Regenerating](#regenerating), and check that the recapture is repeatable before committing it.

## Regenerating

Regenerate only for a deliberate rendering change or a deliberate change to the capture path, and say why in the commit.

- **A deliberate rendering change** re-baselines from HEAD, as the 2026-09-27 capture did.
- **A capture-path change** (encoder settings, which frames are encoded, a Playwright or Chromium bump) regenerates from the **pre-refactor** renderer (`3110575a`) with the new capture applied, as described in [Provenance](#provenance). Capturing from HEAD would bake in any sandbox-only rendering regression that landed in the same window, and a repeat run would not catch it: it checks repeatability, not correctness. Since 2026-09-27 the fixture has the label, so also cherry-pick the one-line `willReadFrequently` fix from `lib/engine/canvas-text.ts` (TF-3) onto that tree, the same way `40bd30c6`'s capture change was. `3110575a` has the same `CanvasText`, so it picks cleanly, and the result also compares host and sandbox 3D-text output.

Either way, run `--repeat-each=10` against a fresh capture before committing it. A baseline that differs one run in three is worse than none.

```bash
LIBI_GOLDEN_UPDATE=1 npm run test:e2e -- e2e/overlay-sandbox-golden.spec.ts
```

Update mode self-checks what it captures (distinct colours + share of non-gradient pixels) and refuses to write a frame where the fixture did not actually paint — the first capture of these baselines silently drew almost nothing, and only a human opening the PNG noticed.
