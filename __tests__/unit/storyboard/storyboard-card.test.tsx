// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock @tanstack/react-query mutations used inside StoryboardCard so the card
// renders without a QueryClientProvider.
vi.mock("@/lib/queries/storyboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/storyboard")>();
  return {
    ...actual,
    useSelectTake: () => ({ mutate: vi.fn() }),
    useHideTake: () => ({ mutate: vi.fn() }),
    useUpdateGenParam: () => ({ mutate: vi.fn() }),
    useSetReference: () => ({ mutate: vi.fn() }),
    useSetSketchImage: () => ({ mutate: vi.fn() }),
  };
});

// The AddAssetMenu mounts useFiles + useFileUpload (useQuery). Stub them so no
// QueryClientProvider / network is needed for these render-only assertions.
vi.mock("@/lib/queries/files", () => ({
  useFiles: () => ({ data: [] }),
  useFileUpload: () => ({ upload: vi.fn(), isUploading: false }),
}));

import { StoryboardCard } from "@/components/storyboard/storyboard-card";
import type { StoryboardCard as Card } from "@/lib/storyboard/types";

const base: Card = {
  id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas", title: "Hook",
  sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
  camera: { shot: "medium", motion: "static" },
  promptFragment: "young editor to camera", voiceover: { line: "Everything you're watching?" },
  stage: "schematic", approvals: {},
};

// The options toggle persists per piece+card in localStorage; clear between tests
// so each render starts from the default (options hidden).
afterEach(() => window.localStorage.clear());

describe("StoryboardCard", () => {
  it("renders the title always; general options (shot, voiceover, prompt) are hidden by default and revealed by the toggle", () => {
    render(<StoryboardCard pieceId="p1" card={base} index={0} />);
    expect(screen.getByText(/Hook/)).toBeTruthy();
    // Hidden by default
    expect(screen.queryByText(/medium/)).toBeNull();
    expect(screen.queryByText(/Everything you're watching\?/)).toBeNull();
    expect(screen.queryByText(/young editor to camera/)).toBeNull();
    // Reveal
    fireEvent.click(screen.getByText(/Show options/));
    expect(screen.getByText(/medium/)).toBeTruthy();
    expect(screen.getByText(/Everything you're watching\?/)).toBeTruthy();
    expect(screen.getByText(/young editor to camera/)).toBeTruthy();
  });

  it("shows 'not on timeline' badge for a card with no selected take", () => {
    render(<StoryboardCard pieceId="p1" card={base} index={0} />);
    expect(screen.getByText(/not on timeline/)).toBeTruthy();
  });

  it("shows 'on timeline' badge when a take is selected", () => {
    const card: Card = {
      ...base,
      clips: [{ id: "t1", fileId: "f1", label: "1", createdAt: 0, hidden: false }],
      selectedClipId: "t1",
    };
    render(<StoryboardCard pieceId="p1" card={card} index={0} />);
    // The green badge text "on timeline" appears (may appear in tooltip span too)
    expect(screen.getAllByText("on timeline").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("not on timeline")).toHaveLength(0);
  });

  it("renders the sketches row (always present)", () => {
    render(<StoryboardCard pieceId="p1" card={base} index={0} />);
    // SketchesRow renders a "Sketches" group label
    expect(screen.getByText(/Sketches/)).toBeTruthy();
  });

  it("renders prompt from promptFragment when no clipGen (after revealing options)", () => {
    render(<StoryboardCard pieceId="p1" card={base} index={0} />);
    fireEvent.click(screen.getByText(/Show options/));
    expect(screen.getByText(/young editor to camera/)).toBeTruthy();
  });

  it("prefers clipGen.params.prompt over promptFragment (after revealing options)", () => {
    const card: Card = {
      ...base,
      promptFragment: "old prompt",
      clipGen: {
        apiUrl: "fal-ai/veo3",
        model: "veo3-fast",
        params: { prompt: "new clipgen prompt" },
      },
    };
    render(<StoryboardCard pieceId="p1" card={card} index={0} />);
    fireEvent.click(screen.getByText(/Show options/));
    expect(screen.getByText(/new clipgen prompt/)).toBeTruthy();
    expect(screen.queryByText(/old prompt/)).toBeNull();
  });

  it("renders the regenerate button when onPrefill is provided", () => {
    const onPrefill = vi.fn();
    render(<StoryboardCard pieceId="p1" card={base} index={0} onPrefill={onPrefill} />);
    expect(screen.getByText(/Regenerate clip/)).toBeTruthy();
  });

  it("does not render regenerate button without onPrefill", () => {
    render(<StoryboardCard pieceId="p1" card={base} index={0} />);
    expect(screen.queryByText(/Regenerate clip/)).toBeNull();
  });
});
