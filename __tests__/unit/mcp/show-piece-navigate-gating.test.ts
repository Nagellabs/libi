/**
 * The editor must not be told to navigate to a piece that isn't there.
 *
 * This is the half of the 2026-08-21 show-piece fix (now `libi.show`'s `piece` target)
 * that does NOT live in `navigation-tools.ts`. Each registration in `mcp/server.ts` used to fire
 * `notify.navigate(...)` BEFORE calling the tool, so validating inside the tool
 * alone would still yank the editor toward a deleted piece and only report the
 * failure afterwards. The registration now calls the tool first and notifies
 * only on success.
 *
 * Asserted through a real MCP client against a real server, because the thing
 * being tested is the ORDER of two statements inside a registration closure —
 * unreachable from the tool function the other test file covers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibiMcpServer } from "@/mcp/server";
import { notify } from "@/mcp/notify";
import { pieces } from "@/lib/db/schema/sqlite";
import { createTestDb, resetTestDb } from "../../helpers/test-db";

const LIVE = "piece-live";

async function show(args: Record<string, unknown>) {
  const server = createLibiMcpServer();
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await client.callTool({ name: "libi.show", arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

let navigateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await createTestDb();
  const db = (await import("@/lib/db/client")).getDb();
  db.insert(pieces).values({ id: LIVE, name: "Live", description: "" }).run();
  navigateSpy = vi.spyOn(notify, "navigate").mockImplementation(() => {});
});

afterEach(() => {
  navigateSpy.mockRestore();
  resetTestDb();
});

describe.each(["piece", "preview", "storyboard"] as const)("libi.show target %s", (target) => {
  it("fires notify.navigate for a piece that exists", async () => {
    await show({ target, pieceId: LIVE });
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy.mock.calls[0][0]).toMatchObject({ target, pieceId: LIVE });
  });

  it("does NOT fire notify.navigate for a deleted piece", async () => {
    const result = await show({ target, pieceId: "deleted-id" });
    expect(navigateSpy).not.toHaveBeenCalled();
    // …and the agent is told plainly, rather than getting a bare success.
    expect(JSON.stringify(result)).toContain("piece_not_found");
  });
});

describe("libi.show target asset", () => {
  it("does NOT fire notify.navigate when the piece is gone", async () => {
    await show({ target: "asset", pieceId: "deleted-id", fileId: "f1" });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire notify.navigate when the file is gone", async () => {
    await show({ target: "asset", pieceId: LIVE, fileId: "no-such-file" });
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

describe("libi.show target folder", () => {
  it("does NOT fire notify.navigate for a folder that does not exist", async () => {
    const result = await show({ target: "folder", folderId: "no-such-folder" });
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("folder_not_found");
  });
});

describe("libi.show: a call that names no target, or the wrong fields for it", () => {
  it("says which targets exist, and which fields the target needs", async () => {
    const none = await show({ pieceId: LIVE });
    expect(none.isError).toBe(true);
    const asset = await show({ target: "asset", pieceId: LIVE });
    expect(asset.isError).toBe(true);
    const text = (JSON.parse((asset.content as Array<{ text: string }>)[0].text) as { error: string }).error;
    expect(text).toContain('libi.show({ target: "asset" })');
    expect(text).toContain("asset requires: pieceId, fileId");
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
