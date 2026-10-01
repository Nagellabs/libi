// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

// The Posting tab is a client component; only its pure mapping is under test.
vi.mock("@/lib/queries/exports", () => ({ useExports: () => ({ data: [] }) }));

import { latestExportsOf } from "@/components/editor/posting-tab";
import type { ExportRecordView } from "@/lib/exports/types";

const view = (over: Partial<ExportRecordView>): ExportRecordView =>
  ({
    id: "e", name: "e", aspect: "9:16", status: "done", missing: false, path: "/s/p1/exports/e.mp4", width: 1080, height: 1920, sizeBytes: 10,
    durationSec: 3, completedAt: 0, purpose: "social", excludedFileIds: ["song"], carriesCopyrighted: false, ...over,
  }) as ExportRecordView;

describe("latestExportsOf — the Posting tab's past exports come from the export records", () => {
  it("finished exports on disk, newest first, with the audio each carries", () => {
    const out = latestExportsOf([
      view({ id: "old", path: "/s/p1/exports/old.mp4", completedAt: 1 }),
      view({ id: "new", path: "/s/p1/exports/new.mp4", completedAt: 2, purpose: "personal", excludedFileIds: [], carriesCopyrighted: true }),
      view({ id: "gone", path: "/s/p1/exports/gone.mp4", completedAt: 3, missing: true }),
      view({ id: "running", status: "running", completedAt: null, path: null }),
      view({ id: "queued", status: "queued", completedAt: null, path: null }),
      view({ id: "failed", status: "failed", completedAt: 4 }),
      view({ id: "cancelled", status: "cancelled", completedAt: 5 }),
    ]);
    expect(out.map((e) => e.filePath)).toEqual(["/s/p1/exports/new.mp4", "/s/p1/exports/old.mp4"]);
    // The picker's labels: the record's id, name and aspect travel with the file.
    expect(out[0]).toEqual({
      exportId: "new", name: "e", aspect: "9:16", filePath: "/s/p1/exports/new.mp4", width: 1080, height: 1920, sizeBytes: 10, durationSeconds: 3,
      audioDecision: { purpose: "personal", excludedFileIds: [], carriesCopyrighted: true },
    });
  });
});
