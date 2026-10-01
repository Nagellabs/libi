import { describe, it, expect, vi } from "vitest";
import { openExportInTab, subscribeOpenExport } from "@/hooks/exports/use-open-export";

describe("openExportInTab", () => {
  it("delivers to the editor page when it listens", () => {
    const seen = vi.fn();
    const off = subscribeOpenExport(seen);
    openExportInTab({ pieceId: "p1", exportId: "e1" });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ pieceId: "p1", exportId: "e1" }));
    off();
  });

  it("parks an intent made while nobody listens, and hands it to the next subscriber once", async () => {
    openExportInTab({ pieceId: "p2" });
    const seen = vi.fn();
    const off = subscribeOpenExport(seen);
    await Promise.resolve();
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ pieceId: "p2", exportId: null }));
    off();
    const again = vi.fn();
    const off2 = subscribeOpenExport(again);
    await Promise.resolve();
    expect(again).not.toHaveBeenCalled();
    off2();
  });
});
