// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssetPreviewPanel } from "@/components/editor/asset-preview-panel";
import type { FileRecord } from "@/lib/db/schema/types";
import { EditorStateProvider } from "@/lib/editor-state-context";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="resizable-group" className={className}>{children}</div>
  ),
  Panel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  Separator: ({ className }: { className?: string }) => (
    <div data-testid="resizable-separator" className={className} />
  ),
}));
vi.mock("@/lib/queries/analysis", () => ({
  useVideoAnalysis: () => ({ data: null, isLoading: false }),
  useSearchFrames: () => ({ data: null }),
}));
vi.mock("@/lib/queries/files", () => ({
  useUpdateFileNotes: () => ({ mutate: vi.fn() }),
  useFileLocation: () => ({ data: null, isLoading: false }),
}));
vi.mock("@/hooks/sessions/use-session-list", () => ({
  useSessionList: () => ({
    sessions: [], activeSessionId: null, setActiveSessionId: vi.fn(),
    isLoading: false, activeAgentId: null, refresh: vi.fn(), createSession: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/sessions/use-agent-chat", () => ({ subscribeBroadcast: () => () => {} }));

function video(): FileRecord {
  return {
    id: "v", pieceId: "p", folderId: null, filename: "x.mp4", name: "Clip Name",
    description: "", type: "video", storagePath: "",
    contentType: "video/mp4", size: 1, mediaDuration: 10,
    mediaWidth: 640, mediaHeight: 360, hasAudio: true, hasAlpha: false,
    proxyFilename: null, proxyStatus: "idle", proxyGeneratedAt: null, proxyHeight: null,
    filmstripFilename: null, filmstripStatus: "idle", filmstripGeneratedAt: null, filmstripFrames: null, filmstripHeight: null,
    falUploadedUrl: null,
    notes: null,
    aiGeneration: null,
    createdAt: new Date(),
  };
}

const wrap = (ui: React.ReactNode) => (
  <EditorStateProvider>{ui}</EditorStateProvider>
);

beforeEach(() => localStorage.clear());

describe("AssetPreviewPanel", () => {
  it("shows the asset name in the header", () => {
    render(wrap(<AssetPreviewPanel asset={video()} onClose={() => {}} />));
    expect(screen.getByText("Clip Name")).toBeInTheDocument();
  });

  it("renders Summary, Transcript, Frames tabs in default mode", () => {
    render(wrap(<AssetPreviewPanel asset={video()} onClose={() => {}} />));
    expect(screen.getByRole("tab", { name: /summary/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /transcript/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /frames/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^preview$/i })).toBeNull();
  });

  it("toggles full mode and adds Preview tab", () => {
    render(wrap(<AssetPreviewPanel asset={video()} onClose={() => {}} />));
    const fullBtn = screen.getByRole("button", { name: /full mode/i });
    act(() => { fireEvent.click(fullBtn); });
    expect(screen.getByRole("tab", { name: /^preview$/i })).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(wrap(<AssetPreviewPanel asset={video()} onClose={onClose} />));
    const closeBtn = screen.getByRole("button", { name: /back to folder/i });
    act(() => { fireEvent.click(closeBtn); });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders the Extra analysis (script) tab after Frames in the tab list", () => {
    render(wrap(<AssetPreviewPanel asset={video()} onClose={() => {}} />));
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent ?? "");
    // Labeled "Extra analysis" — "Script" collided with the piece-level Script tab.
    expect(tabs).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Extra analysis/i)]),
    );
    const frameIdx = tabs.findIndex((t) => /^frames/i.test(t));
    const scriptIdx = tabs.findIndex((t) => /^extra analysis/i.test(t));
    expect(scriptIdx).toBeGreaterThan(frameIdx);
  });
});
