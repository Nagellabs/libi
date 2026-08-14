import { describe, it, expect, vi, beforeEach } from "vitest";
import { __resetDriverForTests } from "@/lib/export/drivers";

describe("driver shutdown integration", () => {
  beforeEach(() => {
    __resetDriverForTests();
    vi.resetModules();
  });

  it("shutdown() on the playwright driver is safe with no cached browser", async () => {
    // Pre-set browserPromise with a fake in case lazy init ever happens; the
    // main contract we verify is that shutdown() resolves cleanly when no
    // browser has been launched (which is the common server-exit case when
    // no canvas export ever ran).
    const fakeClose = vi.fn().mockResolvedValue(undefined);
    vi.doMock("playwright-core", () => ({
      chromium: {
        launch: vi.fn().mockResolvedValue({ close: fakeClose, newPage: vi.fn() }),
      },
    }));
    const { playwrightDriver } = await import("@/lib/export/drivers/playwright");
    await expect(playwrightDriver.shutdown()).resolves.toBeUndefined();
  });

  it("shutdown() on the electron driver is a no-op", async () => {
    const { electronDriver } = await import("@/lib/export/drivers/electron");
    await expect(electronDriver.shutdown()).resolves.toBeUndefined();
  });
});
