// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { getShellPlatform, revealLabel, revealFileById, revealFile } from "@/lib/shell/client";
import { EVENT_NAMES } from "@/lib/analytics/events";

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("revealLabel", () => {
  it("uses the native wording for each platform", () => {
    expect(revealLabel("darwin")).toBe("Reveal in Finder");
    expect(revealLabel("win32")).toBe("Show in File Explorer");
    expect(revealLabel("linux")).toBe("Open containing folder");
  });
});

describe("getShellPlatform", () => {
  it("prefers the Electron bridge's platform", () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: "win32",
    };
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(getShellPlatform()).toBe("win32");
  });

  it("falls back to the user agent when there is no bridge", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(getShellPlatform()).toBe("win32");
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(getShellPlatform()).toBe("darwin");
  });

  it("treats an unrecognised platform as linux", () => {
    setUserAgent("Mozilla/5.0 (X11; Ubuntu; Linux x86_64)");
    expect(getShellPlatform()).toBe("linux");
    setUserAgent("something else entirely");
    expect(getShellPlatform()).toBe("linux");
  });
});

describe("revealFileById", () => {
  it("reveals the path the location route returns", async () => {
    const electronReveal = vi.fn(async () => {});
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      revealFile: electronReveal,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ path: "/tmp/libi/p1/clip.mp4", exists: true }),
      })),
    );

    await revealFileById("f1");

    expect(fetch).toHaveBeenCalledWith("/api/files/by-id/f1/location");
    expect(electronReveal).toHaveBeenCalledWith("/tmp/libi/p1/clip.mp4");
  });

  it("does nothing when the file row is gone", async () => {
    const electronReveal = vi.fn(async () => {});
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      revealFile: electronReveal,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    await revealFileById("gone");

    expect(electronReveal).not.toHaveBeenCalled();
  });

  it("does nothing when the response carries no path", async () => {
    const electronReveal = vi.fn(async () => {});
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      revealFile: electronReveal,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    );

    await revealFileById("weird");

    expect(electronReveal).not.toHaveBeenCalled();
  });
});

describe("analytics", () => {
  it("registers asset_revealed as a known event name", () => {
    expect(EVENT_NAMES).toContain("asset_revealed");
  });
});

describe("revealFile", () => {
  it("is still exported and unchanged in shape", () => {
    expect(typeof revealFile).toBe("function");
  });
});
