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
