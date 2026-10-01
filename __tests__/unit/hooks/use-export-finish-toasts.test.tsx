// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const trackEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/client", () => ({ trackEvent }));
const openExportInTab = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/exports/use-open-export", () => ({ openExportInTab }));
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { refreshQueryEmitter } from "@/hooks/sessions/use-agent-chat";
import { useExportFinishToasts, finishToastTitle } from "@/hooks/exports/use-export-finish-toasts";
import { consumePostingIntent, markExportForPost, subscribePostingIntent } from "@/hooks/social/use-posting-intent";

const record = (over: Record<string, unknown> = {}) => ({
  id: "exp_1", pieceId: "p1", pieceName: "Summer", name: "Promo", status: "done", source: "user", backend: "ffmpeg-overlay",
  container: "mp4", quality: "source", droppedOverlays: null, error: null, ...over,
});
let body: Record<string, unknown> = record();

beforeEach(() => {
  vi.clearAllMocks();
  body = record();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.startsWith("/api/exports/") ? new Response(JSON.stringify({ export: body })) : new Response("{}"))));
});

describe("useExportFinishToasts", () => {
  it("one toast per finished export — '<piece>: <name> is ready' · Open", async () => {
    renderHook(() => useExportFinishToasts());
    refreshQueryEmitter.emit({ queryKey: "exports", pieceId: "p1", exportId: "exp_1", status: "done" });
    refreshQueryEmitter.emit({ queryKey: "exports", pieceId: "p1", exportId: "exp_1", status: "done" });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const [title, opts] = toast.success.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(title).toBe("Summer: Promo is ready");
    expect(opts.action.label).toBe("Open");
    opts.action.onClick();
    expect(openExportInTab).toHaveBeenCalledWith({ pieceId: "p1", exportId: "exp_1" });
    expect(trackEvent).toHaveBeenCalledWith("export_completed", expect.objectContaining({ backend: "ffmpeg-overlay" }));
  });

  it("an export made for a post offers Continue post (back to the Posting tab) with Open beside it", async () => {
    markExportForPost("exp_post");
    body = record({ id: "exp_post" });
    const seen: Array<{ pieceId: string; awaitExportId?: string | null }> = [];
    const off = subscribePostingIntent((i) => seen.push(i));
    renderHook(() => useExportFinishToasts());
    refreshQueryEmitter.emit({ queryKey: "exports", pieceId: "p1", exportId: "exp_post", status: "done" });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const opts = toast.success.mock.calls[0][1] as {
      action: { label: string; onClick: () => void };
      cancel: { label: string; onClick: () => void };
    };
    expect(opts.action.label).toBe("Continue post");
    expect(opts.cancel.label).toBe("Open");
    opts.action.onClick();
    off();
    consumePostingIntent();
    expect(seen).toEqual([expect.objectContaining({ pieceId: "p1", awaitExportId: "exp_post" })]);
    opts.cancel.onClick();
    expect(openExportInTab).toHaveBeenCalledWith({ pieceId: "p1", exportId: "exp_post" });
  });

  it("says which clips a finished export went without, and keeps that toast up", async () => {
    body = record({ id: "exp_2", droppedOverlays: [{ id: "v1", message: "m", kind: "video", cause: "load", fileId: "f1", name: "beach.mp4" }] });
    renderHook(() => useExportFinishToasts());
    refreshQueryEmitter.emit({ queryKey: "exports", pieceId: "p1", exportId: "exp_2", status: "done" });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const opts = toast.success.mock.calls[0][1] as { description: string; duration: number };
    expect(opts.description).toMatch(/beach\.mp4/);
    expect(opts.duration).toBe(Infinity);
  });

  it("a failure toasts its error; a rename, a queue or a running tick toasts nothing", async () => {
    body = record({ id: "exp_3", status: "failed", error: "Composition cannot be exported" });
    renderHook(() => useExportFinishToasts());
    for (const status of ["renamed", "queued", "running", "deleted"]) {
      refreshQueryEmitter.emit({ queryKey: "exports", pieceId: "p1", exportId: "exp_x", status });
    }
    refreshQueryEmitter.emit({ queryKey: "exports", pieceId: "p1", exportId: "exp_3", status: "failed" });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Summer: Promo failed", expect.objectContaining({ description: "Composition cannot be exported" })));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("finishToastTitle falls back when the piece has no name", () => {
    expect(finishToastTitle({ pieceName: null, name: "Promo" })).toBe("Your piece: Promo is ready");
  });
});
