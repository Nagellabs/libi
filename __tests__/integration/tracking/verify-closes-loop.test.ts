/**
 * Integration: a successful `libi.verify_install` (engine truly installed)
 * must PERSIST `tracking-pyenv` as installed in the SAME source the lazy
 * gate consults — the `libi` MCP row's `dependencyStatus` JSON that
 * `requireDeps("libi", ["tracking-pyenv"])` reads.
 *
 * Bug repro (end-to-end dogfood): the engine was installed on disk (token
 * marker present, selftest ok), but tracking tool calls were still blocked
 * because the `libi` row's `dependencyStatus` never gained a `tracking-pyenv`
 * entry — tier-2 deps are never auto-verified at boot and verify_install was
 * read-only. The agent had to hand-patch `~/.libi/libi.sqlite`.
 *
 * This test asserts the loop now closes: with the token marker present but
 * the dep registry showing `tracking-pyenv` absent/pending, GET
 * /api/tracking/verify returns ok AND afterwards `requireDeps` (the exact
 * function the `computeObjectTrack` lazy gate calls) reports nothing missing.
 *
 * `runEngineSelftest` spawns `uv` — mocked here so the verify path returns
 * ok deterministically (same approach verify-install.test.ts takes for the
 * server-unreachable case: don't depend on a real engine in unit/integration
 * context).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { seedDatabase } from "@/lib/db/init";
import { TRACKING_PYENV_TOKEN } from "@/mcp/registry/installers/tracking-pyenv";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

// The verify route runs the selftest via uv — mock it so the test never
// shells out to a real env. ok:true exercises the loop-closing write.
vi.mock("@/lib/tracking/engine-selftest", () => ({
  runEngineSelftest: vi.fn(async () => ({
    ok: true,
    versions: { onnxruntime: "1.20.0", boxmot: "13.0.0" },
  })),
}));

import { getDb } from "@/lib/db/client";
import { requireDeps } from "@/lib/dependencies/require-deps";
import { GET } from "@/app/api/tracking/verify/route";

let db: ReturnType<typeof createTestDb>;
let tmp: string;

beforeEach(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  tmp = await mkdtemp(join(tmpdir(), "libi-vcl-"));
  process.env.LIBI_HOME = tmp;

  db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);
  seedDatabase(db as never);

  // Engine genuinely installed on disk: write the token marker at
  // ~/.libi/models/tracking/.install-token (= trackingModelsDir()).
  const markerDir = path.join(tmp, "models", "tracking");
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, ".install-token"), TRACKING_PYENV_TOKEN, "utf-8");
});

afterEach(async () => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  const { rm } = await import("node:fs/promises");
  await rm(tmp, { recursive: true, force: true });
});

describe("verify_install closes the lazy-install loop", () => {
  it("before verify: the lazy gate reports tracking-pyenv missing on the libi row", () => {
    // seedDatabase() created the libi row but never wrote a tracking-pyenv
    // entry to its dependencyStatus — the bug's starting state.
    const missing = requireDeps("libi", ["tracking-pyenv"]);
    expect(missing).toHaveLength(1);
    expect(missing[0].binary).toBe("tracking-pyenv");
  });

  it("a successful verify persists tracking-pyenv installed on the libi row (loop closed)", async () => {
    const res = await GET();
    const body = (await res.json()) as {
      ok: boolean;
      installed: boolean;
      missing: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.installed).toBe(true);

    // The decisive assertion: query the EXACT source the computeObjectTrack
    // lazy gate consults. After a successful verify it must report nothing
    // missing — so a tracking job would NOT throw dependency_not_ready /
    // tracking_engine_not_installed, with no manual sqlite patch.
    const missing = requireDeps("libi", ["tracking-pyenv"]);
    expect(missing).toHaveLength(0);

    // And the row's persisted JSON carries the installed entry.
    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "libi"))
      .all()[0];
    const deps = JSON.parse(row.dependencyStatus ?? "[]") as Array<{
      binary: string;
      installed: boolean;
      runtimeStatus: string;
    }>;
    const entry = deps.find((d) => d.binary === "tracking-pyenv");
    expect(entry?.installed).toBe(true);
    expect(entry?.runtimeStatus).toBe("installed");
  });

  it("does NOT clobber other libi deps already in dependencyStatus", async () => {
    // Pretend Category A already settled ffmpeg on the libi row.
    db.update(mcpServers)
      .set({
        dependencyStatus: JSON.stringify([
          { binary: "ffmpeg", installed: true, path: "/x/ffmpeg", source: "bundled", runtimeStatus: "installed" },
        ]),
      })
      .where(eq(mcpServers.id, "libi"))
      .run();

    await GET();

    const row = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "libi"))
      .all()[0];
    const deps = JSON.parse(row.dependencyStatus ?? "[]") as Array<{ binary: string }>;
    const bins = deps.map((d) => d.binary).sort();
    expect(bins).toEqual(["ffmpeg", "tracking-pyenv"]);
  });
});
