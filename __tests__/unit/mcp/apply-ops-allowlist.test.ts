/**
 * What `libi.apply_ops` may run is DATA (lib/agents/apply-ops-allowlist.ts). This holds that data to the
 * tools a real server registers: every tool (and every action of a merged one) is allowed or refused,
 * never both and never neither, so a new tool cannot ship without someone deciding whether a batch may
 * run it, and the allow-list cannot name something that does not exist.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibiMcpServer } from "@/mcp/server";
import { MERGED_TOOL_RISK, mergedToolAllowsAlways } from "@/lib/agents/merged-tools";
import {
  APPLY_OPS_ALLOWED,
  APPLY_OPS_REFUSED,
  APPLY_OPS_REFUSAL_REASONS,
  applyOpsAllows,
  applyOpsRefusal,
} from "@/lib/agents/apply-ops-allowlist";

async function registeredNames(surface: "in-app" | "cli"): Promise<string[]> {
  const server = createLibiMcpServer({ surface });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  await server.close();
  return names;
}

let names: string[];
beforeAll(async () => {
  names = [...new Set([...(await registeredNames("in-app")), ...(await registeredNames("cli"))])].sort();
});

const mergedActions = (tool: string): string[] => {
  const risk = MERGED_TOOL_RISK[tool as keyof typeof MERGED_TOOL_RISK];
  return risk ? [...risk.readOnly, ...risk.changes] : [];
};

describe("apply_ops allow-list drift", () => {
  it("classifies every registered tool, and every action of a merged one, exactly once", () => {
    expect(names.length).toBeGreaterThan(100);
    const unclassified: string[] = [];
    const doubled: string[] = [];
    for (const tool of names) {
      const actions = mergedActions(tool);
      const pairs = actions.length > 0 ? actions.map((a) => [tool, a] as const) : ([[tool, undefined]] as const);
      for (const [t, a] of pairs) {
        const label = a ? `${t}:${a}` : t;
        const allowed = applyOpsAllows(t, a);
        const refused = applyOpsRefusal(t, a) !== null;
        if (!allowed && !refused) unclassified.push(label);
        if (allowed && refused) doubled.push(label);
      }
    }
    expect(unclassified, "add each to APPLY_OPS_ALLOWED or APPLY_OPS_REFUSED (lib/agents/apply-ops-allowlist.ts)").toEqual([]);
    expect(doubled).toEqual([]);
  });

  it("names only tools, actions and refusal entries that exist", () => {
    for (const [tool, allowance] of Object.entries(APPLY_OPS_ALLOWED)) {
      expect(names, `${tool} is allowed but not registered`).toContain(tool);
      if (allowance.actions) {
        for (const a of allowance.actions) expect(mergedActions(tool), `${tool}:${a}`).toContain(a);
      } else {
        expect(mergedActions(tool), `${tool} is merged: list its actions`).toEqual([]);
      }
    }
    for (const [reason, entries] of Object.entries(APPLY_OPS_REFUSED)) {
      expect(Object.keys(APPLY_OPS_REFUSAL_REASONS)).toContain(reason);
      expect(new Set(entries).size, `${reason} lists an entry twice`).toBe(entries.length);
      for (const entry of entries) {
        const [tool, action] = entry.split(":");
        expect(names, `${entry} is refused but not registered`).toContain(tool);
        if (action) expect(mergedActions(tool), entry).toContain(action);
      }
    }
  });

  it("allows only tools whose input takes a pieceId and writes the draft", async () => {
    const server = createLibiMcpServer({ surface: "in-app" });
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const tools = (await client.listTools()).tools;
    for (const tool of Object.keys(APPLY_OPS_ALLOWED)) {
      const props = tools.find((t) => t.name === tool)!.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(props), `${tool} must take pieceId`).toContain("pieceId");
    }
    await client.close();
    await server.close();
  });

  it("refuses what the brief forbids: approval, user-only, paid, publish, export, snapshots, deletes", () => {
    for (const [tool, action] of [
      ["libi.export_video"],
      ["libi.snapshot", "commit"],
      ["libi.snapshot", "discard"],
      ["libi.snapshot", "restore"],
      ["libi.delete_file"],
      ["libi.delete_piece"],
      ["libi.post_piece"],
      ["libi.social_link", "post"],
      ["libi.generate_music"],
      ["libi.set_audio_rights"],
      ["libi.tracked_overlay", "add"],
      ["libi.track", "compute"],
      ["libi.upload_file"],
      ["libi.apply_ops"],
    ] as [string, string?][]) {
      expect(applyOpsAllows(tool, action), `${tool} ${action ?? ""}`).toBe(false);
      expect(applyOpsRefusal(tool, action), `${tool} ${action ?? ""}`).not.toBeNull();
    }
  });

  it("a merged tool needs an allowed action, and a tool with none is allowed whole", () => {
    expect(applyOpsAllows("libi.audio_duck")).toBe(false);
    expect(applyOpsAllows("libi.audio_duck", "enable")).toBe(true);
    expect(applyOpsAllows("libi.keyframe", "delete")).toBe(true);
    expect(applyOpsAllows("libi.keyframe", "list")).toBe(false);
    expect(applyOpsAllows("libi.update_overlay")).toBe(true);
    expect(applyOpsAllows("libi.overlay_preset", "save")).toBe(false);
    expect(applyOpsAllows("libi.overlay_preset", "apply")).toBe(true);
  });

  it("apply_ops is never offered the remembered 'don't ask again' choice (one 'always' would cover every batch)", () => {
    expect(mergedToolAllowsAlways("libi.apply_ops")).toBe(false);
    expect(mergedToolAllowsAlways("libi.update_overlay")).toBe(true);
  });
});
