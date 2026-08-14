import { describe, it, expect } from "vitest";
import { resolveChunkWorkers } from "@/lib/export/chunk-plan";

describe("resolveChunkWorkers", () => {
  it("explicit env integer wins even in GPU mode (forces chunking)", () => {
    expect(resolveChunkWorkers("4", "gpu", 8)).toBe(4);
    expect(resolveChunkWorkers("3", "gpu", 8)).toBe(3);
    // The env override wins regardless of cpuCount.
    expect(resolveChunkWorkers("8", "gpu", 2)).toBe(8);
  });

  it("env unset + GPU mode → single page (1)", () => {
    expect(resolveChunkWorkers(undefined, "gpu", 12)).toBe(1);
    expect(resolveChunkWorkers("", "gpu", 12)).toBe(1);
  });

  it("env unset + software mode scales with cpuCount, capped at 4", () => {
    expect(resolveChunkWorkers(undefined, "software", 12)).toBe(4);
    expect(resolveChunkWorkers(undefined, "software", 4)).toBe(2);
    // Floor at 1 (never zero/negative).
    expect(resolveChunkWorkers(undefined, "software", 1)).toBe(1);
  });

  it("env <= 1 disables chunking in BOTH directions", () => {
    expect(resolveChunkWorkers("1", "software", 12)).toBe(1);
    expect(resolveChunkWorkers("0", "software", 12)).toBe(1);
    expect(resolveChunkWorkers("1", "gpu", 12)).toBe(1);
  });

  it("non-numeric env is ignored → falls through to the mode default", () => {
    expect(resolveChunkWorkers("abc", "software", 12)).toBe(4);
    expect(resolveChunkWorkers("abc", "gpu", 12)).toBe(1);
  });

  it("undefined mode is treated as GPU (single page)", () => {
    expect(resolveChunkWorkers(undefined, undefined, 12)).toBe(1);
    // ...but an explicit env still forces chunking with an unknown mode.
    expect(resolveChunkWorkers("3", undefined, 12)).toBe(3);
  });
});
