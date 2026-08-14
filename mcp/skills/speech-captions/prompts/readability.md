# Readability defaults

**Text overlays render on ONE line and do NOT wrap.** `add_overlay (kind "text")` draws a
single `fillText`; `rect.width` only sets the anchor point (center/left/right) — it
never wraps or clips. An over-long string spills off **both** canvas edges. The same
is true of the ffmpeg export (`drawtext` doesn't wrap either), so keeping each line
within the canvas width is also what keeps preview == export. The binding constraint
is therefore the **rendered line width vs the canvas width**, NOT a flat character count.

## Fit the canvas width (HARD)

1. **Read the real canvas size first** — `libi.get_composition` → `width`, `height`.
   Never assume 1080p. UGC is vertical 9:16 (e.g. 464×832 preview, 1080×1920 export)
   where **width is the tight dimension**.
2. **Budget characters against width × font size.** A heavy/bold sans glyph advances
   ≈ `0.6 × fontSizePx`. Leaving ~8% safe margin each side:
   ```
   maxCharsPerLine ≈ floor(0.84 × canvasWidth / (0.6 × fontSizePx))
   ```
   Worked for vertical UGC (the px sizes scale with height, so the char budget is the
   same at 464-wide preview and 1080-wide export):
   - 44px → ~14 chars · 38px → ~17 chars · 32px → ~20 chars · 28px → ~23 chars.
3. **If a line is over budget, do ONE of:** shrink the font, OR split into ≤2 stacked
   lines — a second `add_overlay (kind "text")` at a lower `y` (line height ≈ `1.2 × fontSizePx`),
   each line within the budget. NEVER let a single line exceed the budget.
4. **Verify after adding (do not trust the write).** For every text overlay, estimate
   `renderedWidth ≈ chars × 0.6 × fontSizePx` and confirm `renderedWidth ≤ 0.84 × canvasWidth`.
   If a preview is available, eyeball that no text touches the side edges. A 20-char line
   at 44px on a 464-wide canvas (≈530px) is the bug that shipped overflowing captions.

## Other defaults

- **Chunking (speech cues):** ≤ ~6 words per cue; break on clause boundaries, not
  mid-word. The width budget above caps the characters — a long cue becomes 2 stacked
  lines, never one overflowing line.
- **Position:** bottom-safe — baseline around 80–88% of height; never in the bottom 6%
  (UI/safe-area). Center-aligned by default.
- **Contrast:** ALWAYS a stroke outline (`lineWidth ~8`, dark `strokeText` under a
  white `fillText`) OR a semi-opaque plate behind the text. Captions must read over
  both bright and dark footage.
- **Font:** heavy weight. A comfortable full-width line is ≈ `canvasWidth / 13`; go
  smaller when the line is long. Scale with composition size.
- **Karaoke (optional):** when requested, highlight the active word in a warm accent
  (e.g. `#ffd400`) computed from the cue's local time fraction.
- **No especially long holds:** a cue should clear when its speech ends so the next cue
  reads cleanly.
