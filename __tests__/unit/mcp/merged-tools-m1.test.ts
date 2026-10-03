/**
 * The M1 merged families, through a REAL server and a real MCP client: `libi.skill`, `libi.character`,
 * `libi.catalog_item`, `libi.template`, `libi.extension`, and the plain two-field `libi.update_piece`.
 *
 * Each action must behave like the per-verb tool it replaced (the function suites — skill-tools,
 * character/item tools, template-tools, extension-tools — still hold the handlers to their contracts), and
 * the tool list must carry the merged names only. The results the skill and catalog tools return are
 * already in the MCP wire format, so the helper must send them as they are, never wrapped a second time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";

const reload = vi.hoisted(() => ({ scheduleSessionReload: vi.fn() }));
vi.mock("@/lib/sessions/session-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sessions/session-manager")>()),
  getSessionManager: () => reload,
}));
const tpl = vi.hoisted(() => ({
  updateTemplateTool: vi.fn(),
  deleteTemplateTool: vi.fn(),
}));
vi.mock("@/mcp/tools/template-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/template-tools")>()),
  ...tpl,
}));

import { createLibiMcpServer } from "@/mcp/server";
import { notify } from "@/mcp/notify";
import { MERGED_TOOL_DISCRIMINATORS } from "@/lib/agents/merged-tools";
import { registeredMergedTools } from "@/mcp/tools/action-registry";
import { listSkills } from "@/mcp/tools/skill-tools";
import { getDb } from "@/lib/db/client";
import { skills, pieces, mcpServers } from "@/lib/db/schema";

async function connect(surface: "cli" | "in-app" = "in-app") {
  const server = createLibiMcpServer({ surface });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    tools: async (): Promise<Tool[]> => (await client.listTools()).tools,
    call: async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      const text = (res.content as Array<{ text: string }>)[0].text;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // SDK-level refusals are plain text
      }
      return { isError: !!res.isError, text, json };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-m1-"));
  prevHome = process.env.LIBI_HOME;
  process.env.LIBI_HOME = home;
  createTestDb();
  reload.scheduleSessionReload.mockReset();
  tpl.updateTemplateTool.mockReset();
  tpl.deleteTemplateTool.mockReset();
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const OLD_TOOLS = [
  "libi.list_skills", "libi.add_skill", "libi.update_skill", "libi.remove_skill", "libi.fork_skill",
  "libi.set_skill_enabled", "libi.set_skills_enabled_by_tag", "libi.diff_skill_override",
  "libi.list_skill_prompts", "libi.add_skill_prompt", "libi.update_skill_prompt", "libi.remove_skill_prompt",
  "libi.list_characters", "libi.get_character", "libi.create_character", "libi.update_character",
  "libi.delete_character", "libi.link_character_to_asset", "libi.unlink_character_from_asset",
  "libi.list_items", "libi.get_item", "libi.create_item", "libi.update_item", "libi.delete_item",
  "libi.link_item_to_asset", "libi.unlink_item_from_asset",
  "libi.get_template", "libi.search_templates", "libi.list_templates", "libi.update_template", "libi.delete_template",
  "libi.diagnose_mcp", "libi.recheck_mcp", "libi.retry_mcp_server", "libi.restart_mcp_server",
  "libi.update_mcp_server", "libi.restart_acp_session",
  "libi.update_piece_name", "libi.update_piece_description",
];

const KEPT_SEPARATE = [
  "libi.create_template_from_piece", "libi.apply_template", "libi.fetch_template_music", "libi.publish_template",
  "libi.get_install_plan", "libi.update_dep_status", "libi.verify_install",
];

describe("the tool list", () => {
  it.each(["cli", "in-app"] as const)("(%s) carries the M1 merged tools and none of the 39 per-verb ones", async (surface) => {
    const h = await connect(surface);
    const names = (await h.tools()).map((t) => t.name);
    for (const merged of ["libi.skill", "libi.character", "libi.catalog_item", "libi.template", "libi.extension", "libi.update_piece"]) {
      expect(names).toContain(merged);
    }
    for (const old of OLD_TOOLS) expect(names, old).not.toContain(old);
    for (const kept of KEPT_SEPARATE.filter((n) => n !== "libi.verify_install")) expect(names, kept).toContain(kept);
    await h.close();
  });

  it("each family's actions are the ones the spec lists, and update_piece is not an action tool", async () => {
    const actions = (n: string) => [...registeredMergedTools().get(n)!.actions];
    await (await connect()).close();
    expect(actions("libi.skill")).toEqual([
      "list", "add", "update", "remove", "fork", "enable", "enable_by_tag", "diff_override",
      "list_prompts", "add_prompt", "update_prompt", "remove_prompt",
    ]);
    expect(actions("libi.character")).toEqual(["list", "get", "create", "update", "delete", "link", "unlink"]);
    expect(actions("libi.catalog_item")).toEqual(["list", "get", "create", "update", "delete", "link", "unlink"]);
    expect(actions("libi.template")).toEqual(["get", "search", "list", "update", "delete"]);
    expect(actions("libi.extension")).toEqual(["diagnose", "recheck", "retry", "restart", "update", "restart_session"]);
    expect(Object.keys(MERGED_TOOL_DISCRIMINATORS)).not.toContain("libi.update_piece");
    expect(registeredMergedTools().has("libi.update_piece")).toBe(false);
  });

  it("libi.skill's list description tells the agent about retiredSkillRefs", async () => {
    const h = await connect();
    const tool = (await h.tools()).find((t) => t.name === "libi.skill")!;
    const action = (tool.inputSchema.properties as Record<string, { description: string }>).action.description;
    expect(action).toContain("retiredSkillRefs");
    await h.close();
  });

  it("libi.update_piece is a flat object: only pieceId is required, name and description are optional", async () => {
    const h = await connect();
    const tool = (await h.tools()).find((t) => t.name === "libi.update_piece")!;
    expect(tool.inputSchema.required).toEqual(["pieceId"]);
    expect(Object.keys(tool.inputSchema.properties as object).sort()).toEqual(["description", "name", "pieceId"]);
    await h.close();
  });

  it("the merged tools that wrap differently-typed properties advertise the loosest form", async () => {
    const h = await connect();
    const byName = new Map((await h.tools()).map((t) => [t.name, t]));
    const props = (n: string) => byName.get(n)!.inputSchema.properties as Record<string, Record<string, unknown>>;
    // skill: name is max-64 in add, pattern-bound in remove_prompt, unbounded in diff_override
    expect(props("libi.skill").name).not.toHaveProperty("maxLength");
    expect(props("libi.skill").name).not.toHaveProperty("pattern");
    // extension: mcpId is non-empty for retry only
    expect(props("libi.extension").mcpId).not.toHaveProperty("minLength");
    // character: representativeImageFileId is nullable in update
    expect(JSON.stringify(props("libi.character").representativeImageFileId)).toContain("null");
    await h.close();
  });
});

describe("libi.skill", () => {
  const body = (name: string) => `---\nname: ${name}\ndescription: Mine\n---\nBody.\n`;

  it("list sends the function's own wire result, not a wrapped copy", async () => {
    getDb().insert(skills).values({ id: "u1", name: "mine", description: "d", source: "user", enabled: true, body: "ugc-craft says hi" }).run();
    const h = await connect();
    const res = await h.call("libi.skill", { action: "list" });
    const direct = await listSkills({ pieceId: "" }, {});
    expect(res.text).toBe(direct.content[0].text);
    expect(res.json.skills[0].retiredSkillRefs).toEqual([{ name: "ugc-craft", successor: "ugc-product-video" }]);
    await h.close();
  });

  it("add, enable, remove behave like add_skill, set_skill_enabled, remove_skill", async () => {
    const h = await connect();
    const added = await h.call("libi.skill", { action: "add", name: "my-skill", description: "Mine", body: body("my-skill") });
    expect(added.json.name).toBe("my-skill");
    expect(fs.readFileSync(path.join(home, "skills/my-skill/SKILL.md"), "utf-8")).toContain("Body.");
    const id = added.json.id as string;

    const off = await h.call("libi.skill", { action: "enable", id, enabled: false });
    expect(off.isError).toBe(false);
    const listed = await h.call("libi.skill", { action: "list" });
    expect(listed.json.skills.find((s: { id: string }) => s.id === id).enabled).toBe(false);

    await h.call("libi.skill", { action: "remove", id });
    const after = await h.call("libi.skill", { action: "list" });
    expect(after.json.skills.some((s: { id: string }) => s.id === id)).toBe(false);
    await h.close();
  });

  it("a tool-level failure comes back as the function's own { error } result", async () => {
    const h = await connect();
    const res = await h.call("libi.skill", { action: "add", name: "different", description: "x", body: body("my-skill") });
    expect(res.json.error).toMatch(/does not match/);
    await h.close();
  });

  it("the prompt actions point a bundled skill at fork, naming the merged tool", async () => {
    getDb().insert(skills).values({ id: "b1", name: "bundled-one", description: "d", source: "bundled", enabled: true, body: "" }).run();
    const h = await connect();
    const res = await h.call("libi.skill", { action: "add_prompt", skillName: "bundled-one", name: "p", body: "x" });
    expect(res.json.error).toContain('libi.skill({ action: "fork" })');
    const missing = await h.call("libi.skill", { action: "add_prompt", skillName: "nope", name: "p", body: "x" });
    expect(missing.json.error).toContain('libi.skill({ action: "add" })');
    await h.close();
  });

  it("a missing field for the chosen action names the action and what it requires; an unknown action lists them", async () => {
    const h = await connect();
    const noBody = await h.call("libi.skill", { action: "update", name: "x" });
    expect(noBody.isError).toBe(true);
    expect(noBody.json.error).toContain('libi.skill({ action: "update" })');
    expect(noBody.json.error).toContain("update requires: name, body");
    const unknown = await h.call("libi.skill", { action: "install" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("enable_by_tag");
    await h.close();
  });

  it("each action still enforces its OWN schema: remove_prompt keeps its kebab-case pattern, add_prompt does not", async () => {
    getDb().insert(skills).values({ id: "u2", name: "mine", description: "d", source: "user", enabled: true, body: "" }).run();
    const h = await connect();
    const bad = await h.call("libi.skill", { action: "remove_prompt", skillName: "mine", name: "Bad/Name" });
    expect(bad.isError).toBe(true);
    expect(bad.json.error).toContain('{ action: "remove_prompt" }');
    expect(bad.json.error).toMatch(/Kebab-case/);
    await h.close();
  });
});

describe("libi.character and libi.catalog_item", () => {
  it.each([
    ["libi.character", "character"],
    ["libi.catalog_item", "item"],
  ] as const)("%s: create, get, list, update, delete like the per-verb tools did", async (tool, key) => {
    const h = await connect();
    const created = await h.call(tool, { action: "create", name: "Ada" });
    expect(created.json[key].name).toBe("Ada");
    const id = created.json[key].id as string;

    const got = await h.call(tool, { action: "get", id });
    expect(got.json[key].linkedAssetIds).toEqual([]);

    const listed = await h.call(tool, { action: "list", query: "ad" });
    expect(listed.json[`${key}s`].map((c: { id: string }) => c.id)).toEqual([id]);

    // update takes null to clear the representative image (create takes only a string)
    const updated = await h.call(tool, { action: "update", id, description: "first", representativeImageFileId: null });
    expect(updated.json[key].description).toBe("first");

    const dupe = await h.call(tool, { action: "create", name: "Ada" });
    expect(dupe.json.error).toContain(`libi.${tool === "libi.character" ? "character" : "catalog_item"}({ action: "update" })`);

    await h.call(tool, { action: "delete", id });
    expect((await h.call(tool, { action: "get", id })).json.error).toMatch(/not found/);
    await h.close();
  });

  it("link and unlink use characterId / itemId, and say what is missing", async () => {
    const h = await connect();
    const noFile = await h.call("libi.character", { action: "link", characterId: "c1" });
    expect(noFile.isError).toBe(true);
    expect(noFile.text).toContain("link requires: characterId, fileId");
    const item = await h.call("libi.catalog_item", { action: "link", characterId: "c1", fileId: "f1" });
    expect(item.isError).toBe(true);
    expect(item.text).toContain("link requires: itemId, fileId");
    expect((await h.call("libi.character", { action: "link", characterId: "c1", fileId: "f1" })).json.error).toBe("Character not found");
    await h.close();
  });
});

describe("libi.template", () => {
  it("list answers with the function's result, and `get` without a templateId says what it needs", async () => {
    const h = await connect();
    const list = await h.call("libi.template", { action: "list" });
    expect(list.json.success).toBe(true);
    expect(list.json.data.templates).toEqual([]);
    const get = await h.call("libi.template", { action: "get" });
    expect(get.isError).toBe(true);
    expect(get.text).toContain("get requires: templateId");
    await h.close();
  });

  it("update and delete refresh the Templates page on success only; the readers never do", async () => {
    const refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => {});
    tpl.updateTemplateTool.mockResolvedValue({ success: true, data: {} });
    tpl.deleteTemplateTool.mockResolvedValueOnce({ success: false, error: "not_found" }).mockResolvedValueOnce({ success: true, data: {} });
    const h = await connect();
    await h.call("libi.template", { action: "update", templateId: "t1", name: "New" });
    expect(refresh).toHaveBeenCalledWith({ queryKey: "templates" });
    refresh.mockClear();
    await h.call("libi.template", { action: "delete", templateId: "t1" });
    expect(refresh).not.toHaveBeenCalled();
    await h.call("libi.template", { action: "delete", templateId: "t1" });
    expect(refresh).toHaveBeenCalledWith({ queryKey: "templates" });
    refresh.mockClear();
    await h.call("libi.template", { action: "list" });
    await h.call("libi.template", { action: "search", query: "kinetic" });
    expect(refresh).not.toHaveBeenCalled();
    await h.close();
  });

  it("none of the five actions is gated differently: all are advertised on both surfaces and none is in-app only", async () => {
    for (const surface of ["cli", "in-app"] as const) {
      const h = await connect(surface);
      const tool = (await h.tools()).find((t) => t.name === "libi.template")!;
      expect((tool.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum).toEqual(["get", "search", "list", "update", "delete"]);
      await h.close();
    }
  });
});

describe("libi.extension", () => {
  const seedRow = (id: string) =>
    getDb()
      .insert(mcpServers)
      .values({ id, name: id, type: "stdio", command: "x", args: "[]", installStatus: "installed", serverStatus: "unknown" } as never)
      .run();

  it("update refuses requireApproval: false (user only) and still takes true, with the old tool's codes", async () => {
    seedRow("libi-tracking");
    const h = await connect();
    const off = await h.call("libi.extension", { action: "update", id: "libi-tracking", requireApproval: false });
    expect(off.json).toMatchObject({ success: false, error: "user_only" });
    const on = await h.call("libi.extension", { action: "update", id: "libi-tracking", requireApproval: true });
    expect(on.json).toMatchObject({ success: true, data: { id: "libi-tracking", requireApproval: true } });
    const none = await h.call("libi.extension", { action: "update", id: "libi-tracking" });
    expect(none.json).toMatchObject({ success: false, error: "no_change" });
    await h.close();
  });

  it("update names `id` but also accepts `mcpId`, the other actions' spelling; each says what it requires", async () => {
    const h = await connect();
    const viaMcpId = await h.call("libi.extension", { action: "update", mcpId: "libi-tracking", requireApproval: true });
    expect(viaMcpId.text).not.toContain("update requires");
    const noId = await h.call("libi.extension", { action: "update", requireApproval: true });
    expect(noId.isError).toBe(true);
    expect(noId.text).toContain("update requires: id");
    const noMcp = await h.call("libi.extension", { action: "diagnose" });
    expect(noMcp.isError).toBe(true);
    expect(noMcp.text).toContain("diagnose requires: mcpId");
    await h.close();
  });

  it("diagnose, recheck and restart answer an unknown extension as the per-verb tools did", async () => {
    const h = await connect();
    expect((await h.call("libi.extension", { action: "diagnose", mcpId: "nope" })).json).toMatchObject({ success: false });
    expect((await h.call("libi.extension", { action: "recheck", mcpId: "nope" })).json).toMatchObject({ success: false });
    expect((await h.call("libi.extension", { action: "restart", mcpId: "nope" })).json).toMatchObject({ success: false });
    await h.close();
  });

  it("restart_session resolves its session from `_meta.sessionId`, the way restart_acp_session did", async () => {
    const h = await connect();
    const res = await h.call("libi.extension", { action: "restart_session" }, { sessionId: "acp-session-7" });
    expect(res.json.success).toBe(true);
    // The reload is scheduled after the result has been delivered.
    await vi.waitFor(() => expect(reload.scheduleSessionReload).toHaveBeenCalledWith("acp-session-7"));
    await h.close();
  });

  it("no extension action is approval-gated: the family is under no extension's toolPrefixes", async () => {
    const { extensionForToolName } = await import("@/mcp/registry/bundled");
    for (const n of ["libi.skill", "libi.character", "libi.catalog_item", "libi.template", "libi.extension", "libi.update_piece"]) {
      expect(extensionForToolName(n), n).toBeNull();
    }
  });
});

describe("libi.update_piece", () => {
  const PIECE = "p-upd";
  const seed = () =>
    getDb().insert(pieces).values({ id: PIECE, name: "Old", description: "Old description", nameSetByUser: false } as never).run();

  it("name and description together set both; a description alone leaves the name; neither is an error", async () => {
    seed();
    const refresh = vi.spyOn(notify, "refreshQuery").mockImplementation(() => {});
    const h = await connect();
    const both = await h.call("libi.update_piece", { pieceId: PIECE, name: "New", description: "New description" });
    expect(both.json.success).toBe(true);
    const row = () => getDb().select().from(pieces).all().find((p) => p.id === PIECE)!;
    expect(row()).toMatchObject({ name: "New", description: "New description" });
    expect(refresh).toHaveBeenCalledWith({ queryKey: "piece", pieceId: PIECE });

    await h.call("libi.update_piece", { pieceId: PIECE, description: "Only this" });
    expect(row()).toMatchObject({ name: "New", description: "Only this" });

    refresh.mockClear();
    const neither = await h.call("libi.update_piece", { pieceId: PIECE });
    expect(neither.json).toMatchObject({ success: false });
    expect(neither.json.error).toMatch(/name.*description/);
    expect(refresh).not.toHaveBeenCalled();
    await h.close();
  });

  it("a name the user set by hand is kept, and the call still saves the description", async () => {
    getDb().insert(pieces).values({ id: "p-hand", name: "Mine", description: "d", nameSetByUser: true } as never).run();
    const h = await connect();
    await h.call("libi.update_piece", { pieceId: "p-hand", name: "Agent name", description: "from the agent" });
    const row = getDb().select().from(pieces).all().find((p) => p.id === "p-hand")!;
    expect(row).toMatchObject({ name: "Mine", description: "from the agent" });
    await h.close();
  });
});
