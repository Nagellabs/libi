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

describe("the handler pair puts itself back (SES-3)", () => {
  // The once-per-process guard used to be a sticky flag: once set, no later evaluation registered
  // anything, so a pair something removed (a test's afterEach, a library calling
  // removeAllListeners) stayed gone for the life of the process. Each evaluation now checks that
  // its two handlers are still attached and re-adds whichever is missing — still once.
  it("an evaluation after the pair was removed registers it again, exactly once", async () => {
    await import("@/lib/logger");
    const hooks = (globalThis as unknown as {
      __libiLoggerProcessHooks?: { onUncaughtException?: (...a: unknown[]) => void; onUnhandledRejection?: (...a: unknown[]) => void };
    }).__libiLoggerProcessHooks;
    const onUncaught = hooks?.onUncaughtException;
    const onRejection = hooks?.onUnhandledRejection;
    expect(typeof onUncaught).toBe("function");
    expect(typeof onRejection).toBe("function");
    expect(process.listeners("uncaughtException")).toContain(onUncaught);
    expect(process.listeners("unhandledRejection")).toContain(onRejection);

    process.off("uncaughtException", onUncaught as never);
    process.off("unhandledRejection", onRejection as never);
    const uncaught = process.listenerCount("uncaughtException");
    const rejection = process.listenerCount("unhandledRejection");

    vi.resetModules();
    await import("@/lib/logger");
    vi.resetModules();
    await import("@/lib/logger");

    expect(process.listeners("uncaughtException").filter((l) => l === onUncaught)).toHaveLength(1);
    expect(process.listeners("unhandledRejection").filter((l) => l === onRejection)).toHaveLength(1);
    expect(process.listenerCount("uncaughtException")).toBe(uncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(rejection + 1);
  });
});
