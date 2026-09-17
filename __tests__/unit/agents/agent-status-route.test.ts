import { describe, it, expect, vi, beforeEach } from "vitest";
const buildAgentStatus = vi.fn(async (id: string, deps?: { refresh?: boolean }) => ({ agentId: id, ready: id === "codex", deps }));
const invalidateAgentCliMemo = vi.fn();
const refreshAgentCache = vi.fn();
vi.mock("@/lib/agents/agent-status", () => ({ buildAgentStatus: (id: string, deps?: { refresh?: boolean }) => buildAgentStatus(id, deps) }));
vi.mock("@/lib/agents/cli/resolve", () => ({ invalidateAgentCliMemo: (id?: string) => invalidateAgentCliMemo(id) }));
vi.mock("@/lib/agents/acp/agent-registry", () => ({ refreshAgentCache: () => refreshAgentCache() }));
import { GET } from "@/app/api/agents/status/route";

describe("GET /api/agents/status", () => {
  beforeEach(() => {
    buildAgentStatus.mockClear();
    invalidateAgentCliMemo.mockClear();
    refreshAgentCache.mockClear();
  });
  it("answers for both agents by default", async () => {
    const body = await (await GET(new Request("http://localhost/api/agents/status"))).json();
    expect(Object.keys(body.agents).sort()).toEqual(["claude-code", "codex"]);
    expect(invalidateAgentCliMemo).not.toHaveBeenCalled();
  });
  it("?agent= answers for that agent only (the wizard polls one)", async () => {
    const body = await (await GET(new Request("http://localhost/api/agents/status?agent=codex"))).json();
    expect(Object.keys(body.agents)).toEqual(["codex"]);
    expect(buildAgentStatus).toHaveBeenCalledTimes(1);
  });
  it("plain reads pass no refresh", async () => {
    await GET(new Request("http://localhost/api/agents/status?agent=codex"));
    expect(buildAgentStatus).toHaveBeenCalledWith("codex", { refresh: false });
  });
  it("&refresh=1 drops that agent's CLI memo and the adapter cache, and asks buildAgentStatus for a fresh registration", async () => {
    await GET(new Request("http://localhost/api/agents/status?agent=claude-code&refresh=1"));
    expect(invalidateAgentCliMemo).toHaveBeenCalledWith("claude-code");
    expect(refreshAgentCache).toHaveBeenCalled();
    expect(buildAgentStatus).toHaveBeenCalledWith("claude-code", { refresh: true });
  });
  it("rejects an unknown agent", async () => {
    expect((await GET(new Request("http://localhost/api/agents/status?agent=gpt"))).status).toBe(400);
  });
});
