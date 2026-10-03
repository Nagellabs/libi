import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * NAV-1 (full-verification F14), the server half: an agent's "show" navigation says which libi
 * chat it came from. The MCP child sends the tool call it is running (`origin`: the Claude
 * toolUseId when the engine sent one, and the tool name + args), `/api/notify` resolves that to the
 * chat's session (`SessionManager.sessionForToolCall`) and stamps the broadcast with
 * `fromSessionId` and a per-event `navId` — so only the tab showing that chat navigates
 * (`hooks/sessions/tab-nav-gate.ts`). A call that belongs to no libi chat (a CLI agent) is
 * broadcast exactly as before.
 */

vi.mock("@/lib/libi-home", async (orig) => ({ ...(await orig<object>()), getCurrentPort: () => 4321 }));
const sm = vi.hoisted(() => ({ sessionForToolCall: vi.fn((): string | null => "chat-1") }));
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => sm }));

import { notify } from "@/mcp/notify";
import { runWithToolCallContext, wrapRegisterToolWithContext, getCurrentToolCall } from "@/mcp/tool-call-context";
import { navigationEmitter } from "@/lib/navigation-events";
import { POST } from "@/app/api/notify/route";

let posted: Array<Record<string, unknown>> = [];
beforeEach(() => {
  vi.clearAllMocks();
  posted = [];
  sm.sessionForToolCall.mockReturnValue("chat-1");
});

function captureFetch() {
  vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    posted.push(JSON.parse(String((init as RequestInit).body)));
    return new Response("{}", { status: 200 });
  });
}

async function postAndCapture(event: string, body: unknown) {
  const seen: Array<Record<string, unknown>> = [];
  const handler = (e: Record<string, unknown>) => seen.push(e);
  navigationEmitter.on(event, handler);
  try {
    const res = await POST(new Request("http://x/api/notify", { method: "POST", body: JSON.stringify(body) }));
    return { res, seen };
  } finally {
    navigationEmitter.off(event, handler);
  }
}

describe("the MCP child names the tool call a navigation comes from", () => {
  it("the context captures Claude's toolUseId from the handler's extra", async () => {
    let ctx: unknown;
    const register = (...args: unknown[]) => {
      const handler = args[args.length - 1] as (a: unknown, extra: unknown) => Promise<unknown>;
      return handler({ target: "templates", templateId: "t1" }, { _meta: { "claudecode/toolUseId": "toolu_9" } });
    };
    await (wrapRegisterToolWithContext(register as never)("libi.show", {}, async () => {
      ctx = getCurrentToolCall();
    }) as Promise<unknown>);
    expect(ctx).toEqual({ toolName: "libi.show", args: { target: "templates", templateId: "t1" }, toolUseId: "toolu_9" });
  });

  it("navigateTemplates / navigateAgents carry `origin` inside a tool call", async () => {
    captureFetch();
    await runWithToolCallContext("libi.show", { target: "templates", templateId: "t1" }, () => notify.navigateTemplates({ templateId: "t1" }), "toolu_1");
    await runWithToolCallContext("libi.show", { target: "extension", extensionId: "whisper" }, () =>
      notify.navigateAgents({ tab: "libi-mcp", extensionId: "whisper" }),
    );
    expect(posted[0]).toEqual({
      type: "navigate_templates",
      templateId: "t1",
      origin: { toolCallId: "toolu_1", toolName: "libi.show", toolArgs: { target: "templates", templateId: "t1" } },
    });
    expect(posted[1]).toEqual({
      type: "navigate_agents",
      tab: "libi-mcp",
      extensionId: "whisper",
      origin: { toolName: "libi.show", toolArgs: { target: "extension", extensionId: "whisper" } },
    });
  });

  it("outside a tool call nothing is added", async () => {
    captureFetch();
    await notify.navigateTemplates({});
    expect(posted[0]).toEqual({ type: "navigate_templates" });
    await notify.navigateSocial({ accountId: "acc-ig" });
    expect(posted[1]).toEqual({ type: "navigate_social", accountId: "acc-ig" });
  });
});

describe("/api/notify stamps the chat a navigation comes from", () => {
  const origin = { toolCallId: "toolu_1", toolName: "libi.show", toolArgs: { target: "templates", templateId: "t1" } };

  it("navigate_templates from a libi chat carries fromSessionId and a navId", async () => {
    const { res, seen } = await postAndCapture("navigate_templates", { type: "navigate_templates", templateId: "t1", origin });
    expect(res.status).toBe(200);
    expect(sm.sessionForToolCall).toHaveBeenCalledWith(origin);
    expect(seen).toEqual([{ templateId: "t1", fromSessionId: "chat-1", navId: expect.any(String) }]);
  });

  it("navigate_agents from a libi chat too, and each event gets its own navId", async () => {
    const a = await postAndCapture("navigate_agents", { type: "navigate_agents", tab: "libi-mcp", origin });
    const b = await postAndCapture("navigate_agents", { type: "navigate_agents", tab: "libi-mcp", origin });
    expect(a.seen[0]).toEqual({ tab: "libi-mcp", fromSessionId: "chat-1", navId: expect.any(String) });
    expect(a.seen[0].navId).not.toBe(b.seen[0].navId);
  });

  it("navigate_social carries the account and the chat it came from", async () => {
    const o = { toolCallId: "toolu_2", toolName: "libi.show", toolArgs: { target: "social_settings", accountId: "acc-ig" } };
    const { res, seen } = await postAndCapture("navigate_social", { type: "navigate_social", accountId: "acc-ig", origin: o });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ accountId: "acc-ig", fromSessionId: "chat-1", navId: expect.any(String) }]);
    // No account (or junk): the page alone.
    sm.sessionForToolCall.mockReturnValue(null);
    const bare = await postAndCapture("navigate_social", { type: "navigate_social", accountId: 5 });
    expect(bare.seen).toEqual([{}]);
  });

  it("a call that belongs to no libi chat (a CLI agent) is broadcast exactly as before", async () => {
    sm.sessionForToolCall.mockReturnValue(null);
    const { seen } = await postAndCapture("navigate_templates", { type: "navigate_templates", origin });
    expect(seen).toEqual([{}]);
    const noOrigin = await postAndCapture("navigate_agents", { type: "navigate_agents", tab: "agents" });
    expect(noOrigin.seen).toEqual([{ tab: "agents" }]);
  });
});
