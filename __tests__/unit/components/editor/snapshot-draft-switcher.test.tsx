// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({ viewMode: "draft", setViewMode: vi.fn(), sessionList: { activeSessionId: null } }),
}));
vi.mock("@/lib/queries/snapshots", () => ({
  usePieceState: () => ({ data: { hasDraft: true } }),
  useCommitDraft: () => ({ mutate: vi.fn() }),
  useDiscardDraft: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/components/editor/version-history-modal", () => ({ VersionHistoryModal: () => null }));
vi.mock("@/components/editor/save-snapshot-popover", () => ({ SaveSnapshotPopover: () => null }));

import { SnapshotDraftSwitcher } from "@/components/editor/snapshot-draft-switcher";

describe("SnapshotDraftSwitcher discard", () => {
  it("the confirmation says the draft is kept 7 days and where to bring it back — never that it cannot be undone", async () => {
    render(<SnapshotDraftSwitcher pieceId="p1" />);
    fireEvent.keyDown(document, { key: "z", shiftKey: true, metaKey: true });
    fireEvent.keyDown(document, { key: "z", shiftKey: true, ctrlKey: true });
    const text = await screen.findByText(/libi keeps the discarded draft for 7 days/);
    expect(text).toBeInTheDocument();
    expect(text.textContent).toMatch(/Version history → Recoverable drafts/);
    expect(document.body.textContent).not.toMatch(/can.?t be undone/i);
  });
});
