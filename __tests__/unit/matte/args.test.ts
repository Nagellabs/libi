import { describe, it, expect } from "vitest";
import { buildMatteComposeArgs, cutoutFilename } from "@/lib/matte/args";

describe("buildMatteComposeArgs", () => {
  const args = buildMatteComposeArgs("/src/in.mp4", "/tmp/alpha", "/tmp/out.webm", {
    range: { start: 1.5, end: 4.5 },
    framerate: 29.97,
    frameCount: 90,
  });

  it("encodes VP9 with a real alpha plane", () => {
    expect(args).toContain("libvpx-vp9");
    const pf = args[args.indexOf("-pix_fmt") + 1];
    expect(pf).toBe("yuva420p");
    // libvpx drops the alpha plane unless auto-alt-ref is off.
    expect(args[args.indexOf("-auto-alt-ref") + 1]).toBe("0");
  });

  it("alphamerges the PNG sequence over the trimmed source", () => {
    const joined = args.join(" ");
    expect(joined).toContain("-ss 1.5 -to 4.5 -i /src/in.mp4");
    expect(joined).toContain("-framerate 29.97 -start_number 0 -i /tmp/alpha/f%06d.png");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toBe("[0:v]fps=29.97,format=rgba[rgb];[1:v]format=gray[a];[rgb][a]alphamerge[out]");
    expect(args[args.indexOf("-map") + 1]).toBe("[out]");
  });

  it("clamps output to the alpha frame count and strips audio", () => {
    expect(args[args.indexOf("-frames:v") + 1]).toBe("90");
    expect(args).toContain("-an");
    expect(args[args.length - 1]).toBe("/tmp/out.webm");
  });
});

describe("cutoutFilename", () => {
  it("maps <base>.<ext> to <base>-cutout.webm", () => {
    expect(cutoutFilename("clip.mp4")).toBe("clip-cutout.webm");
    expect(cutoutFilename("a.b.mov")).toBe("a.b-cutout.webm");
    expect(cutoutFilename("noext")).toBe("noext-cutout.webm");
  });
});
