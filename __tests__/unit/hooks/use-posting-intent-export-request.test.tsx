// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  consumePostingIntent,
  isExportForPost,
  markExportForPost,
  openPostingTab,
  requestExportDialog,
  takeExportDialogDraftPostId,
  takeExportDialogPurpose,
  takeExportDialogReturnToPost,
  usePostingIntent,
} from "@/hooks/social/use-posting-intent";

afterEach(() => {
  consumePostingIntent();
  takeExportDialogPurpose();
  takeExportDialogReturnToPost();
});

describe("the export-dialog request from the composer", () => {
  it("carries 'return to the post' once, alongside the purpose", () => {
    requestExportDialog("p1", { purpose: "social", returnToPost: true });
    expect(takeExportDialogPurpose()).toBe("social");
    expect(takeExportDialogReturnToPost()).toBe(true);
    // Read once: a later plain open of the dialog must not carry it over.
    expect(takeExportDialogReturnToPost()).toBe(false);
  });

  it("a plain request (the Exports tab's Export…) never returns to a post", () => {
    requestExportDialog("p1");
    expect(takeExportDialogReturnToPost()).toBe(false);
  });

  it("a request that follows one from the composer does not inherit its return", () => {
    requestExportDialog("p1", { purpose: "social", returnToPost: true });
    requestExportDialog("p1");
    expect(takeExportDialogReturnToPost()).toBe(false);
  });

  it("carries the draft being edited once, and only for a return to the post", () => {
    requestExportDialog("p1", { purpose: "social", returnToPost: true, draftPostId: "post_7" });
    expect(takeExportDialogDraftPostId()).toBe("post_7");
    expect(takeExportDialogDraftPostId()).toBeNull();
    requestExportDialog("p1", { draftPostId: "post_7" });
    expect(takeExportDialogDraftPostId()).toBeNull();
  });

  it("remembers which exports were made for a post", () => {
    expect(isExportForPost("exp_a")).toBe(false);
    markExportForPost("exp_a");
    expect(isExportForPost("exp_a")).toBe(true);
  });
});

describe("the posting intent", () => {
  it("delivers the export to start on, and the export to wait for, to the Posting tab", () => {
    const { result } = renderHook(() => usePostingIntent("p1"));
    act(() => openPostingTab({ pieceId: "p1", exportPath: "/s/p1/exports/a.mp4" }));
    expect(result.current).toMatchObject({ exportPath: "/s/p1/exports/a.mp4" });
    act(() => openPostingTab({ pieceId: "p1", awaitExportId: "exp_9" }));
    expect(result.current).toMatchObject({ awaitExportId: "exp_9" });
    act(() => openPostingTab({ pieceId: "p2", awaitExportId: "exp_x" }));
    expect(result.current).toBeNull();
  });
});
