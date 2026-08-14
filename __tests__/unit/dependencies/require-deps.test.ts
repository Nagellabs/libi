import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { seedDatabase } from "@/lib/db/init";

describe("requireDeps", () => {
  beforeEach(() => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
  });

  afterEach(() => {
    resetTestDb();
    vi.mocked(getDb).mockReset();
  });

  it("returns empty array when all deps are installed", async () => {
    const db = vi.mocked(getDb)();
    db
      .update(mcpServers)
      .set({
        dependencyStatus: JSON.stringify([
          { binary: "ffmpeg", installed: true, runtimeStatus: "installed" },
          { binary: "chromium", installed: true, runtimeStatus: "installed" },
        ]),
      })
      .where(eq(mcpServers.id, "libi"))
      .run();

    const { requireDeps } = await import("@/lib/dependencies/require-deps");
    const missing = await requireDeps("libi", ["ffmpeg", "chromium"]);
    expect(missing).toEqual([]);
  });

  it("returns missing dep names with their runtimeStatus", async () => {
    const db = vi.mocked(getDb)();
    db
      .update(mcpServers)
      .set({
        dependencyStatus: JSON.stringify([
          { binary: "ffmpeg", installed: true, runtimeStatus: "installed" },
          {
            binary: "chromium",
            installed: false,
            runtimeStatus: "installing",
            bytesDownloaded: 100,
            bytesTotal: 500,
          },
          {
            binary: "mediapipe-vision",
            installed: false,
            runtimeStatus: "failed",
            error: "boom",
          },
        ]),
      })
      .where(eq(mcpServers.id, "libi"))
      .run();

    const { requireDeps } = await import("@/lib/dependencies/require-deps");
    const missing = await requireDeps("libi", [
      "chromium",
      "mediapipe-vision",
      "ffmpeg",
    ]);
    expect(missing).toEqual([
      {
        binary: "chromium",
        runtimeStatus: "installing",
        error: null,
        bytesDownloaded: 100,
        bytesTotal: 500,
      },
      {
        binary: "mediapipe-vision",
        runtimeStatus: "failed",
        error: "boom",
      },
    ]);
  });

  it("returns pending entries when the mcp row is missing entirely", async () => {
    const { requireDeps } = await import("@/lib/dependencies/require-deps");
    const missing = await requireDeps("nonexistent-mcp", ["ffmpeg"]);
    expect(missing).toEqual([
      { binary: "ffmpeg", runtimeStatus: "pending", error: "mcp row missing" },
    ]);
  });
});
