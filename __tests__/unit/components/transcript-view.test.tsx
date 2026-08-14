// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AnalysisViewer } from "@/components/editor/analysis-viewer";
import type { TranscriptSentence } from "@/lib/analysis/types";
import type { AnalysisStep } from "@/lib/analysis/types";
import type { AnalysisQueryView } from "@/lib/queries/analysis";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const NOW = new Date();

function makeTranscriptStep(content: string): AnalysisStep {
  return {
    id: "step-1",
    fileId: "file-1",
    pieceId: null,
    kind: "transcript",
    status: "ready",
    content,
    metadata: null,
    errorMessage: null,
    sourceModifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const THREE_SENTENCES: TranscriptSentence[] = [
  { text: "I'm just finishing work.", start: 0, end: 2.5, wordIndices: [0, 3], speakerId: null },
  { text: "I've got ten minutes before.", start: 3, end: 6, wordIndices: [4, 8], speakerId: null },
  { text: "And then I noticed my nails.", start: 8, end: 11, wordIndices: [9, 14], speakerId: null },
];

const FULL_TRANSCRIPT =
  "I'm just finishing work. I've got ten minutes before. And then I noticed my nails.";

// ──────────────────────────────────────────────────────────────────────────────
// Mock the hooks so AnalysisViewer renders our fixture data
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/queries/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/analysis")>();
  return {
    ...actual,
    useVideoAnalysis: vi.fn(),
    useSearchFrames: vi.fn(() => ({ data: undefined })),
  };
});

import { useVideoAnalysis } from "@/lib/queries/analysis";

function buildQueryData(
  step: AnalysisStep | null,
  sentences: TranscriptSentence[] | null,
): AnalysisQueryView {
  return {
    steps: step ? [step] : [],
    keyframes: [],
    staleKeyframeIds: [],
    byKind: step ? { transcript: step } : {},
    summary: null,
    transcript: step,
    framesWithDesc: [],
    transcriptMeta: null,
    transcriptSentences: sentences,
  };
}

function renderTranscriptTab(
  step: AnalysisStep | null,
  sentences: TranscriptSentence[] | null,
  onSeek?: (t: number) => void,
  currentTime?: number,
) {
  vi.mocked(useVideoAnalysis).mockReturnValue({
    data: buildQueryData(step, sentences),
    isLoading: false,
  } as unknown as ReturnType<typeof useVideoAnalysis>);

  render(<AnalysisViewer fileId="file-1" onSeek={onSeek} currentTime={currentTime} />);

  // AnalysisViewer defaults to the "summary" tab — click Transcript to activate it
  const transcriptTab = screen.getByRole("tab", { name: /transcript/i });
  fireEvent.click(transcriptTab);
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("TranscriptView", () => {
  it("1. renders 'No transcript yet' when no step", () => {
    renderTranscriptTab(null, null);
    expect(screen.getByText(/no transcript yet/i)).toBeInTheDocument();
  });

  it("2. step only, no sentences — renders full paragraph; no table rows", () => {
    renderTranscriptTab(makeTranscriptStep(FULL_TRANSCRIPT), null);
    expect(screen.getByText(FULL_TRANSCRIPT)).toBeInTheDocument();
    // No timecodes present (table is absent)
    expect(screen.queryByText("00:00")).not.toBeInTheDocument();
  });

  it("3. step + 3 sentences — renders paragraph AND all 3 rows with timecodes", () => {
    renderTranscriptTab(makeTranscriptStep(FULL_TRANSCRIPT), THREE_SENTENCES);

    // Paragraph present
    expect(screen.getByText(FULL_TRANSCRIPT)).toBeInTheDocument();

    // Sentence texts
    expect(screen.getByText("I'm just finishing work.")).toBeInTheDocument();
    expect(screen.getByText("I've got ten minutes before.")).toBeInTheDocument();
    expect(screen.getByText("And then I noticed my nails.")).toBeInTheDocument();

    // Timecodes
    expect(screen.getByText("00:00")).toBeInTheDocument(); // start 0
    expect(screen.getByText("00:03")).toBeInTheDocument(); // start 3
    expect(screen.getByText("00:08")).toBeInTheDocument(); // start 8
  });

  it("4. click on a sentence row calls onSeek with sentence.start", () => {
    const onSeek = vi.fn();
    renderTranscriptTab(makeTranscriptStep(FULL_TRANSCRIPT), THREE_SENTENCES, onSeek);

    // Click the sentence text button for the second sentence (start = 3)
    fireEvent.click(screen.getByText("I've got ten minutes before."));
    expect(onSeek).toHaveBeenCalledWith(3);
  });

  it("5. empty sentences array — renders paragraph but no table", () => {
    renderTranscriptTab(makeTranscriptStep(FULL_TRANSCRIPT), []);

    expect(screen.getByText(FULL_TRANSCRIPT)).toBeInTheDocument();
    // No timecodes (empty array treated as no sentences)
    expect(screen.queryByText("00:00")).not.toBeInTheDocument();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Highlight (currentTime) tests
// THREE_SENTENCES: [0–2.5), [3–6), [8–11)
// ──────────────────────────────────────────────────────────────────────────────

describe("TranscriptView — active sentence highlight", () => {
  beforeEach(() => cleanup());

  it("H1. no active row when currentTime=0 and first sentence starts at 1.0", () => {
    const sentences: TranscriptSentence[] = [
      { text: "Hello world.", start: 1.0, end: 3.0, wordIndices: [0, 1], speakerId: null },
      { text: "Goodbye world.", start: 4.0, end: 6.0, wordIndices: [2, 3], speakerId: null },
    ];
    renderTranscriptTab(makeTranscriptStep("Hello world. Goodbye world."), sentences, undefined, 0);

    const rows = screen.getAllByRole("row");
    for (const row of rows) {
      expect(row).not.toHaveAttribute("data-active", "true");
    }
  });

  it("H2. first sentence active when currentTime=2 and sentence spans [1.0, 3.0)", () => {
    const sentences: TranscriptSentence[] = [
      { text: "Hello world.", start: 1.0, end: 3.0, wordIndices: [0, 1], speakerId: null },
      { text: "Goodbye world.", start: 4.0, end: 6.0, wordIndices: [2, 3], speakerId: null },
    ];
    renderTranscriptTab(makeTranscriptStep("Hello world. Goodbye world."), sentences, undefined, 2);

    const rows = screen.getAllByRole("row");
    expect(rows[0]).toHaveAttribute("data-active", "true");
    expect(rows[1]).not.toHaveAttribute("data-active");
  });

  it("H3. switches active row when currentTime advances past sentence boundary", () => {
    const sentences: TranscriptSentence[] = [
      { text: "First.", start: 1.0, end: 3.0, wordIndices: [0, 0], speakerId: null },
      { text: "Second.", start: 4.0, end: 6.0, wordIndices: [1, 1], speakerId: null },
    ];

    // Render with first sentence active
    vi.mocked(useVideoAnalysis).mockReturnValue({
      data: buildQueryData(makeTranscriptStep("First. Second."), sentences),
      isLoading: false,
    } as unknown as ReturnType<typeof useVideoAnalysis>);

    const { rerender } = render(
      <AnalysisViewer fileId="file-1" currentTime={2} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /transcript/i }));

    let rows = screen.getAllByRole("row");
    expect(rows[0]).toHaveAttribute("data-active", "true");
    expect(rows[1]).not.toHaveAttribute("data-active");

    // Advance time to second sentence
    rerender(<AnalysisViewer fileId="file-1" currentTime={5} />);

    rows = screen.getAllByRole("row");
    expect(rows[0]).not.toHaveAttribute("data-active");
    expect(rows[1]).toHaveAttribute("data-active", "true");
  });

  it("H4. sentences=null with currentTime=42 renders paragraph only, no crash", () => {
    renderTranscriptTab(makeTranscriptStep(FULL_TRANSCRIPT), null, undefined, 42);
    expect(screen.getByText(FULL_TRANSCRIPT)).toBeInTheDocument();
    expect(screen.queryByRole("row")).not.toBeInTheDocument();
  });

  it("H5. click sentence row still calls onSeek (regression)", () => {
    const onSeek = vi.fn();
    renderTranscriptTab(makeTranscriptStep(FULL_TRANSCRIPT), THREE_SENTENCES, onSeek, 1.0);

    // Clicking the third sentence text should seek to its start (8)
    fireEvent.click(screen.getByText("And then I noticed my nails."));
    expect(onSeek).toHaveBeenCalledWith(8);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Multi-speaker tests
// ──────────────────────────────────────────────────────────────────────────────

describe("TranscriptView — multi-speaker", () => {
  beforeEach(() => cleanup());

  it("MS1. single speaker — no speaker column rendered", () => {
    const sentences: TranscriptSentence[] = [
      { text: "Hello.", start: 0, end: 2, wordIndices: [0, 0], speakerId: "speaker_0" },
      { text: "World.", start: 3, end: 5, wordIndices: [1, 1], speakerId: "speaker_0" },
    ];
    renderTranscriptTab(makeTranscriptStep("Hello. World."), sentences);

    // No badge elements at all
    expect(screen.queryAllByTestId("speaker-badge")).toHaveLength(0);
  });

  it("MS2. all null speakers — no speaker column rendered", () => {
    const sentences: TranscriptSentence[] = [
      { text: "Hello.", start: 0, end: 2, wordIndices: [0, 0], speakerId: null },
      { text: "World.", start: 3, end: 5, wordIndices: [1, 1], speakerId: null },
    ];
    renderTranscriptTab(makeTranscriptStep("Hello. World."), sentences);

    expect(screen.queryAllByTestId("speaker-badge")).toHaveLength(0);
  });

  it("MS3. two speakers — speaker column rendered with correct labels", () => {
    const sentences: TranscriptSentence[] = [
      { text: "Hello.", start: 0, end: 2, wordIndices: [0, 0], speakerId: "speaker_0" },
      { text: "World.", start: 3, end: 5, wordIndices: [1, 1], speakerId: "speaker_1" },
      { text: "Bye.", start: 6, end: 8, wordIndices: [2, 2], speakerId: "speaker_0" },
    ];
    renderTranscriptTab(makeTranscriptStep("Hello. World. Bye."), sentences);

    const badges = screen.getAllByTestId("speaker-badge");
    expect(badges).toHaveLength(3);
    expect(badges[0]).toHaveTextContent("speaker_0");
    expect(badges[1]).toHaveTextContent("speaker_1");
    expect(badges[2]).toHaveTextContent("speaker_0");
  });

  it("MS4. mix of null + named — null rows show 'unknown', named rows show id", () => {
    const sentences: TranscriptSentence[] = [
      { text: "First.", start: 0, end: 2, wordIndices: [0, 0], speakerId: null },
      { text: "Second.", start: 3, end: 5, wordIndices: [1, 1], speakerId: "speaker_0" },
      { text: "Third.", start: 6, end: 8, wordIndices: [2, 2], speakerId: null },
    ];
    renderTranscriptTab(makeTranscriptStep("First. Second. Third."), sentences);

    const badges = screen.getAllByTestId("speaker-badge");
    expect(badges).toHaveLength(3);
    expect(badges[0]).toHaveTextContent("unknown");
    expect(badges[1]).toHaveTextContent("speaker_0");
    expect(badges[2]).toHaveTextContent("unknown");
  });

  it("MS5. same speakerId → same badge className", () => {
    const sentences: TranscriptSentence[] = [
      { text: "First.", start: 0, end: 2, wordIndices: [0, 0], speakerId: "speaker_0" },
      { text: "Second.", start: 3, end: 5, wordIndices: [1, 1], speakerId: "speaker_1" },
      { text: "Third.", start: 6, end: 8, wordIndices: [2, 2], speakerId: "speaker_0" },
    ];
    renderTranscriptTab(makeTranscriptStep("First. Second. Third."), sentences);

    const badges = screen.getAllByTestId("speaker-badge");
    // badges[0] and badges[2] both speaker_0 — same class
    expect(badges[0].className).toBe(badges[2].className);
  });

  it("MS6. different speakerId → different badge className", () => {
    const sentences: TranscriptSentence[] = [
      { text: "First.", start: 0, end: 2, wordIndices: [0, 0], speakerId: "speaker_0" },
      { text: "Second.", start: 3, end: 5, wordIndices: [1, 1], speakerId: "speaker_1" },
    ];
    renderTranscriptTab(makeTranscriptStep("First. Second."), sentences);

    const badges = screen.getAllByTestId("speaker-badge");
    expect(badges[0].className).not.toBe(badges[1].className);
  });
});
