// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * The Exports tab's running-count badge: how many of THIS piece's exports are
 * queued or running (finished, failed and cancelled ones don't count). The
 * panel's children are stubs — only the tab row is under test.
 */
const exportsState = vi.hoisted(() => ({ data: [] as { status: string }[] | undefined }));
vi.mock("@/lib/queries/exports", () => ({ useExports: () => exportsState }));
vi.mock("@/lib/preview/telemetry", () => ({ useReactRenderTelemetry: () => {} }));
const stub = vi.hoisted(() => (name: string) => {
  const Stub = () => <div data-testid={name} />;
  Stub.displayName = name;
  return Stub;
});
vi.mock("@/components/editor/asset-explorer", () => ({ AssetExplorer: stub("asset-explorer") }));
vi.mock("@/components/editor/piece-objects-tab", () => ({ PieceObjectsTab: stub("objects") }));
vi.mock("@/components/editor/posting-tab", () => ({ PostingTab: stub("posting") }));
vi.mock("@/components/editor/exports-tab", () => ({ ExportsTab: stub("exports-tab") }));
vi.mock("@/components/storyboard/storyboard-tab", () => ({ StoryboardTab: stub("storyboard") }));
vi.mock("@/components/editor/snapshot-banner", () => ({ SnapshotBanner: stub("banner") }));
vi.mock("@/components/editor/snapshot-draft-switcher", () => ({ SnapshotDraftSwitcher: stub("switcher") }));

import EditorPanel from "@/components/editor/editor-panel";

function renderPanel(previewArea: ReactNode = <div />) {
  return render(
    <EditorPanel
      activeTab="preview"
      onTabChange={() => {}}
      onSelectAsset={() => {}}
      previewArea={previewArea}
      pieceId="p1"
      selectedExportId={null}
      onSelectExport={() => {}}
    />,
  );
}

beforeEach(() => {
  exportsState.data = [];
});

describe("EditorPanel — Exports tab badge", () => {
  it("shows the count of queued and running exports", () => {
    exportsState.data = [{ status: "queued" }, { status: "running" }, { status: "done" }, { status: "failed" }];
    renderPanel();
    expect(screen.getByTestId("exports-running-badge")).toHaveTextContent("2");
  });

  it("shows nothing when none is running, or while the list is still loading", () => {
    exportsState.data = [{ status: "done" }];
    const { unmount } = renderPanel();
    expect(screen.queryByTestId("exports-running-badge")).toBeNull();
    unmount();
    exportsState.data = undefined;
    renderPanel();
    expect(screen.queryByTestId("exports-running-badge")).toBeNull();
  });
});
