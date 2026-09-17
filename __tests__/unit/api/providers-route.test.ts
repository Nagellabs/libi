// GET /api/providers — what the user's agents already have. The route never
// writes an agent's config; its one write is the reverse of one: a provider
// the user has reconnected in their OWN config is a provider whose rescued
// legacy key libi has no business still holding, so seeing it drops the key.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { detect, detected, clearLegacy } = vi.hoisted(() => {
  const detected = [
    { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" },
    { agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected" },
  ];
  return {
    detect: vi.fn(async (): Promise<{ connected: Array<Record<string, unknown>>; codex?: "stale" | "unread" }> => ({ connected: detected })),
    detected,
    clearLegacy: vi.fn(),
  };
});
vi.mock("@/lib/providers/legacy", () => ({ clearLegacyKeysForConnected: clearLegacy }));
vi.mock("@/lib/providers/detect", () => ({ detectProviders: detect }));

import { GET } from "@/app/api/providers/route";

const listProvidersRoute = (query = "") => GET(new Request(`http://127.0.0.1:3456/api/providers${query}`));

beforeEach(() => {
  detect.mockClear();
  detect.mockImplementation(async () => ({ connected: detected }));
  clearLegacy.mockClear();
});

describe("GET /api/providers", () => {
  it("hands the detected list to the legacy-key cleanup, and answers with it", async () => {
    const res = await listProvidersRoute();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connected: unknown[] }).connected).toEqual(detected);
    expect(clearLegacy).toHaveBeenCalledWith(detected);
  });

  it("a plain read asks detection with nothing injected; Retry's ?refresh=1 asks it to read codex again", async () => {
    await listProvidersRoute();
    expect(detect).toHaveBeenLastCalledWith();
    await listProvidersRoute("?refresh=1");
    expect(detect).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("says when Codex's rows are its last good listing, and hands only rows read just now to the legacy-key cleanup", async () => {
    const staleCodexRow = { agent: "codex", name: "fal", providerId: "fal", transport: "http", status: "connected", stale: true };
    detect.mockImplementationOnce(async () => ({ connected: [detected[0], staleCodexRow], codex: "stale" }));
    const res = await listProvidersRoute();
    expect(await res.json()).toEqual({ connected: [detected[0], staleCodexRow], codex: "stale" });
    expect(clearLegacy).toHaveBeenCalledWith([detected[0]]);
  });

  it("passes an unread Codex listing through, so the tab never reads it as no entries", async () => {
    detect.mockImplementationOnce(async () => ({ connected: [detected[0]], codex: "unread" }));
    const res = await listProvidersRoute();
    expect(await res.json()).toEqual({ connected: [detected[0]], codex: "unread" });
  });

  it("still degrades to an empty list when detection throws, and clears nothing", async () => {
    detect.mockRejectedValueOnce(new Error("codex exploded"));
    const res = await listProvidersRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: [], error: "detection failed" });
    expect(clearLegacy).not.toHaveBeenCalled();
  });
});
