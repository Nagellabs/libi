/**
 * POST /api/mcp/restart is a thin wrapper over the supervisor's `restart()`:
 * 200 with the port the endpoint came back on, 503 with the error text when
 * there is no child to restart or the relaunch failed. The supervisor's own
 * behaviour is covered in `server/lifecycle/mcp-http-child.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const restart = vi.fn(async () => {});
let child: { restart: typeof restart; port: number } | null = { restart, port: 3457 };
vi.mock("@/lib/server/lifecycle/category-b", () => ({ getMcpHttpChild: () => child }));

import { POST } from "@/app/api/mcp/restart/route";

describe("POST /api/mcp/restart", () => {
  beforeEach(() => {
    restart.mockReset();
    restart.mockResolvedValue(undefined);
    child = { restart, port: 3457 };
  });

  it("restarts the child and answers with the port it came back on", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, port: 3457 });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("503 when there is no child to restart, and when the relaunch is unhealthy", async () => {
    child = null;
    expect((await POST()).status).toBe(503);
    child = { restart, port: 3457 };
    restart.mockRejectedValue(new Error("MCP aggregator on port 3457 did not become healthy"));
    const res = await POST();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/healthy/);
  });

  it("restarts a child that gave up at boot instead of refusing it", async () => {
    // A first launch that never answered leaves a gave-up handle, not none.
    child = Object.assign({ restart, port: 3457 }, { status: () => "gave-up" as const });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, port: 3457 });
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
