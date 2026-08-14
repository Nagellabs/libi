import { describe, it, expect } from "vitest";
import { buildFilmstripArgs } from "@/lib/filmstrip/args";

describe("buildFilmstripArgs", () => {
  it("emits a single-output sprite tile filtergraph", () => {
    const args = buildFilmstripArgs("/in.mp4", "/out.jpg", {
      frames: 20,
      height: 48,
      fps: "20/10",
    });
    // Overwrite + input
    expect(args[0]).toBe("-y");
    const iIdx = args.indexOf("-i");
    expect(iIdx).toBeGreaterThan(-1);
    expect(args[iIdx + 1]).toBe("/in.mp4");

    // The filtergraph: fps sample → scale to height → tile frames x 1.
    const vfIdx = args.indexOf("-vf");
    expect(vfIdx).toBeGreaterThan(-1);
    const vf = args[vfIdx + 1];
    expect(vf).toBe("fps=20/10,scale=-2:48,tile=20x1");

    // Exactly one output frame (the assembled sprite).
    const fIdx = args.indexOf("-frames:v");
    expect(fIdx).toBeGreaterThan(-1);
    expect(args[fIdx + 1]).toBe("1");

    // Output path is last.
    expect(args[args.length - 1]).toBe("/out.jpg");
  });

  it("threads the computed fps string verbatim (runner computes frames/duration)", () => {
    const args = buildFilmstripArgs("/a b.mp4", "/o.jpg", {
      frames: 12,
      height: 60,
      fps: "0.5",
    });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("fps=0.5,");
    expect(vf).toContain("scale=-2:60,");
    expect(vf).toContain("tile=12x1");
  });
});
