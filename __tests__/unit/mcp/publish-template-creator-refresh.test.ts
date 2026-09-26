/**
 * libi.publish_template refused because the creator isn't approved: the
 * Templates page's cached approval may say otherwise (approval withdrawn since
 * it was read), so the server asks the page to re-read THAT, and only that —
 * `refresh_query templates-creator`, never the whole `templates` prefix, whose
 * re-reads would spend the site's 10-a-minute `creators` budget. A gate that
 * couldn't ask the site learned nothing, and refreshes nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const gate = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@/lib/templates/cloud/creator", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/templates/cloud/creator")>();
  return { ...real, checkCreatorApproved: gate.check };
});
vi.mock("@/mcp/notify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/mcp/notify")>();
  return { ...mod, notify: { ...mod.notify, refreshQuery: vi.fn() } };
});
import { notify } from "@/mcp/notify";
import { createLibiMcpServer } from "@/mcp/server";
import { CREATOR_GATE_MESSAGES } from "@/lib/templates/cloud/creator";
import { CREATOR_STATUS_REFRESH_KEY } from "@/lib/templates/cloud/constants";

async function publish() {
  const server = createLibiMcpServer();
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await client.callTool({ name: "libi.publish_template", arguments: { templateId: "t1", exampleVideo: { path: "/tmp/x.mp4" } } });
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("libi.publish_template refused for approval", () => {
  it.each(["none", "pending", "rejected"] as const)("%s: re-reads the page's creator approval, and nothing else", async (status) => {
    gate.check.mockResolvedValue({ ok: false, status, error: CREATOR_GATE_MESSAGES[status] });
    await publish();
    expect(vi.mocked(notify.refreshQuery).mock.calls).toEqual([[{ queryKey: CREATOR_STATUS_REFRESH_KEY }]]);
  });

  it("unknown (the catalog didn't answer): refreshes nothing", async () => {
    gate.check.mockResolvedValue({ ok: false, status: "unknown", error: CREATOR_GATE_MESSAGES.unknown });
    await publish();
    expect(notify.refreshQuery).not.toHaveBeenCalled();
  });
});
