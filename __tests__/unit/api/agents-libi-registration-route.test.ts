// GET /api/agents/libi-registration — a thin wrapper over
// detectLibiRegistration(). Detection is best-effort: a throw answers 200 with
// every agent "unknown" so the tab renders instead of blanking.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { detect } = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock("@/lib/agents/libi-registration", () => ({ detectLibiRegistration: detect }));

import { GET as route } from "@/app/api/agents/libi-registration/route";

const GET = (query = "") => route(new Request(`http://127.0.0.1:3456/api/agents/libi-registration${query}`));

beforeEach(() => {
  detect.mockReset();
});

describe("GET /api/agents/libi-registration", () => {
  it("answers { agents } straight from the detector, with no injected deps", async () => {
    const agents = { "claude-code": { state: "connected", scope: "user", url: "http://127.0.0.1:3457/mcp" }, codex: { state: "not-connected" } };
    detect.mockResolvedValue(agents);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents });
    expect(detect).toHaveBeenCalledWith();
  });

  it("Retry's ?refresh=1 asks the detector to read codex again", async () => {
    detect.mockResolvedValue({ "claude-code": { state: "not-connected" }, codex: { state: "connected" } });
    await GET("?refresh=1");
    expect(detect).toHaveBeenCalledWith({ refresh: true });
  });

  it("a detector throw → 200 with both agents unknown", async () => {
    detect.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: { "claude-code": { state: "unknown" }, codex: { state: "unknown" } } });
  });
});
