import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mcpLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { serverLogger } from "@/lib/logger";

let tmp: string;

beforeEach(() => {
  vi.mocked(serverLogger.info).mockClear();
  vi.mocked(serverLogger.warn).mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-housekeeping-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function touch(...parts: string[]): string {
  const p = path.join(tmp, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
  return p;
}

/** A revision dir libi installed itself: carries the installer's completion marker. */
function markedRevision(name: string): string {
  touch(name, "INSTALLATION_COMPLETE");
  return touch(name, ".libi-installed");
}

describe("pinnedChromiumRevisions", () => {
  it("reads the chromium revisions out of the installed playwright-core manifest", async () => {
    const { pinnedChromiumRevisions } = await import("@/lib/server/lifecycle/housekeeping");
    // `playwright-core`'s `exports` map does not expose `browsers.json`, so a
    // `require.resolve("playwright-core/browsers.json")` throws and an
    // implementation built on it would silently return [] — and the sweep
    // would never reclaim anything. This pins that the manifest resolves.
    const revisions = pinnedChromiumRevisions();
    expect(revisions.length).toBeGreaterThan(0);
    for (const r of revisions) expect(r).toMatch(/^\d+$/);
  });
});

describe("pruneStalePlaywrightRevisions", () => {
  it("removes a stale revision libi installed itself and keeps the pinned pair", async () => {
    const { pruneStalePlaywrightRevisions } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    markedRevision("chromium-1180");
    touch("chromium-1217", "INSTALLATION_COMPLETE");
    touch("chromium_headless_shell-1217", "INSTALLATION_COMPLETE");
    const { removed, kept } = pruneStalePlaywrightRevisions({
      cacheDir: tmp,
      pinnedRevisions: ["1217"],
    });
    expect(removed.map((p) => path.basename(p))).toEqual(["chromium-1180"]);
    expect(kept.map((p) => path.basename(p)).sort()).toEqual([
      "chromium-1217",
      "chromium_headless_shell-1217",
    ]);
    expect(fs.existsSync(path.join(tmp, "chromium-1180"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "chromium-1217"))).toBe(true);
  });

  it("leaves a stale revision alone when libi did not install it (the cache is shared)", async () => {
    const { pruneStalePlaywrightRevisions } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    // Another tool's browsers — e.g. the Playwright MCP's playwright-core 1.62
    // pins chromium-1234 — live in the same ms-playwright cache, unmarked.
    touch("chromium-1234", "INSTALLATION_COMPLETE");
    touch("chromium_headless_shell-1234", "INSTALLATION_COMPLETE");
    markedRevision("chromium-1180");
    const { removed, kept } = pruneStalePlaywrightRevisions({
      cacheDir: tmp,
      pinnedRevisions: ["1217"],
    });
    expect(removed.map((p) => path.basename(p))).toEqual(["chromium-1180"]);
    expect(kept.map((p) => path.basename(p)).sort()).toEqual([
      "chromium-1234",
      "chromium_headless_shell-1234",
    ]);
    expect(fs.existsSync(path.join(tmp, "chromium-1234"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "chromium_headless_shell-1234"))).toBe(true);
  });

  it("explains a skipped unmarked revision in the log so support can see why space stayed", async () => {
    const { pruneStalePlaywrightRevisions } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    touch("chromium-1234", "INSTALLATION_COMPLETE");
    pruneStalePlaywrightRevisions({ cacheDir: tmp, pinnedRevisions: ["1217"] });
    const skipped = vi
      .mocked(serverLogger.info)
      .mock.calls.filter(([fields]) => (fields as { reason?: string }).reason === "not-libi-installed");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![0]).toMatchObject({
      tag: "lifecycle",
      op: "prune",
      dir: path.join(tmp, "chromium-1234"),
      reason: "not-libi-installed",
    });
  });

  it("keeps the pinned revision even when libi marked it", async () => {
    const { pruneStalePlaywrightRevisions } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    markedRevision("chromium-1217");
    markedRevision("chromium_headless_shell-1217");
    const { removed, kept } = pruneStalePlaywrightRevisions({
      cacheDir: tmp,
      pinnedRevisions: ["1217"],
    });
    expect(removed).toEqual([]);
    expect(kept.map((p) => path.basename(p)).sort()).toEqual([
      "chromium-1217",
      "chromium_headless_shell-1217",
    ]);
    expect(fs.existsSync(path.join(tmp, "chromium-1217", ".libi-installed"))).toBe(true);
  });

  it("touches nothing that is not a browser revision directory", async () => {
    const { pruneStalePlaywrightRevisions } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    markedRevision("chromium-1180");
    touch("ffmpeg-1011", "INSTALLATION_COMPLETE");
    touch("b", "x");
    touch(".links", "abc.json");
    const { removed } = pruneStalePlaywrightRevisions({
      cacheDir: tmp,
      pinnedRevisions: ["1217"],
    });
    expect(removed.map((p) => path.basename(p))).toEqual(["chromium-1180"]);
    expect(fs.existsSync(path.join(tmp, "ffmpeg-1011"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "b"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, ".links"))).toBe(true);
  });

  it("is a no-op when the cache directory does not exist", async () => {
    const { pruneStalePlaywrightRevisions } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    expect(
      pruneStalePlaywrightRevisions({
        cacheDir: path.join(tmp, "nope"),
        pinnedRevisions: ["1217"],
      }),
    ).toEqual({ removed: [], kept: [] });
  });

  it("deletes nothing when the keep-set is empty (manifest unreadable)", async () => {
    const { pruneStalePlaywrightRevisions } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    markedRevision("chromium-1180");
    expect(
      pruneStalePlaywrightRevisions({ cacheDir: tmp, pinnedRevisions: [] }),
    ).toEqual({ removed: [], kept: [] });
    expect(fs.existsSync(path.join(tmp, "chromium-1180"))).toBe(true);
  });
});

describe("markLibiInstalled", () => {
  it("writes the marker the prune recognises, stamped with an ISO timestamp", async () => {
    const { LIBI_INSTALLED_MARKER, markLibiInstalled, pruneStalePlaywrightRevisions } =
      await import("@/lib/server/lifecycle/housekeeping");
    expect(LIBI_INSTALLED_MARKER).toBe(".libi-installed");
    const dir = path.join(tmp, "chromium-1180");
    touch("chromium-1180", "INSTALLATION_COMPLETE");

    markLibiInstalled(dir);

    const marker = path.join(dir, LIBI_INSTALLED_MARKER);
    expect(fs.existsSync(marker)).toBe(true);
    const stamp = fs.readFileSync(marker, "utf-8");
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(stamp))).toBe(false);

    const { removed } = pruneStalePlaywrightRevisions({
      cacheDir: tmp,
      pinnedRevisions: ["1217"],
    });
    expect(removed).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("markLibiInstalledRevisions", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
  });

  it("marks chromium-<rev> under the Playwright cache and returns what it marked", async () => {
    const { markLibiInstalledRevisions, LIBI_INSTALLED_MARKER } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    touch("chromium-1217", "INSTALLATION_COMPLETE");
    touch("chromium_headless_shell-1217", "INSTALLATION_COMPLETE");
    const marked = markLibiInstalledRevisions("1217");
    expect(marked).toEqual([path.join(tmp, "chromium-1217")]);
    expect(fs.existsSync(path.join(tmp, "chromium-1217", LIBI_INSTALLED_MARKER))).toBe(true);
    // The shell is only libi's when libi fetched it; the export installer
    // passes --no-shell, so by default it is left unclaimed.
    expect(
      fs.existsSync(path.join(tmp, "chromium_headless_shell-1217", LIBI_INSTALLED_MARKER)),
    ).toBe(false);
  });

  it("marks the headless shell too when the caller says it was fetched", async () => {
    const { markLibiInstalledRevisions, LIBI_INSTALLED_MARKER } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    touch("chromium-1217", "INSTALLATION_COMPLETE");
    touch("chromium_headless_shell-1217", "INSTALLATION_COMPLETE");
    const marked = markLibiInstalledRevisions("1217", ["chromium", "chromium_headless_shell"]);
    expect(marked.map((p) => path.basename(p)).sort()).toEqual([
      "chromium-1217",
      "chromium_headless_shell-1217",
    ]);
    expect(
      fs.existsSync(path.join(tmp, "chromium_headless_shell-1217", LIBI_INSTALLED_MARKER)),
    ).toBe(true);
  });

  it("skips a revision dir that does not exist instead of throwing", async () => {
    const { markLibiInstalledRevisions } = await import("@/lib/server/lifecycle/housekeeping");
    expect(markLibiInstalledRevisions("9999")).toEqual([]);
    expect(fs.existsSync(path.join(tmp, "chromium-9999"))).toBe(false);
  });
});

describe("pruneTrackingBuildInputs", () => {
  it("removes .build once the export it feeds exists", async () => {
    const { pruneTrackingBuildInputs } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    touch(".build", "mobileclip_blt.ts");
    touch("yoloe11.onnx");
    touch("yoloe11.onnx.build-info.json");
    const { removed } = pruneTrackingBuildInputs({ modelsDir: tmp });
    expect(removed.map((p) => path.basename(p))).toEqual([".build"]);
    expect(fs.existsSync(path.join(tmp, ".build"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "yoloe11.onnx"))).toBe(true);
  });

  it("keeps .build while the export is missing", async () => {
    const { pruneTrackingBuildInputs } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    touch(".build", "mobileclip_blt.ts");
    const { removed } = pruneTrackingBuildInputs({ modelsDir: tmp });
    expect(removed).toEqual([]);
    expect(fs.existsSync(path.join(tmp, ".build"))).toBe(true);
  });

  it("keeps .build when the export exists but its build-info marker does not", async () => {
    const { pruneTrackingBuildInputs } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    touch(".build", "mobileclip_blt.ts");
    touch("yoloe11.onnx");
    expect(pruneTrackingBuildInputs({ modelsDir: tmp }).removed).toEqual([]);
  });
});
