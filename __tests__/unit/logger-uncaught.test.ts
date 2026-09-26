import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("uncaughtException handler", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Spy on process.exit; throw if called so the test fails loudly.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) was called`);
    }) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("does NOT call process.exit on uncaughtException", async () => {
    // Ensure logger is loaded (registers handlers).
    await import("@/lib/logger");

    // Re-emit an uncaughtException — handler should run but NOT exit.
    expect(() => {
      process.emit("uncaughtException" as never, new Error("test ex"));
    }).not.toThrow();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does NOT call process.exit on unhandledRejection", async () => {
    await import("@/lib/logger");
    expect(() => {
      process.emit("unhandledRejection" as never, new Error("test rej"), Promise.reject().catch(() => {}));
    }).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("process-level handlers register once per process", () => {
  // The dev server re-evaluates lib/logger.ts on every recompile of a route
  // that imports it. A module-scope `process.on(...)` then added one more
  // listener each time: server.log showed MaxListenersExceededWarning (11
  // uncaughtException listeners), and one exception logged up to 11 duplicate
  // "Uncaught exception (continuing)" fatals (QA 2026-09-25, bug 5).
  it("re-evaluating the module does not add another uncaughtException or unhandledRejection listener", async () => {
    await import("@/lib/logger");
    const uncaught = process.listenerCount("uncaughtException");
    const rejection = process.listenerCount("unhandledRejection");

    for (let i = 0; i < 3; i++) {
      vi.resetModules();
      await import("@/lib/logger");
    }

    expect(process.listenerCount("uncaughtException")).toBe(uncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(rejection);
  });
});
