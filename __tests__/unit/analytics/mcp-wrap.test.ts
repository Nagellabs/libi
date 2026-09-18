import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentPort: number | null = 3456;
vi.mock("@/lib/libi-home", () => ({
  getCurrentPort: () => {
    if (currentPort === null) throw new Error("no port file");
    return currentPort;
  },
}));

import { trackCliSessionOpened, trackMcpMilestone, wrapRegisterToolWithTracking } from "@/mcp/analytics";

describe("MCP-side transport — the CLI session and milestone events", () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
  beforeEach(() => {
    currentPort = 3456;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const posted = () =>
    fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) as unknown }));

  it("a cli-surface session opens as mcp_cli_session_opened { dialect } on the event route", () => {
    trackCliSessionOpened("cli", "codex");
    expect(posted()).toEqual([
      { url: "http://127.0.0.1:3456/api/analytics/event", body: { name: "mcp_cli_session_opened", params: { dialect: "codex" } } },
    ]);
  });

  it("an in-app session reports nothing — the chat's own events already count it", () => {
    trackCliSessionOpened("in-app", "claude");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a milestone goes to the mark-once route with its name and event, never the event route", () => {
    trackMcpMilestone("first_piece", "first_piece_created");
    expect(posted()).toEqual([
      { url: "http://127.0.0.1:3456/api/analytics/milestone", body: { name: "first_piece", event: "first_piece_created" } },
    ]);
  });

  it("neither throws when the studio's port is unknown or the POST fails", async () => {
    currentPort = null;
    expect(() => trackCliSessionOpened("cli", "claude")).not.toThrow();
    expect(() => trackMcpMilestone("first_piece", "first_piece_created")).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    currentPort = 3456;
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(() => trackMcpMilestone("first_piece", "first_piece_created")).not.toThrow();
    await Promise.resolve();
  });
});

describe("wrapRegisterToolWithTracking", () => {
  it("fires the tracker with the tool name and still calls the handler", async () => {
    const tracker = vi.fn();
    const handler = vi.fn().mockResolvedValue("ok");
    const calls: unknown[][] = [];
    const fakeRegister = (...args: unknown[]) => { calls.push(args); };

    const wrapped = wrapRegisterToolWithTracking(fakeRegister, tracker);
    wrapped("libi.create_scene", { description: "d" }, handler);

    // The registered handler is the last arg passed to fakeRegister.
    const registeredHandler = calls[0][2] as (...a: unknown[]) => Promise<unknown>;
    const result = await registeredHandler({ pieceId: "p" });

    expect(tracker).toHaveBeenCalledWith("libi.create_scene");
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toBe("ok");
  });

  it("never lets a tracker error break the handler", async () => {
    const tracker = vi.fn(() => { throw new Error("boom"); });
    const handler = vi.fn().mockResolvedValue("ok");
    const calls: unknown[][] = [];
    const reg = (...args: unknown[]) => { calls.push(args); };

    const wrapped = wrapRegisterToolWithTracking(reg, tracker);
    wrapped("libi.x", {}, handler);
    const registeredHandler = calls[0][2] as (...a: unknown[]) => Promise<unknown>;
    await expect(registeredHandler({})).resolves.toBe("ok");
  });
});
