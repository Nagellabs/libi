import { describe, it, expect, vi } from "vitest";
import { cliAdapter } from "@/lib/server/lifecycle/adapters/cli";

/**
 * The CLI adapter uses `ora` (which writes to stdout via terminal control
 * sequences) so we only assert observable behaviour — no crash on valid
 * events + the fatal block is written to stderr.
 */
describe("cliAdapter", () => {
  it("does not throw when fed the install-phase happy-path event sequence", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const adapter = cliAdapter();
    expect(() => {
      adapter.onEvent({ kind: "prelude-start" });
      adapter.onEvent({
        kind: "category-a-install-start",
        item: { id: "yt-dlp", label: "YouTube Downloader", kind: "binary" },
      });
      adapter.onEvent({
        kind: "category-a-install-progress",
        item: { id: "yt-dlp", label: "YouTube Downloader", kind: "binary" },
        bytesDownloaded: 1024 * 512,
        bytesTotal: 1024 * 1024,
      });
      adapter.onEvent({
        kind: "category-a-install-done",
        item: { id: "yt-dlp", label: "YouTube Downloader", kind: "binary" },
        result: "installed",
      });
      adapter.onEvent({
        kind: "category-a-probe-start",
        mcpId: "youtube-downloader",
        label: "YouTube Downloader",
      });
      adapter.onEvent({
        kind: "category-a-probe-done",
        mcpId: "youtube-downloader",
        label: "YouTube Downloader",
        status: "up",
        durationMs: 42,
      });
      adapter.onEvent({ kind: "category-a-done", durationMs: 100 });
    }).not.toThrow();

    // prelude-start writes to stdout
    expect(out).toHaveBeenCalled();
    // No fatal block was written to stderr (ora spinners may write to stderr
    // internally for terminal control, but no error copy should appear).
    const stderrCalls = (err.mock.calls as Array<[string]>).map(([s]) => s);
    expect(stderrCalls.some((s) => s.includes("failed") || s.includes("✗"))).toBe(false);

    out.mockRestore();
    err.mockRestore();
  });

  it("writes error block to stderr on a fatal event", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const adapter = cliAdapter();
    adapter.onEvent({ kind: "prelude-start" });
    adapter.onEvent({
      kind: "fatal",
      phase: "category-a",
      step: "npm-install",
      error: "ENETUNREACH",
      hint: "Check your network connection.\nThen retry libi.",
    });

    expect(err).toHaveBeenCalledWith(expect.stringContaining("ENETUNREACH"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Check your network connection."));

    out.mockRestore();
    err.mockRestore();
  });

  it("writes error block to stderr for phase:category-b fatal event", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const adapter = cliAdapter();
    adapter.onEvent({
      kind: "fatal",
      phase: "category-b",
      step: "db-migrate",
      error: "malformed schema",
      hint: "Delete ~/.libi/libi.sqlite and retry.",
    });

    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("malformed schema"),
    );

    out.mockRestore();
    err.mockRestore();
  });

  it("handles skipped probe result without throwing", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const adapter = cliAdapter();
    expect(() => {
      adapter.onEvent({
        kind: "category-a-probe-done",
        mcpId: "fal-ai",
        label: "fal.ai",
        status: "skipped",
        reason: "needs_config",
        durationMs: 0,
      });
    }).not.toThrow();

    out.mockRestore();
    err.mockRestore();
  });

  it("handles server-listening event without throwing", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const adapter = cliAdapter();
    expect(() => {
      adapter.onEvent({ kind: "server-listening", url: "http://localhost:3456" });
    }).not.toThrow();
    expect(out).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:3456"),
    );

    out.mockRestore();
    err.mockRestore();
  });
});
