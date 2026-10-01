// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const shell = vi.hoisted(() => ({
  copyFileToClipboard: vi.fn(async (): Promise<boolean | undefined> => true),
  revealFile: vi.fn(async () => {}),
}));
vi.mock("@/lib/shell/client", () => ({
  copyFileToClipboard: shell.copyFileToClipboard,
  revealFile: shell.revealFile,
  revealLabel: () => "Reveal in Finder",
  getShellPlatform: () => "darwin",
}));
const q = vi.hoisted(() => ({
  fetchExportLocation: vi.fn(async (): Promise<{ path: string; exists: boolean } | null> => ({ path: "/s/p1/exports/A.mp4", exists: true })),
  rename: vi.fn(async () => ({})),
  remove: vi.fn(async () => {}),
}));
vi.mock("@/lib/queries/exports", () => ({
  fetchExportLocation: q.fetchExportLocation,
  useRenameExport: () => ({ mutateAsync: q.rename }),
  useDeleteExport: () => ({ mutateAsync: q.remove }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const trackEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/client", () => ({ trackEvent }));

import { COPIED_FILE_TOAST, COPIED_PATH_TOAST, useExportActions } from "@/hooks/exports/use-export-actions";
import { MISSING_FILE_MESSAGE, type ExportRecordView } from "@/lib/exports/types";
import { consumePostingIntent, subscribePostingIntent } from "@/hooks/social/use-posting-intent";

const writeText = vi.fn(async () => {});
const EXP = { id: "exp_1", missing: false, name: "A" } as ExportRecordView;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("useExportActions", () => {
  it("copy: the desktop shell puts the file on the clipboard", async () => {
    const { result } = renderHook(() => useExportActions("tab"));
    await act(() => result.current.copy(EXP));
    expect(shell.copyFileToClipboard).toHaveBeenCalledWith("/s/p1/exports/A.mp4");
    expect(writeText).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(COPIED_FILE_TOAST);
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "copy", surface: "tab" });
  });

  it.each([
    ["no bridge (npx browser, older shell)", undefined],
    ["the shell can't here (Windows)", false],
  ])("copy falls back to the file's location when %s", async (_label, answer) => {
    shell.copyFileToClipboard.mockResolvedValueOnce(answer);
    const { result } = renderHook(() => useExportActions("resources"));
    await act(() => result.current.copy(EXP));
    expect(writeText).toHaveBeenCalledWith("/s/p1/exports/A.mp4");
    expect(toast.success).toHaveBeenCalledWith(COPIED_PATH_TOAST);
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "copy_path", surface: "resources" });
  });

  it("copy falls back to the location when the IPC throws", async () => {
    shell.copyFileToClipboard.mockRejectedValueOnce(new Error("ipc gone"));
    const { result } = renderHook(() => useExportActions("tab"));
    await act(() => result.current.copy(EXP));
    expect(writeText).toHaveBeenCalledWith("/s/p1/exports/A.mp4");
    expect(toast.success).toHaveBeenCalledWith(COPIED_PATH_TOAST);
  });

  it("a missing file refuses copy and reveal with the Missing file message", async () => {
    const { result } = renderHook(() => useExportActions("tab"));
    await act(() => result.current.copy({ ...EXP, missing: true }));
    q.fetchExportLocation.mockResolvedValueOnce({ path: "/s/p1/exports/A.mp4", exists: false });
    await act(() => result.current.reveal(EXP));
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledWith(MISSING_FILE_MESSAGE);
    expect(shell.copyFileToClipboard).not.toHaveBeenCalled();
    expect(shell.revealFile).not.toHaveBeenCalled();
  });

  it("reveal opens the file manager at the file", async () => {
    const { result } = renderHook(() => useExportActions("tab"));
    expect(result.current.revealLabel).toBe("Reveal in Finder");
    await act(() => result.current.reveal(EXP));
    expect(shell.revealFile).toHaveBeenCalledWith("/s/p1/exports/A.mp4");
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "reveal", surface: "tab" });
  });

  it("rename: success tracks; a refusal toasts the route's words and answers false", async () => {
    const { result } = renderHook(() => useExportActions("tab"));
    let ok = false;
    await act(async () => {
      ok = await result.current.rename(EXP, "B");
    });
    expect(ok).toBe(true);
    expect(q.rename).toHaveBeenCalledWith({ exportId: "exp_1", name: "B" });
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "rename", surface: "tab" });
    q.rename.mockRejectedValueOnce(new Error("This export is uploading to social right now. Rename it when the upload finishes."));
    await act(async () => {
      ok = await result.current.rename(EXP, "C");
    });
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("This export is uploading to social right now. Rename it when the upload finishes.");
  });

  it("post opens the piece's Posting tab on that export's file, from either surface, and tracks it", () => {
    const seen: Array<{ pieceId: string; exportPath?: string | null }> = [];
    const off = subscribePostingIntent((i) => seen.push(i));
    const done = { ...EXP, pieceId: "p1", status: "done", path: "/s/p1/exports/A.mp4" } as ExportRecordView;
    const { result } = renderHook(() => useExportActions("tab"));
    act(() => result.current.post(done));
    const res = renderHook(() => useExportActions("resources"));
    act(() => res.result.current.post(done));
    off();
    consumePostingIntent();
    expect(seen).toEqual([
      expect.objectContaining({ pieceId: "p1", exportPath: "/s/p1/exports/A.mp4" }),
      expect.objectContaining({ pieceId: "p1", exportPath: "/s/p1/exports/A.mp4" }),
    ]);
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "post", surface: "tab" });
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "post", surface: "resources" });
  });

  it("post refuses a missing or unfinished export with the Missing file message and opens nothing", () => {
    const seen: unknown[] = [];
    const off = subscribePostingIntent((i) => seen.push(i));
    const { result } = renderHook(() => useExportActions("tab"));
    act(() => result.current.post({ ...EXP, pieceId: "p1", status: "done", missing: true, path: "/s/A.mp4" } as ExportRecordView));
    act(() => result.current.post({ ...EXP, pieceId: "p1", status: "running", path: null } as ExportRecordView));
    off();
    expect(seen).toEqual([]);
    expect(toast.error).toHaveBeenNthCalledWith(1, MISSING_FILE_MESSAGE);
    expect(toast.error).toHaveBeenNthCalledWith(2, "Only a finished export can be posted.");
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("remove deletes and tracks; play tracks", async () => {
    const { result } = renderHook(() => useExportActions("resources"));
    await act(async () => {
      await result.current.remove(EXP);
    });
    expect(q.remove).toHaveBeenCalledWith("exp_1");
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "delete", surface: "resources" });
    act(() => result.current.played());
    expect(trackEvent).toHaveBeenCalledWith("export_action", { action: "play", surface: "resources" });
  });
});
