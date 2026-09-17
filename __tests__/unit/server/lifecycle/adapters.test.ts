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

  it("prints a skipped install as an info line even when no spinner was opened for it", () => {
    // Since 2026-09-08 a token-matched dep emits install-done/skipped with NO
    // preceding install-start (category-a.ts), so the CLI has no spinner to
    // resolve. The line must still reach the user — "ffmpeg: already
    // installed" is the whole warm-boot output for that dep.
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const adapter = cliAdapter();
    adapter.onEvent({
      kind: "category-a-install-done",
      item: { id: "ffmpeg", label: "ffmpeg", kind: "binary" },
      result: "skipped",
      reason: "already installed",
    });

    const written = [...out.mock.calls, ...err.mock.calls].map(([s]) => String(s)).join("");
    expect(written).toContain("ffmpeg: already installed");

    out.mockRestore();
    err.mockRestore();
  });

  it("de-tokenises a snake_case skip reason instead of printing it raw", () => {
    // `mcp/registry/dependency-manager.ts` emitted `already_installed` while
    // `category-a.ts` emitted the prose form, and this adapter prints whatever
    // arrives — so a warm boot read `ffmpeg: already_installed`. The emit sites
    // now use prose; this is the belt to that braces, for any reason a future
    // emitter forgets to spell out.
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const adapter = cliAdapter();
    adapter.onEvent({
      kind: "category-a-install-done",
      item: { id: "ffmpeg", label: "ffmpeg", kind: "binary" },
      result: "skipped",
      reason: "already_installed",
    });

    const written = [...out.mock.calls, ...err.mock.calls].map(([s]) => String(s)).join("");
    expect(written).toContain("ffmpeg: already installed");
    expect(written).not.toContain("already_installed");

    out.mockRestore();
    err.mockRestore();
  });

  it("prints a failed install with no preceding start — the node runtime's start is lazy now", () => {
    // `sp?.warn(...)` on an absent spinner printed NOTHING, so a node-runtime
    // failure was silent on the CLI the moment its start event became lazy.
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const adapter = cliAdapter();
    adapter.onEvent({
      kind: "category-a-install-done",
      item: { id: "node-runtime", label: "Node.js runtime", kind: "binary" },
      result: "failed",
      reason: "no pinned build for this platform",
    });

    const written = [...out.mock.calls, ...err.mock.calls].map(([s]) => String(s)).join("");
    expect(written).toContain("Node.js runtime: no pinned build for this platform");

    out.mockRestore();
    err.mockRestore();
  });

  it("prints a successful install with no preceding start", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const adapter = cliAdapter();
    adapter.onEvent({
      kind: "category-a-install-done",
      item: { id: "node-runtime", label: "Node.js runtime", kind: "binary" },
      result: "installed",
    });

    const written = [...out.mock.calls, ...err.mock.calls].map(([s]) => String(s)).join("");
    expect(written).toContain("Node.js runtime");

    out.mockRestore();
    err.mockRestore();
  });

  it("prints a boot warning to stderr as a warning, failing nothing", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const message = "libi's tools are unavailable — open Agents → Libi MCP and press Restart.";
    cliAdapter().onEvent({ kind: "warning", phase: "category-b", step: "mcp-http", message });

    const stderr = (err.mock.calls as Array<[string]>).map(([s]) => s).join("");
    expect(stderr).toContain(`[libi] Warning: ${message}`);
    expect(stderr).not.toContain("✗");
    expect(stderr).not.toContain("failed");

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
      step: "binary-install",
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

  it("has no probe branch to exercise — the kind is gone", () => {
    // Category A's probe phase was deleted on 2026-09-08 with the bundled
    // MCPs; nothing has emitted `category-a-probe-*` since, and the handlers
    // that outlived it read as a working feature. `LifecycleEvent` no longer
    // admits the kind, so this is a compile-time assertion as much as a
    // runtime one: an unknown event must be ignored, never throw.
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
      } as unknown as Parameters<typeof adapter.onEvent>[0]);
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
