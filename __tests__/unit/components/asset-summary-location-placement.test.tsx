// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The asset has NO summary analysis — the case that hides anything placed
// inside StepStateGate, and the case this row must survive.
vi.mock("@/lib/queries/analysis", () => ({
  useVideoAnalysis: () => ({ data: { byKind: {}, summary: null } }),
}));

vi.mock("@/components/editor/asset-location-row", () => ({
  AssetLocationRow: ({ fileId }: { fileId: string }) => (
    <div data-testid="location-row-stub">{fileId}</div>
  ),
}));

// The Script tab (unlike Summary/Transcript/Frames) isn't behind
// StepStateGate, so with Tabs mocked to render every panel unconditionally
// it would otherwise mount for real and hit useLatestScript/useScriptJob
// (react-query) plus useEditorState/useDispatchToAgent with no providers in
// this test. None of that is relevant to where the location row sits, so
// stub it out — same approach as the AssetLocationRow mock above.
vi.mock("@/components/editor/script-tab-content", () => ({
  ScriptTabContent: () => <div data-testid="script-tab-stub" />,
}));

// The Notes tab also mounts unconditionally under the Tabs mock, and
// FileNotesTabBody calls useUpdateFileNotes (react-query) directly with no
// provider in this test. AssetLocationRow itself is stubbed above, so this
// only needs to cover the other export FileNotesTabBody pulls from the
// same module.
vi.mock("@/lib/queries/files", () => ({
  useUpdateFileNotes: () => ({ mutate: vi.fn() }),
}));

// Render TabsContent as a plain always-visible container. base-ui's Tabs.Panel
// only renders when the surrounding Root has a matching registered Tab, and
// this test is about WHERE the row sits relative to StepStateGate, not about
// base-ui's panel activation. StepStateGate itself stays real — its empty
// state is the whole point of the test.
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { AnalysisTabsBody } from "@/components/editor/asset-preview-panel";

const asset = {
  id: "f1",
  name: "clip.mp4",
  filename: "clip.mp4",
  contentType: "video/mp4",
} as never;

describe("Summary tab location placement", () => {
  it("renders the location row for an asset with no summary analysis", () => {
    render(<AnalysisTabsBody asset={asset} onSeek={() => {}} currentTime={0} />);

    // The analysis gate's empty state is showing…
    expect(screen.getByText(/No summary yet/i)).toBeTruthy();
    // …and the location row is showing anyway.
    expect(screen.getByTestId("location-row-stub").textContent).toBe("f1");
  });
});
