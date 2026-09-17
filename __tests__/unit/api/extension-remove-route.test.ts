// `POST /api/settings/mcp-servers/<id>/remove` — the server half of reclaiming extension disk.
//
// Two things it must get right beyond deleting files: it may only ever act on
// an extension that owns its files exclusively, and it must clear a row parked
// at `failed` BEFORE re-settling — `settleInstallStatus` short-circuits on
// `failed` and would otherwise report the old status over an empty disk.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { removeFiles, settle, rows, updates } = vi.hoisted(() => ({
  removeFiles: vi.fn(() => ({ removed: ["/models/tts/kokoro"], freedBytes: 121_000_000 })),
  settle: vi.fn(async () => "pending"),
  rows: new Map<string, { id: string; installStatus: string }>([
    ["local-tts", { id: "local-tts", installStatus: "failed" }],
    ["libi-export", { id: "libi-export", installStatus: "installed" }],
  ]),
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/mcp/registry/extension-uninstall", async (orig) => ({
  ...(await orig<typeof import("@/mcp/registry/extension-uninstall")>()),
  removeExtensionFiles: removeFiles,
}));
vi.mock("@/mcp/registry/dependency-manager", () => ({
  DependencyManager: class {
    settleInstallStatus = settle;
  },
}));
vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mcpLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let selectedId = "";
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (w: { queryChunks?: unknown }) => ({
          limit: () => ({
            all: () => {
              const row = rows.get(selectedId);
              return row ? [row] : [];
            },
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({ run: () => updates.push(values) }),
      }),
    }),
  }),
}));
vi.mock("drizzle-orm", async (orig) => ({
  ...(await orig<typeof import("drizzle-orm")>()),
  eq: (_col: unknown, value: string) => {
    selectedId = value;
    return {};
  },
}));

import { POST as removeRoute } from "@/app/api/settings/mcp-servers/[id]/remove/route";

const call = (id: string) =>
  removeRoute(new Request("http://x/api", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  updates.length = 0;
  removeFiles.mockClear();
  settle.mockClear();
});

describe("POST /api/settings/mcp-servers/[id]/remove", () => {
  it("deletes the files and reports what it freed", async () => {
    const res = await call("local-tts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, freedBytes: 121_000_000 });
    expect(removeFiles).toHaveBeenCalledWith("local-tts");
  });

  it("clears a `failed` row before re-settling it, then re-derives from disk", async () => {
    await call("local-tts");
    expect(updates[0]).toMatchObject({ installStatus: "pending", installError: null });
    expect(settle).toHaveBeenCalledWith("local-tts");
  });

  it("refuses an extension whose dependencies are shared", async () => {
    const res = await call("libi-export");
    expect(res.status).toBe(400);
    expect(removeFiles).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("404s an id that is not an MCP row at all", async () => {
    const res = await call("not-a-thing");
    expect(res.status).toBe(404);
    expect(removeFiles).not.toHaveBeenCalled();
  });
});
