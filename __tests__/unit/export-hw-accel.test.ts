import { describe, it, expect } from "vitest";
import { pickEncoder, parseAvailableEncoders } from "@/lib/export/hw-accel";

describe("parseAvailableEncoders", () => {
  it("extracts encoder names from ffmpeg -encoders output", () => {
    const out = `
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 VFS..D h264_videotoolbox    H.264 (VideoToolbox)
 V..X.D h264_nvenc           NVIDIA NVENC H.264 encoder
 ------
 A..... aac                  AAC (Advanced Audio Coding)
`;
    const names = parseAvailableEncoders(out);
    expect(names).toContain("libx264");
    expect(names).toContain("h264_videotoolbox");
    expect(names).toContain("h264_nvenc");
  });
});

describe("pickEncoder", () => {
  it("prefers VideoToolbox on darwin when available", () => {
    const enc = pickEncoder("h264", new Set(["libx264", "h264_videotoolbox"]), "darwin");
    expect(enc).toBe("h264_videotoolbox");
  });

  it("prefers NVENC on linux/win32 when available", () => {
    expect(pickEncoder("h264", new Set(["libx264", "h264_nvenc"]), "linux")).toBe("h264_nvenc");
    expect(pickEncoder("h264", new Set(["libx264", "h264_nvenc"]), "win32")).toBe("h264_nvenc");
  });

  it("falls back to libx264 when no hw encoder present", () => {
    expect(pickEncoder("h264", new Set(["libx264"]), "darwin")).toBe("libx264");
  });

  it("returns null when even libx264 is missing", () => {
    expect(pickEncoder("h264", new Set(), "darwin")).toBe(null);
  });
});
