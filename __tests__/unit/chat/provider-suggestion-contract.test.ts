import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Contract: the chat's parser reads what the REAL `libi.suggest_provider`
 * returns — not a hand-written copy of it. The tool runs for real against an
 * in-memory DB; only its outside world is faked (detection over HTTP, the
 * studio notifier, analytics, and the on-disk install prober). Its result is
 * then wrapped exactly as `mcp/server.ts#makeContent` puts it on the wire and
 * as the chat reducer stores it, and handed to `extractProviderSuggestion`.
 *
 * If the tool renames `status`, `suggested` or `covered`, the parser silently
 * draws no card (or an empty "already have") — these cases go red instead.
 */
const { fetchProviders } = vi.hoisted(() => ({
  fetchProviders: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock("@/mcp/notify", () => ({ notify: {}, studioBaseUrl: () => "http://127.0.0.1:3461" }));
vi.mock("@/mcp/analytics", () => ({ trackMcpEvent: vi.fn() }));
vi.mock("@/lib/logger", () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mcpLogger: noop, serverLogger: noop, logger: noop };
});
vi.mock("@/mcp/tools/provider-http", () => ({ fetchConnectedProviders: fetchProviders }));
vi.mock("@/mcp/registry/dependency-manager", () => ({
  DependencyManager: class {
    settleInstallStatus = vi.fn(async () => null);
  },
}));

import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { suggestProvider } from "@/mcp/tools/provider-tools";
import type { ToolResult } from "@/mcp/tools/types";
import { extractProviderSuggestion } from "@/lib/chat/provider-suggestion";

/** The canonical call as `toolIdForCall` produces it for libi's own tool. */
const call = { toolId: "libi:libi.suggest_provider", rawTitle: "mcp__libi__libi_suggest_provider" };

/** `makeContent` in `mcp/server.ts`, and the result part the chat reducer keeps. */
function asChatResult(result: ToolResult) {
  return { result: { content: [{ type: "text", text: JSON.stringify(result) }] }, success: true };
}

type ToolCard = {
  status: string;
  kind: string;
  suggested: Array<{ id: string }>;
  covered: Array<{ id: string; name: string; via: string }>;
};

async function roundTrip(kind: "music" | "video") {
  const res = await suggestProvider({ kind }, { surface: "in-app" });
  expect(res.success).toBe(true);
  const tool = res.data as ToolCard;
  // The fields the parser reads, by their current names. A rename leaves one
  // of these undefined and fails here or at the comparison below.
  expect(tool.status).toBe("card");
  expect(Array.isArray(tool.suggested)).toBe(true);
  expect(Array.isArray(tool.covered)).toBe(true);
  return { tool, parsed: extractProviderSuggestion(call, asChatResult(res)) };
}

beforeEach(() => {
  createTestDb();
  // The on-device music extension, not installed yet — a legitimate offer.
  getDb()
    .insert(mcpServers)
    .values([
      { id: "local-music", name: "Local Music (ACE-Step)", description: "Music on-device", type: "stdio", command: "node", args: "[]", bundled: true, installStatus: "pending", dependencyStatus: "[]" },
    ])
    .run();
  fetchProviders.mockReset();
  fetchProviders.mockResolvedValue([]);
});

afterEach(() => resetTestDb());

describe("libi.suggest_provider → extractProviderSuggestion (contract)", () => {
  it("music: an on-device extension first, then a provider to connect", async () => {
    const { tool, parsed } = await roundTrip("music");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe(tool.kind);
    expect(parsed!.kind).toBe("music");
    expect(parsed!.suggested.map((s) => s.id)).toEqual(tool.suggested.map((s) => s.id));
    expect(parsed!.suggested.map((s) => s.id)).toEqual(["ace-step", "elevenlabs"]);
    expect(parsed!.suggested[0]).toMatchObject({ kind: "extension", extensionId: "local-music" });
    expect(parsed!.covered).toEqual(tool.covered);
  });

  it("video: remote-MCP providers only, in the tool's order", async () => {
    const { tool, parsed } = await roundTrip("video");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe(tool.kind);
    expect(parsed!.suggested.map((s) => s.id)).toEqual(tool.suggested.map((s) => s.id));
    expect(parsed!.suggested.map((s) => s.id)).toEqual(["fal", "higgsfield"]);
    expect(parsed!.suggested.every((s) => s.kind === "remote-mcp")).toBe(true);
    expect(parsed!.covered).toEqual(tool.covered);
  });

  it("video with fal already connected: covered carries through to the card", async () => {
    fetchProviders.mockResolvedValue([
      { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected" },
    ]);
    const { tool, parsed } = await roundTrip("video");
    expect(tool.covered.length).toBeGreaterThan(0);
    expect(parsed).not.toBeNull();
    expect(parsed!.suggested.map((s) => s.id)).toEqual(tool.suggested.map((s) => s.id));
    expect(parsed!.suggested.map((s) => s.id)).toEqual(["higgsfield"]);
    expect(parsed!.covered).toEqual(tool.covered);
    expect(parsed!.covered).toEqual([{ id: "fal", name: expect.any(String), via: "connected" }]);
  });
});
