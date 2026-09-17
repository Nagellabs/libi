import { describe, it, expect } from "vitest";
import { navigationEmitter } from "@/lib/navigation-events";
import { POST } from "@/app/api/notify/route";

/** POST `body` and capture whatever the route emits on `event`. */
async function postAndCapture(event: string, body: unknown) {
  const seen: unknown[] = [];
  const handler = (e: unknown) => seen.push(e);
  navigationEmitter.on(event, handler);
  try {
    const res = await POST(
      new Request("http://x/api/notify", { method: "POST", body: JSON.stringify(body) }),
    );
    return { res, seen };
  } finally {
    navigationEmitter.off(event, handler);
  }
}

describe("/api/notify navigate_agents", () => {
  it("emits navigate_agents with the tab and the optional ids", async () => {
    const mcp = await postAndCapture("navigate_agents", {
      type: "navigate_agents",
      tab: "libi-mcp",
      extensionId: "whisper",
    });
    expect(mcp.res.status).toBe(200);
    expect(await mcp.res.json()).toEqual({ ok: true });
    expect(mcp.seen).toEqual([{ tab: "libi-mcp", extensionId: "whisper" }]);

    const providers = await postAndCapture("navigate_agents", {
      type: "navigate_agents",
      tab: "providers",
      provider: "fal",
    });
    expect(providers.seen).toEqual([{ tab: "providers", provider: "fal" }]);

    const agents = await postAndCapture("navigate_agents", { type: "navigate_agents", tab: "agents" });
    expect(agents.seen).toEqual([{ tab: "agents" }]);
  });

  it("defaults an unknown tab to agents and drops junk ids", async () => {
    const { res, seen } = await postAndCapture("navigate_agents", {
      type: "navigate_agents",
      tab: "kitchen",
      extensionId: 5,
      provider: { id: "fal" },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ tab: "agents" }]);
  });

  it("answers 400 for the retired right_region and navigate_settings types", async () => {
    for (const type of ["right_region", "navigate_settings"]) {
      const { res, seen } = await postAndCapture(type, {
        type,
        mode: "connect-provider",
        kind: "music",
        mcpId: "whisper",
      });
      expect(res.status, type).toBe(400);
      expect(seen, type).toEqual([]);
    }
  });
});

describe("/api/notify job_progress", () => {
  it("carries a non-job tool's verbatim message onto the job-progress bus", async () => {
    const { jobProgressEmitter } = await import("@/lib/jobs/progress-emitter");
    const seen: unknown[] = [];
    const h = (e: unknown) => seen.push(e);
    jobProgressEmitter.on("job_progress", h);
    const res = await POST(
      new Request("http://x/api/notify", {
        method: "POST",
        body: JSON.stringify({
          type: "job_progress", jobId: "", kind: "", done: 5000, total: 20000, unit: "", etaMs: null,
          toolName: "libi.sleep", toolArgs: { seconds: 20 }, message: "sleeping — 5/20s",
        }),
      }),
    );
    jobProgressEmitter.off("job_progress", h);
    expect(res.status).toBe(200);
    expect(seen).toEqual([expect.objectContaining({ jobId: "", toolName: "libi.sleep", message: "sleeping — 5/20s" })]);
  });
});
