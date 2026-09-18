/**
 * Re-review of a46beac8 (MINOR 1): `annotateFrame` built its label as
 * `text='<label with apostrophes stripped>'` — one level of quoting, so a ':'
 * in a label split the drawtext option and the whole grounding annotation
 * failed. The label now goes through the shared filter-escape helpers.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { annotateFilter } from "@/lib/tracking/annotate-frame";
import { hasFfmpeg, hasDrawtext, FFMPEG_SKIP_REASON, DRAWTEXT_SKIP_REASON } from "@/__tests__/helpers/media";

const run = promisify(execFile);
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
else if (!hasDrawtext()) console.info(`[skip] annotate labels — ${DRAWTEXT_SKIP_REASON}`);
const describeIf = hasFfmpeg() && hasDrawtext() ? describe : describe.skip;

describe("annotateFilter", () => {
  it("quotes the label for both filter parsers", () => {
    const f = annotateFilter([{ x: 1, y: 30, w: 10, h: 10, label: "car: it's 90%" }], true);
    expect(f).toContain("drawtext=text='car\\: it\\'\\''s 90\\\\%'");
  });
  it("draws no text when drawtext is unavailable", () => {
    expect(annotateFilter([{ x: 1, y: 30, w: 10, h: 10, label: "a" }], false)).not.toContain("drawtext");
  });
});

describeIf("annotateFilter through real ffmpeg", () => {
  it.each(["car: 0.91", "person's face", "a,b;[c] 50%"])("label %j renders (exit 0)", async (label) => {
    const vf = annotateFilter([{ x: 10, y: 40, w: 50, h: 30, label }], true);
    await expect(
      run(resolveFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=gray:s=200x100",
        "-frames:v", "1", "-vf", vf, "-f", "null", "-"], { timeout: 20_000 }),
    ).resolves.toBeDefined();
  });
});
