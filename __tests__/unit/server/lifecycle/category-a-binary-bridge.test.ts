import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { BinaryInstallProgress } from "@/mcp/registry/dependency-manager";
import type { LifecycleEvent } from "@/lib/server/lifecycle/types";

/**
 * The `installBinaryDeps` bridge in category-a.ts translates DependencyManager
 * progress into lifecycle events for the CLI spinner and the Electron splash.
 * A dep whose install token already matches is decided by a filesystem check,
 * not a download: it must land as a single `install-done`/skipped with NO
 * preceding `install-start`, or the splash flashes "downloading…" for
 * something that was never fetched.
 */
const progressScripts = vi.hoisted(() => ({ ticks: [] as BinaryInstallProgress[] }));

vi.mock("@/mcp/registry/dependency-manager", () => ({
  DependencyManager: class {
    setSkipDbWrites() {}
    async installBundledDeps(opts: { onProgress?: (p: BinaryInstallProgress) => void }) {
      for (const p of progressScripts.ticks) opts.onProgress?.(p);
      return [];
    }
  },
}));

describe("defaultCategoryADeps.installBinaryDeps — progress bridge", () => {
  let events: LifecycleEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    events = [];
    const { lifecycleEvents } = await import("@/lib/server/lifecycle/events");
    unsubscribe = lifecycleEvents.on((e) => events.push(e));
  });

  afterEach(() => {
    unsubscribe();
    progressScripts.ticks = [];
  });

  async function run() {
    const { defaultCategoryADeps } = await import("@/lib/server/lifecycle/category-a");
    await defaultCategoryADeps.installBinaryDeps();
    return events.filter((e) => e.kind.startsWith("category-a-install-"));
  }

  it("a skipped dep emits one install-done/skipped and never an install-start", async () => {
    progressScripts.ticks = [
      { binary: "ffmpeg", mcpId: "libi", status: "skipped", reason: "already installed" },
    ];
    const got = await run();
    expect(got).toEqual([
      {
        kind: "category-a-install-done",
        item: { id: "ffmpeg", label: "ffmpeg", kind: "binary" },
        result: "skipped",
        reason: "already installed",
      },
    ]);
  });

  it("a downloaded dep emits start → progress (bytes + detail) → done/installed, in order", async () => {
    progressScripts.ticks = [
      { binary: "ffprobe", mcpId: "libi", status: "downloading", bytesDownloaded: 10, bytesTotal: 100 },
      { binary: "ffprobe", mcpId: "libi", status: "downloading", bytesDownloaded: 20, bytesTotal: 100, detail: "download stalled — retrying (attempt 2 of 3)" },
      { binary: "ffprobe", mcpId: "libi", status: "done" },
    ];
    const got = await run();
    const item = { id: "ffprobe", label: "ffprobe", kind: "binary" };
    expect(got).toEqual([
      { kind: "category-a-install-start", item },
      { kind: "category-a-install-progress", item, bytesDownloaded: 10, bytesTotal: 100, detail: undefined },
      { kind: "category-a-install-progress", item, bytesDownloaded: 20, bytesTotal: 100, detail: "download stalled — retrying (attempt 2 of 3)" },
      { kind: "category-a-install-done", item, result: "installed" },
    ]);
  });
});
