import { describe, it, expect, vi, beforeEach } from "vitest";

type StoredArgs = { contentType: string; filename: string };
const storeFileMock = vi.fn(async (a: StoredArgs) => ({ id: "f1", contentType: a.contentType, filename: a.filename }));
vi.mock("@/mcp/tools/file-tools", () => ({ storeFile: (a: StoredArgs) => storeFileMock(a) }));
const runFfmpegMock = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: (...a: unknown[]) => runFfmpegMock(...a),
  resolveFfmpegPath: () => "ffmpeg",
}));
// Avoid shelling out to a real ffmpeg for the drawtext-capability probe.
vi.mock("node:child_process", () => ({ spawnSync: () => ({ stdout: "drawtext" }) }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return { ...real, readFile: vi.fn(async () => Buffer.from("x")), unlink: vi.fn(async () => {}) };
});

import { makePlaceholder } from "@/mcp/dev/fake-fal/placeholders";

beforeEach(() => { storeFileMock.mockClear(); runFfmpegMock.mockClear(); });

describe("makePlaceholder", () => {
  it("image kind stores an image/jpeg", async () => {
    const f = await makePlaceholder("image", { prompt: "a cat", pieceId: "p1" });
    expect(storeFileMock.mock.calls[0][0].contentType).toBe("image/jpeg");
    expect(f.id).toBe("f1");
  });
  it("video kind stores a video/mp4", async () => {
    await makePlaceholder("video", { prompt: "a clip", pieceId: "p1", durationSeconds: 15 });
    expect(storeFileMock.mock.calls[0][0].contentType).toBe("video/mp4");
  });
  it("video placeholder carries a sine audio stream so extract_audio / @Audio1 carry works", async () => {
    await makePlaceholder("video", { prompt: "a clip", pieceId: "p1", durationSeconds: 4 });
    const args = runFfmpegMock.mock.calls.at(-1)![0] as unknown as string[];
    const joined = args.join(" ");
    // Without an audio stream, hasAudio=false and libi.extract_audio fails
    // ("Output file does not contain any stream") — the voice-carry path can't run.
    expect(joined).toContain("sine=frequency=");
    expect(args).toContain("-c:a");
    expect(joined).toContain("aac");
    expect(args).toContain("-shortest");
  });
  it("audio kind stores an audio/wav", async () => {
    await makePlaceholder("audio", { prompt: "vo", pieceId: "p1" });
    expect(storeFileMock.mock.calls[0][0].contentType).toBe("audio/wav");
  });
});
