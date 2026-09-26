# Golden frames — overlay sandbox

Baselines for `e2e/overlay-sandbox-golden.spec.ts`. A code overlay (bundled Inter 700, an uploaded JetBrains Mono face, a gradient and 12 filled circles), a text overlay carrying that uploaded font, and a three overlay, rendered through `/api/render/frames` → chromium-render at 0.5 s and 1.5 s. The piece is pinned to 1920×1080 and the verify render caps the short side at 720, so each PNG is 1280×720.

These frames come from the renderer as it was BEFORE overlay bodies moved into the sandboxed runtime, so the spec is a refactor-parity check against pre-refactor output. It asserts ±1 per channel. See [Provenance](#provenance) for exactly how they were captured.

## Provenance

- **Renderer:** commit `3110575a` ("Make the golden fixture deterministic…"). This is the Task 2 commit, made before any renderer change in the sandbox refactor.
- **Capture path:** `3110575a` plus the capture change from `40bd30c6` ("Render only the frames render_overlay_frames asks for"), cherry-picked on top. In `lib/engine/export.ts`, the only conflict was resolved by keeping `3110575a`'s `exportVideo` signature and widening `frameRange` to `FrameRange | FrameList`. Two other files conflict, and neither affects rendering. `__tests__/unit/export/export-body-layers.test.ts` does not exist at `3110575a`, so it is dropped. `mcp/templates/instructions.md` keeps `3110575a`'s text. From `40bd30c6` onward, `renderCompositionFrames` encodes **only the requested frames** (here 15 and 45) into the MP4. It no longer encodes the whole 90-frame piece.
- **Command:** `LIBI_GOLDEN_UPDATE=1 npx playwright test e2e/overlay-sandbox-golden.spec.ts`, run on that tree (a throwaway detached worktree, `npm ci`, a fresh `LIBI_HOME` per capture) on **2026-09-24**, under macOS 27.0.
- **Checked twice:** two independent captures by that method were byte-identical. SHA-256 of the committed files:
  - `frame-500ms.png`: `526e4c775db11c14478fe6684be40a7485779b79aab6b1820df7d355fb4b5a3f`
  - `frame-1500ms.png`: `cfe8a56a702c8139c77e93b12b714dc9c493e3a40251ef146cee02ee8eef7919`
- **Parity at the time of capture:** the spec at `feat/templates` `52815e39` then passed three times against these files, and every frame it rendered was byte-identical to them.

### Why these baselines replaced the 2026-09-23 ones

The 2026-09-23 capture (same tree, same method; SHA-256 `c916e8a7…` for 500 ms, `b0b93427…` for 1500 ms) was taken under **macOS 26.6.2**. On 2026-09-24 the machine upgraded to **macOS 27.0** (26A428), and from then on the spec failed on every run with one signature, at HEAD and (as reported) at `6d80c830` alike: 47,541 channels over ±1, max delta 61, on the 500 ms frame. No rendering code had changed. The OS upgrade changed **text rasterization**.

This recapture comes from the **pre-refactor** tree, exactly as above, never from HEAD. Diffing it against the 2026-09-23 files confirms the cause:
- The pre-refactor tree reproduces HEAD's failing 500 ms frame byte for byte. The pre-refactor tree and HEAD render identically on macOS 27. Only the OS changed.
- Every large delta sits on the glyphs of the three text lines (max 61 at 500 ms, 59 at 1500 ms).
- Every differing pixel lies in the 16-px macroblock rows that carry that text (y 64–335 of 720). Nothing below them differs: the circles, the cube's lower half and the bar are byte-identical.
- Off the glyphs, inside those rows, the deltas are encoder spill. On the 500 ms I-frame, flat gradient in those rows shifts by up to 3. Right of x 700, nothing differs by more than 3. On the 1500 ms P-frame, the cube's left edge shifts by up to 11 inside those rows (392 pixels), because that frame is predicted from the changed I-frame. The intra-coded 500 ms frame shows no such shift on the cube, so the cube's own rasterization did not change.

### Why the 2026-09-23 baselines replaced the first ones

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

## No 3D text in the fixture — 3D text is NOT covered

The three overlay is a cube plus a bar mesh; it does **not** use `new Text()`. An earlier version put a "Parity" label under the cube and the baseline was flaky: roughly one run in three differed by exactly 836 channels (max delta 12) inside a 40×34 box on the label's glyphs and was byte-identical everywhere else — two stable outcomes rather than noise, i.e. a latching race in the canvas-text rasterization / content-fit framing, not encoder jitter. It reproduced on the pristine tree with no source change, so it belongs to the 3D text path, not to this spec.

`Text` is one of the injected `THREE_PARAM_NAMES`, so the refactor must keep injecting it — **and this spec no longer proves that.** Cover it with a non-pixel assertion elsewhere, and do not add the label back before the underlying race is fixed.

## Capture environment

The baselines are specific to this machine. A different Chromium revision, ffmpeg build, or GPU/rasterizer can legitimately shift them, so re-measure before treating them as a CI gate.

- Chromium: Playwright revision **1217** (Chromium 147.0.7727.15, `channel: "chromium"`, full build; Playwright 1.59.1 in both the capture tree and HEAD), launched GPU-first with a SwiftShader fallback
- ffmpeg: **9.0.2** (martin-riedl.de build, the one libi's Category A install puts in `<LIBI_HOME>/bin`), re-read on 2026-09-24 from both capture homes and the HEAD compare homes. An earlier version of this README said **8.1.2**. That was wrong: every e2e home created around the first capture (02:06–03:03 on 2026-09-23) holds 9.0.2, as does every home used since.
- Render mode: GPU (`ANGLE Metal Renderer: Apple M5 Pro`), hardware H.264 encode (`hwEncode: true`), as logged in `export.render_gpu_mode`. On macOS that encoder is the OS's own, so an OS upgrade can move these files even with no code or ffmpeg change.
- Platform: **macOS 27.0 (26A428), arm64**. The 2026-09-23 baselines were captured on macOS 26.6.2, and the upgrade to 27.0 changed text rasterization enough to fail the spec. After an OS upgrade, recapture from the pre-refactor tree as described in [Provenance](#provenance).

## Regenerating

Regenerate only for a deliberate rendering change or a deliberate change to the capture path, and say why in the commit. After a capture-path change, regenerate from the **pre-refactor** renderer with the new capture applied, as described in [Provenance](#provenance). Capturing from HEAD would make the spec compare the refactor against itself.

```bash
LIBI_GOLDEN_UPDATE=1 npm run test:e2e -- e2e/overlay-sandbox-golden.spec.ts
```

Update mode self-checks what it captures (distinct colours + share of non-gradient pixels) and refuses to write a frame where the fixture did not actually paint — the first capture of these baselines silently drew almost nothing, and only a human opening the PNG noticed.
