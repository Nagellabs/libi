import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibiMcpServer } from "@/mcp/server";
import { IN_APP_ONLY_TOOLS } from "@/lib/mcp/agent-surface";
import type { AgentSurface } from "@/lib/mcp/agent-surface";
import { renderAgentInstructions } from "@/mcp/workspace";
import { resolveManualSection, splitManual } from "@/mcp/manual-sections";

/**
 * The three social tools reach an agent only if they survive the SDK's
 * JSON-schema conversion — which under zod v4 fails SILENTLY and drops every
 * tool from `tools/list`. A schema-object unit test cannot see that, so this
 * asserts through a REAL `tools/list`, the same way
 * `assign-file-registration.test.ts` does.
 *
 * They are registered on BOTH surfaces on purpose: a user's own Claude Code or
 * Codex posts from its own project, so none of them is in `IN_APP_ONLY_TOOLS`.
 */
const NAMES = ["libi.social_status", "libi.post_piece", "libi.social_link", "libi.social_music_search"] as const;

async function listTools(surface?: AgentSurface) {
  const server = createLibiMcpServer(surface !== undefined ? { surface } : undefined);
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}

describe("the social tools are reachable over MCP", () => {
  it.each([undefined, "cli", "in-app"] as const)("surface %s", async (surface) => {
    const { tools } = await listTools(surface);
    const names = tools.map((t) => t.name);
    // THE CANARY: a silently empty list would satisfy nothing below for the
    // wrong reason.
    expect(names).toContain("libi.add_overlay");
    expect(names.length).toBeGreaterThan(50);
    for (const n of NAMES) expect(names).toContain(n);
  });

  it("none of them is in-app-only, so the drift list is untouched", () => {
    for (const n of NAMES) expect(IN_APP_ONLY_TOOLS).not.toContain(n);
  });

  it("post_piece's converted schema carries pieceId, targets, caption and exportPath — and NOTHING that could publish", async () => {
    const { tools } = await listTools();
    const tool = tools.find((t) => t.name === "libi.post_piece");
    expect(tool).toBeTruthy();
    expect(tool!.inputSchema.type).toBe("object");
    const props = (tool!.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
    expect(Object.keys(props).sort()).toEqual(["caption", "exportPath", "pieceId", "targets"]);
    expect(props.pieceId.type).toBe("string");
    expect(props.targets.type).toBe("array");
    expect(tool!.inputSchema.required).toEqual(["pieceId"]);
    // The structural guarantee: there is no argument an agent could send to
    // make this publish or schedule.
    const raw = JSON.stringify(tool!.inputSchema);
    for (const forbidden of ["publish", "schedule", "when", "isDraft", "now"]) {
      expect(raw.toLowerCase(), `post_piece's schema exposes "${forbidden}"`).not.toContain(`"${forbidden.toLowerCase()}"`);
    }
  });

  it("social_link takes a `kind` (post | ad) and the ids it links, and social_status takes nothing", async () => {
    const { tools } = await listTools();
    const link = tools.find((t) => t.name === "libi.social_link")!;
    expect(Object.keys((link.inputSchema.properties ?? {}) as Record<string, unknown>).sort()).toEqual([
      "exportPath",
      "kind",
      "pieceId",
      "platformAdId",
      "providerAdId",
      "providerPostId",
    ]);
    expect((link.inputSchema.properties as Record<string, { enum?: string[] }>).kind.enum).toEqual(["post", "ad"]);
    expect(link.inputSchema.required).toEqual(["kind"]);
    const status = tools.find((t) => t.name === "libi.social_status")!;
    expect(status.inputSchema.properties ?? {}).toEqual({});
  });

  it("social_music_search takes any of the five platforms and tells the agent the export its plan implies", async () => {
    const { tools } = await listTools();
    const tool = tools.find((t) => t.name === "libi.social_music_search")!;
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    expect(Object.keys(props).sort()).toEqual(["accountId", "pieceId", "platform", "query"]);
    expect(props.platform.enum).toEqual(["instagram", "tiktok", "youtube", "facebook", "twitter"]);
    expect(tool.inputSchema.required).toEqual(["pieceId", "platform"]);
    const d = tool.description ?? "";
    expect(d).toMatch(/exportVideoArgs/);
    expect(d).toMatch(/libi\.export_video/);
    expect(d).toMatch(/Read-only/);
  });

  it("post_piece's description tells the agent it never publishes", async () => {
    const { tools } = await listTools();
    const d = tools.find((t) => t.name === "libi.post_piece")!.description ?? "";
    expect(d).toMatch(/DRAFT/);
    expect(d).toMatch(/NEVER publishes and NEVER schedules/);
    expect(d).toMatch(/ambiguous_account/);
    const status = tools.find((t) => t.name === "libi.social_status")!.description ?? "";
    expect(status).toMatch(/separate from your own zernio tools/);
  });
});

/**
 * The manual is how an agent learns the contract it cannot read off a schema.
 * It is SECTIONED, so the prose has to resolve under its own key — a section
 * that exists only inside the 87 KB whole is a section no agent reads.
 */
describe("the manual teaches social posting", () => {
  it.each(["claude", "codex"] as const)("has a `social-posting` section with the draft-only contract (%s)", (dialect) => {
    const manual = renderAgentInstructions(dialect);
    const keys = splitManual(manual).sections.map((s) => s.key);
    expect(keys).toContain("social-posting");
    const res = resolveManualSection(manual, "social-posting");
    expect(res.ok).toBe(true);
    const text = res.ok ? res.text : "";
    for (const fact of [
      "libi.social_status",
      "libi.post_piece",
      "libi.social_link",
      "Drafts only",
      "cannot publish or schedule",
      // The provider truths that were measured live and cost real time.
      "posts_create_post",
      "call_tool",
      "accounts_get_tik_tok_creator_info",
      "Never re-send a media URL the provider gave you back",
      "Instagram refuses a post with no media",
      "no idempotency header",
      "Ads are read-only",
      "never a broken connection",
      "still be syncing",
      "different sign-in",
    ]) {
      expect(text, `the social-posting section lacks "${fact}"`).toContain(fact);
    }
  });
});
