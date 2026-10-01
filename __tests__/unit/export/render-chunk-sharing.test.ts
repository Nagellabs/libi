import { describe, it, expect } from "vitest";
import { resolveChunkWorkers } from "@/lib/export/chunk-plan";

describe("resolveChunkWorkers — shared between concurrent renders", () => {
  it("held = 0 keeps today's answers", () => {
    expect(resolveChunkWorkers(undefined, "software", 8)).toBe(4);
    expect(resolveChunkWorkers(undefined, "gpu", 8)).toBe(1);
    expect(resolveChunkWorkers(undefined, "software", 2)).toBe(1);
  });
  it("subtracts the workers other renders hold: min(normal, cores − 2 − held), at least 1", () => {
    expect(resolveChunkWorkers(undefined, "software", 8, 4)).toBe(2);
    expect(resolveChunkWorkers(undefined, "software", 8, 6)).toBe(1);
    expect(resolveChunkWorkers(undefined, "software", 16, 4)).toBe(4);
  });
  it("an explicit LIBI_RENDER_CHUNK_WORKERS still wins", () => {
    expect(resolveChunkWorkers("3", "software", 8, 6)).toBe(3);
  });
});
