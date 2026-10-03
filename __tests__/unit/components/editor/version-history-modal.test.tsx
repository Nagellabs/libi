// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const versions: Array<{ id: string; kind: string; committedAt: number | null }> = [];
const kept: Array<{ id: string; kind: string; keptAt: number; overlays: number; audioClips: number }> = [];
const restoreMutate = vi.fn();
vi.mock("@/lib/queries/snapshots", () => {
  const mutationStub = () => ({ mutate: vi.fn(), isPending: false, isIdle: true });
  return mockedSnapshots(mutationStub);
});
function mockedSnapshots(mutationStub: () => unknown) {
  return {
  useVersionHistory: () => ({ data: { versions } }),
  useRecoverableDrafts: () => ({ data: { drafts: kept, days: 7 } }),
  useVersionDiff: (_p: string, selectedId: string | null) => ({
    data: selectedId ? { id: selectedId } : undefined,
    isLoading: false,
  }),
    useCommitDraft: mutationStub,
    useDiscardDraft: mutationStub,
    useRestoreSnapshot: () => ({ mutate: restoreMutate, isPending: false, isIdle: true }),
  };
}
vi.mock("@/components/editor/version-detail-panel", () => ({
  VersionDetailPanel: ({ data }: { data?: { id?: string } }) => (
    <div data-testid="detail">{data?.id ?? "none"}</div>
  ),
}));
vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));

import { VersionHistoryModal } from "@/components/editor/version-history-modal";

/**
 * The default selection (draft if present, else current snapshot) is applied
 * during render (previous-state pattern, self-limiting) — replacing the old
 * setState-in-effect. These tests pin the selection defaults.
 */
describe("VersionHistoryModal", () => {
  beforeEach(() => {
    versions.length = 0;
    kept.length = 0;
    restoreMutate.mockReset();
  });

  it("defaults the selection to the draft when one exists", () => {
    versions.push(
      { id: "draft-1", kind: "draft", committedAt: null },
      { id: "snap-1", kind: "snapshot", committedAt: 1700000000 },
    );
    render(<VersionHistoryModal pieceId="p1" open onOpenChange={() => {}} />);
    expect(screen.getByTestId("detail")).toHaveTextContent("draft-1");
  });

  it("falls back to the current snapshot when there is no draft", () => {
    versions.push(
      { id: "snap-1", kind: "snapshot", committedAt: 1700000000 },
      { id: "snap-0", kind: "history", committedAt: 1600000000 },
    );
    render(<VersionHistoryModal pieceId="p1" open onOpenChange={() => {}} />);
    expect(screen.getByTestId("detail")).toHaveTextContent("snap-1");
  });

  it("renders nothing selected when closed", () => {
    versions.push({ id: "snap-1", kind: "snapshot", committedAt: 1700000000 });
    render(<VersionHistoryModal pieceId="p1" open={false} onOpenChange={() => {}} />);
    expect(screen.queryByTestId("detail")).not.toBeInTheDocument();
  });

  describe("recoverable drafts", () => {
    it("lists what a discard or restore set aside, each with a Restore button that restores its rec- id", () => {
      versions.push({ id: "draft-1", kind: "draft", committedAt: null }, { id: "snap-1", kind: "snapshot", committedAt: 1700000000 });
      kept.push(
        { id: "rec-abc", kind: "discarded", keptAt: 1700000100, overlays: 3, audioClips: 1 },
        { id: "rec-def", kind: "before-restore", keptAt: 1700000000, overlays: 1, audioClips: 0 },
      );
      render(<VersionHistoryModal pieceId="p1" open onOpenChange={() => {}} />);
      const rows = screen.getAllByTestId("recoverable-draft");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent("Discarded draft");
      expect(rows[0]).toHaveTextContent("3 layers");
      expect(rows[0]).toHaveTextContent("1 audio clip");
      expect(rows[1]).toHaveTextContent("Draft before a restore");
      fireEvent.click(within(rows[0]).getByRole("button", { name: "Restore" }));
      expect(restoreMutate).toHaveBeenCalledTimes(1);
      expect(restoreMutate.mock.calls[0][0]).toEqual({ pieceId: "p1", snapshotId: "rec-abc" });
    });

    it("shows no such section when nothing was set aside", () => {
      versions.push({ id: "snap-1", kind: "snapshot", committedAt: 1700000000 });
      render(<VersionHistoryModal pieceId="p1" open onOpenChange={() => {}} />);
      expect(screen.queryByTestId("recoverable-drafts")).not.toBeInTheDocument();
    });

    it("the Discard tooltip no longer says it cannot be undone", () => {
      versions.push({ id: "draft-1", kind: "draft", committedAt: null });
      render(<VersionHistoryModal pieceId="p1" open onOpenChange={() => {}} />);
      expect(document.body.textContent).not.toMatch(/can.?t be undone/i);
    });
  });
});
