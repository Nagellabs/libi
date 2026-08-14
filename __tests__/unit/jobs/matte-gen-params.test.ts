import { describe, it, expect } from "vitest";
import { matteGenRunner } from "@/lib/jobs/runners/matte-gen";

describe("matte_gen params schema", () => {
  it("declares the JobManager contract", () => {
    expect(matteGenRunner.kind).toBe("matte_gen");
    expect(matteGenRunner.maxConcurrent).toBe(1);
    expect(matteGenRunner.resumable).toBe(false);
  });

  it("parses a canonical params object (deterministic — safe to hash)", () => {
    const parsed = matteGenRunner.paramsSchema.parse({
      fileId: "f1",
      engine: "local",
      subject: { kind: "box", box: [1, 2, 3, 4] },
      range: { start: 0, end: 5 },
    });
    expect(parsed).toEqual({
      fileId: "f1",
      engine: "local",
      subject: { kind: "box", box: [1, 2, 3, 4] },
      range: { start: 0, end: 5 },
    });
  });

  it("accepts auto subject with no box and no range", () => {
    expect(() =>
      matteGenRunner.paramsSchema.parse({
        fileId: "f1",
        engine: "local",
        subject: { kind: "auto" },
      }),
    ).not.toThrow();
  });

  it("rejects unknown engines and malformed boxes", () => {
    expect(() =>
      matteGenRunner.paramsSchema.parse({
        fileId: "f1",
        engine: "fal",
        subject: { kind: "auto" },
      }),
    ).toThrow();
    expect(() =>
      matteGenRunner.paramsSchema.parse({
        fileId: "f1",
        engine: "local",
        subject: { kind: "box", box: [1, 2, 3] },
      }),
    ).toThrow();
  });
});
