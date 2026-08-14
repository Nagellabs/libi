import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod/v3";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
  getRunner,
  listRunners,
} from "@/lib/jobs/runners/registry";

const fakeRunner = {
  kind: "test-kind",
  maxConcurrent: 2,
  paramsSchema: z.object({ x: z.number() }),
  resumable: false,
  run: async () => ({ ok: true }),
};

describe("runner registry", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
  });

  it("registers and retrieves runners by kind", () => {
    registerRunner(fakeRunner);
    expect(getRunner("test-kind")).toBe(fakeRunner);
  });

  it("rejects duplicate kinds", () => {
    registerRunner(fakeRunner);
    expect(() => registerRunner(fakeRunner)).toThrow(/already registered/i);
  });

  it("returns null for unknown kinds", () => {
    expect(getRunner("does-not-exist")).toBeNull();
  });

  it("listRunners returns all registered", () => {
    registerRunner(fakeRunner);
    registerRunner({ ...fakeRunner, kind: "another" });
    expect(listRunners().map((r) => r.kind).sort()).toEqual(["another", "test-kind"]);
  });
});
