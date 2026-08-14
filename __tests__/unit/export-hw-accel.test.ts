import { describe, it, expect } from "vitest";
import {
  pickEncoder,
  parseAvailableEncoders,
  buildEncoderProbeArgs,
  HW_ENCODER_CANDIDATES,
} from "@/lib/export/hw-accel";

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

describe("hardware-encoder usability probe", () => {
  // Every hardware encoder pickEncoder can prefer must be in the probe list —
  // a hardware name that is preferred but never probed reintroduces the
  // GPU-less-Linux failure (h264_nvenc listed by apt ffmpeg, unusable without
  // libcuda) that broke every ffmpeg-overlay export on such machines.
  it("probes every hardware encoder pickEncoder can prefer", () => {
    for (const target of ["h264", "hevc"] as const) {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        // With every candidate available, whatever wins that isn't a lib*
        // software encoder must be a probed candidate.
        const all = new Set([...HW_ENCODER_CANDIDATES, "libx264", "libx265"]);
        const winner = pickEncoder(target, all, platform);
        if (winner && !winner.startsWith("lib")) {
          expect(HW_ENCODER_CANDIDATES).toContain(winner);
        }
      }
    }
  });

  it("probe encodes one tiny synthetic frame to the null muxer with the candidate encoder", () => {
    const args = buildEncoderProbeArgs("h264_nvenc");
    expect(args).toContain("h264_nvenc");
    expect(args.join(" ")).toContain("-frames:v 1");
    expect(args.join(" ")).toContain("-f null");
    // lavfi source, so the probe needs no input media on disk.
    expect(args.join(" ")).toContain("-f lavfi");
  });
});
