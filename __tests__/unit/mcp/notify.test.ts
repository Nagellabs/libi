import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock getCurrentPort so we can control the return value without touching the filesystem
vi.mock("@/lib/libi-home", () => ({
  getCurrentPort: vi.fn(() => {
    throw new Error("no port file");
  }),
}));

describe("mcp/notify", () => {
  let notify: typeof import("@/mcp/notify").notify;
  let getCurrentPortMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const libiHome = await import("@/lib/libi-home");
    getCurrentPortMock = libiHome.getCurrentPort as ReturnType<typeof vi.fn>;

    const mod = await import("@/mcp/notify");
    notify = mod.notify;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("navigate() does not throw when server is not running", () => {
    getCurrentPortMock.mockImplementation(() => {
      throw new Error("no port file");
    });

    expect(() =>
      notify.navigate({ target: "piece", pieceId: "p1" })
    ).not.toThrow();
  });

  it("refreshQuery() does not throw when server is not running", () => {
    getCurrentPortMock.mockImplementation(() => {
      throw new Error("no port file");
    });

    expect(() =>
      notify.refreshQuery({ queryKey: "pieces" })
    ).not.toThrow();
  });

  it("navigate() does not throw when fetch fails (server unreachable)", async () => {
    getCurrentPortMock.mockReturnValue(19999);

    // global fetch will fail because nothing is listening on port 19999
    expect(() =>
      notify.navigate({ target: "piece", pieceId: "p1" })
    ).not.toThrow();

    // Give the fire-and-forget fetch time to settle
    await new Promise((r) => setTimeout(r, 100));
  });

  it("navigate({ target: 'preview' }) posts the preview navigation payload", async () => {
    getCurrentPortMock.mockReturnValue(19999);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetchMock);

    notify.navigate({ target: "preview", pieceId: "p1" });

    // Give the fire-and-forget fetch time to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:19999/api/notify");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      type: "navigate",
      target: "preview",
      pieceId: "p1",
    });
  });

  it("navigateAgents({ tab, extensionId }) posts type navigate_agents and resolves true on 2xx", async () => {
    getCurrentPortMock.mockReturnValue(19999);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(notify.navigateAgents({ tab: "libi-mcp", extensionId: "whisper" })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:19999/api/notify");
    expect(JSON.parse(init?.body as string)).toEqual({
      type: "navigate_agents",
      tab: "libi-mcp",
      extensionId: "whisper",
    });
  });

  it("navigateAgents resolves false when the studio is unreachable, answers non-2xx, or has no port", async () => {
    getCurrentPortMock.mockReturnValue(19999);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(notify.navigateAgents({ tab: "agents" })).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 400 })));
    await expect(notify.navigateAgents({ tab: "agents" })).resolves.toBe(false);

    getCurrentPortMock.mockImplementation(() => {
      throw new Error("no port file");
    });
    await expect(notify.navigateAgents({ tab: "agents" })).resolves.toBe(false);
  });

  it("studioBaseUrl() is the 127.0.0.1 base, never localhost, and null without a port", async () => {
    const { studioBaseUrl } = await import("@/mcp/notify");
    getCurrentPortMock.mockReturnValue(3461);
    expect(studioBaseUrl()).toBe("http://127.0.0.1:3461");
    getCurrentPortMock.mockImplementation(() => {
      throw new Error("no port file");
    });
    expect(studioBaseUrl()).toBeNull();
  });

  it("refreshQuery({ queryKey: 'composition', pieceId }) posts the refresh_query payload", async () => {
    getCurrentPortMock.mockReturnValue(19999);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetchMock);

    notify.refreshQuery({ queryKey: "composition", pieceId: "p1" });

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:19999/api/notify");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      type: "refresh_query",
      queryKey: "composition",
      pieceId: "p1",
    });
  });

});
