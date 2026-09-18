/**
 * Re-review of a46beac8 (MINOR 4): the fake-fal placeholders stamped the
 * prompt with a one-level-escaped `text='…'`. A prompt with an apostrophe
 * ("a woman's face") ended the quote, the drawtext failed, and so did the
 * placeholder generation — in test mode, which skill-evals run through. The
 * stamp now uses the shared filter-escape helpers; this runs the exact `-vf`
 * the placeholder builds through real ffmpeg.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { hasFfmpeg, hasDrawtext, FFMPEG_SKIP_REASON, DRAWTEXT_SKIP_REASON } from "@/__tests__/helpers/media";

const runFfmpegMock = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/lib/ffmpeg/exec", async (orig) => ({
  ...(await orig<typeof import("@/lib/ffmpeg/exec")>()),
  runFfmpeg: (...a: unknown[]) => runFfmpegMock(...a),
}));
vi.mock("@/mcp/tools/file-tools", () => ({ storeFile: vi.fn(async () => ({ id: "f1" })) }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return { ...real, readFile: vi.fn(async () => Buffer.from("x")), unlink: vi.fn(async () => {}) };
});

const { makePlaceholder } = await import("@/mcp/dev/fake-fal/placeholders");
const { resolveFfmpegPath } = await import("@/lib/ffmpeg/exec");

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
else if (!hasDrawtext()) console.info(`[skip] placeholder stamp — ${DRAWTEXT_SKIP_REASON}`);
const describeIf = hasFfmpeg() && hasDrawtext() ? describe : describe.skip;

beforeEach(() => runFfmpegMock.mockClear());

describeIf("fake-fal placeholder prompt stamp", () => {
  it.each([
    ["image", "a woman's face: close-up, 50% smile"],
    ["video", "it's raining; [dusk], 10:30"],
  ] as const)("%s prompt %j builds a -vf real ffmpeg accepts", async (kind, prompt) => {
    await makePlaceholder(kind, { prompt, pieceId: "p1", durationSeconds: 1 });
    const args = runFfmpegMock.mock.calls.at(-1)![0] as string[];
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("drawtext=");
    expect(() =>
      execFileSync(resolveFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
        "-i", "color=c=#3b82f6:s=640x360", "-frames:v", "1", "-vf", vf, "-f", "null", "-"], { timeout: 20_000 }),
    ).not.toThrow();
  });
});
