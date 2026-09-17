// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { pickFolder } from "@/lib/shell/client";

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.unstubAllGlobals();
});

describe("pickFolder (client)", () => {
  it("uses the Electron bridge when present: a path is picked, null is cancelled, no fetch", async () => {
    const pickDirectory = vi.fn(async (p?: string) => (p === "/start" ? "/chosen" : null));
    (window as unknown as { electronAPI: unknown }).electronAPI = { pickDirectory };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(pickFolder("/start")).resolves.toEqual({ status: "picked", path: "/chosen" });
    await expect(pickFolder()).resolves.toEqual({ status: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("a bridge that rejects or throws is unavailable with its reason, never a throw, and never falls back to the route", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      pickDirectory: vi.fn(async () => {
        throw new Error("dialog crashed");
      }),
    };
    await expect(pickFolder("/start")).resolves.toEqual({ status: "unavailable", reason: "dialog crashed" });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      pickDirectory: () => {
        throw "ipc gone";
      },
    };
    await expect(pickFolder()).resolves.toEqual({ status: "unavailable", reason: "ipc gone" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("posts to the route without a bridge and relays its answer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "picked", path: "/p" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(pickFolder("/start")).resolves.toEqual({ status: "picked", path: "/p" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/system/pick-folder");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ initialPath: "/start" });
  });
  it("409 is busy; another failure or a network error is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "busy" }), { status: 409 })));
    await expect(pickFolder()).resolves.toEqual({ status: "busy" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(pickFolder()).resolves.toEqual({ status: "unavailable", reason: "HTTP 500" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(pickFolder()).resolves.toEqual({ status: "unavailable", reason: "Failed to fetch" });
  });
});
