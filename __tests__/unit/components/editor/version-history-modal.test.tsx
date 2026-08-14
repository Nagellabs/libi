// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const versions: Array<{ id: string; kind: string; committedAt: number | null }> = [];
vi.mock("@/lib/queries/snapshots", () => {
  const mutationStub = () => ({ mutate: vi.fn(), isPending: false, isIdle: true });
  return mockedSnapshots(mutationStub);
});
function mockedSnapshots(mutationStub: () => unknown) {
  return {
  useVersionHistory: () => ({ data: { versions } }),
  useVersionDiff: (_p: string, selectedId: string | null) => ({
    data: selectedId ? { id: selectedId } : undefined,
    isLoading: false,
  }),
    useCommitDraft: mutationStub,
    useDiscardDraft: mutationStub,
    useRestoreSnapshot: mutationStub,
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
});
