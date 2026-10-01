// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_EXPORT_SORT,
  EXPORT_SORT_KEY,
  activeLine,
  activePercent,
  aspectsPresent,
  exportsForTree,
  filterExports,
  formatBytes,
  formatDuration,
  loadExportSort,
  saveExportSort,
  sortExports,
  visibleInTab,
} from "@/lib/exports/list-view";
import type { ExportRecordView } from "@/lib/exports/types";

const row = (over: Partial<ExportRecordView>): ExportRecordView =>
  ({ id: "x", name: "x", status: "done", aspect: "9:16", queuedAt: 0, completedAt: null, progress: null, waiting: null, missing: false, ...over }) as ExportRecordView;

const A = row({ id: "a", name: "banana", queuedAt: 1000, completedAt: 3000, aspect: "9:16" });
const B = row({ id: "b", name: "Apple", queuedAt: 2000, completedAt: 2500, aspect: "16:9" });
const C = row({ id: "c", name: "cherry", queuedAt: 4000, completedAt: null, status: "running", aspect: "9:16" });

beforeEach(() => localStorage.clear());

describe("sorting", () => {
  it("defaults to time, oldest first, and remembers the choice under libi:exports-sort", () => {
    expect(DEFAULT_EXPORT_SORT).toBe("time-asc");
    expect(loadExportSort()).toBe("time-asc");
    saveExportSort("z-a");
    expect(localStorage.getItem(EXPORT_SORT_KEY)).toBe("z-a");
    expect(loadExportSort()).toBe("z-a");
    localStorage.setItem(EXPORT_SORT_KEY, "bogus");
    expect(loadExportSort()).toBe("time-asc");
  });

  it("a stored object-prototype key is not a sort: it falls back to the default", () => {
    for (const bogus of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      localStorage.setItem(EXPORT_SORT_KEY, bogus);
      expect(loadExportSort()).toBe("time-asc");
    }
  });

  it("orders by queue time, or by name", () => {
    const ids = (s: Parameters<typeof sortExports>[1]) => sortExports([A, B, C], s).map((r) => r.id);
    expect(ids("time-asc")).toEqual(["a", "b", "c"]);
    expect(ids("time-desc")).toEqual(["c", "b", "a"]);
    expect(ids("a-z")).toEqual(["b", "a", "c"]);
    expect(ids("z-a")).toEqual(["c", "a", "b"]);
  });
});

describe("time sort is by queue time, never finish time", () => {
  it("a batch queued 1..6 lists in queue order however it finished, and a running row sorts by its queue time", () => {
    const finishOrder = [5, 4, 3, 1, 2];
    const done = [1, 2, 3, 4, 5].map((n) => row({ id: `b${n}`, name: `Batch ${n}`, queuedAt: 1000 + n, completedAt: 9000 + finishOrder.indexOf(n) }));
    const running = row({ id: "b6", name: "Batch 6", status: "running", queuedAt: 1006, completedAt: null });
    const rows = [running, ...done.reverse()];
    expect(sortExports(rows, "time-asc").map((r) => r.name)).toEqual(["Batch 1", "Batch 2", "Batch 3", "Batch 4", "Batch 5", "Batch 6"]);
    expect(sortExports(rows, "time-desc").map((r) => r.name)).toEqual(["Batch 6", "Batch 5", "Batch 4", "Batch 3", "Batch 2", "Batch 1"]);
  });

  it("equal queue times fall back to the name, in both directions", () => {
    const rows = [row({ id: "x2", name: "Batch 2", queuedAt: 5 }), row({ id: "x10", name: "Batch 10", queuedAt: 5 }), row({ id: "x1", name: "Batch 1", queuedAt: 5 })];
    expect(sortExports(rows, "time-asc").map((r) => r.name)).toEqual(["Batch 1", "Batch 2", "Batch 10"]);
    expect(sortExports(rows, "time-desc").map((r) => r.name)).toEqual(["Batch 10", "Batch 2", "Batch 1"]);
  });

  it("the resources folder follows the same key", () => {
    const x = row({ id: "x", name: "X", queuedAt: 1, completedAt: 900 });
    const y = row({ id: "y", name: "Y", queuedAt: 2, completedAt: 100 });
    expect(exportsForTree([y, x], "created-asc").map((r) => r.id)).toEqual(["x", "y"]);
    expect(exportsForTree([x, y], "created-desc").map((r) => r.id)).toEqual(["y", "x"]);
  });
});

describe("filtering", () => {
  it("by aspect and by a case-insensitive name substring", () => {
    expect(filterExports([A, B, C], { aspect: "9:16", search: "" }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterExports([A, B, C], { aspect: "all", search: "APP" }).map((r) => r.id)).toEqual(["b"]);
  });

  it("offers only the aspects present, in the canonical order", () => {
    expect(aspectsPresent([C, B, A])).toEqual(["9:16", "16:9"]);
  });

  it("the tab hides cancelled exports", () => {
    expect(visibleInTab([A, row({ id: "z", status: "cancelled" })]).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("the resources folder", () => {
  it("lists done exports only, by the inner sort (created ↔ queue time)", () => {
    expect(exportsForTree([A, B, C], "created-asc").map((r) => r.id)).toEqual(["a", "b"]);
    expect(exportsForTree([A, B, C], "created-desc").map((r) => r.id)).toEqual(["b", "a"]);
    expect(exportsForTree([A, B, C], "a-z").map((r) => r.id)).toEqual(["b", "a"]);
    expect(exportsForTree([A, B, C], "a-z", "ban").map((r) => r.id)).toEqual(["a"]);
  });
});

describe("formatting", () => {
  it("sizes, lengths and an active export's line", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(65.4)).toBe("1:05");
    expect(activeLine(row({ status: "running", waiting: { reason: "memory", message: "Waiting for memory — 2 exports running" } }))).toBe(
      "Waiting for memory — 2 exports running",
    );
    expect(activeLine(row({ status: "running", progress: { done: 40, total: 100, unit: "%", etaMs: null } }))).toBe("Exporting 40%");
    expect(activeLine(row({ status: "running", progress: { done: 87, total: 173, unit: "MB", etaMs: null } }))).toBe("Downloading Chromium… 87/173 MB");
    expect(activeLine(row({ status: "queued" }))).toBe("Queued");
    expect(activePercent(row({ status: "running", progress: { done: 40, total: 100, unit: "%", etaMs: null } }))).toBe(40);
    expect(activePercent(row({ status: "running", progress: { done: 0, total: 1, unit: "waiting", etaMs: null } }))).toBeNull();
  });
});
