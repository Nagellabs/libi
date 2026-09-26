// __tests__/unit/storyboard/render/lock-runtime.test.ts
//
// What an agent-authored storyboard body can reach once the render worker is
// locked (lib/storyboard/render/lock-runtime.ts). The lock replaces the global
// `process`, so it runs in its own node child (fixtures/lock-probe.ts), never
// in the vitest worker; the child reports what global-scope code — built at
// runtime, the way a body would step around the validator's text filter — can
// still see.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { MODULE_LOADING_CLOSED, lockWorkerRuntime } from "@/lib/storyboard/render/lock-runtime";

const PROBE = path.join(__dirname, "fixtures", "lock-probe.ts");

function runProbe(): Record<string, unknown> {
  const r = spawnSync(process.execPath, ["--import", "tsx", PROBE], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

describe("lockWorkerRuntime", () => {
  it("leaves a body a data-only process and no module loader", () => {
    const report = runProbe();
    expect(report.processKeys).toBe("arch,env,platform,version,versions");
    expect(report.binding).toBe("undefined");
    expect(report.getBuiltinModule).toBe("undefined");
    expect(report.dlopen).toBe("undefined");
    expect(report.stdout).toBe("undefined");
    expect(report.viaFunctionCtor).toBe("undefined");
    expect(report.requireGlobal).toBe("undefined");
    expect(report.moduleGlobal).toBe("undefined");
    expect(report.redefine).toBe("refused");
    expect(report.envKeys).toBe(0);
    // A runtime-built import() of even a harmless builtin is refused.
    expect(report.dynamicImport).toContain(MODULE_LOADING_CLOSED);
  }, 30_000);

  it("refuses to lock (so the worker refuses to render) where the loader cannot be locked", () => {
    // Throws before touching anything, so this vitest worker keeps its process.
    expect(() => lockWorkerRuntime(null)).toThrow(/cannot lock its module loader/);
    expect(typeof (process as unknown as { binding?: unknown }).binding).toBe("function");
  });
});
