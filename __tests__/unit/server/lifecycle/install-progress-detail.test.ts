import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * `CategoryAInstallProgressEvent.detail` exists for installs libi cannot count
 * bytes for — today the Claude adapter's opaque ~250MB `npm install`, the
 * largest download in Category A. BOTH renderers must show it: the CLI's `ora`
 * line and the Electron splash. A renderer that ignores `detail` falls back to
 * a frozen "0 B", which is precisely the hang-shaped UI the tick was added to
 * remove.
 *
 * `ora` is mocked so the spinner text is assertable — it otherwise only reaches
 * a TTY's control sequences.
 */

interface FakeSpinner {
  text: string;
  start: () => FakeSpinner;
  succeed: (t?: string) => FakeSpinner;
  info: (t?: string) => FakeSpinner;
  warn: (t?: string) => FakeSpinner;
  fail: (t?: string) => FakeSpinner;
}

const spinners: FakeSpinner[] = [];

vi.mock("ora", () => ({
  default: (text: string) => {
    const spinner: FakeSpinner = {
      text,
      start: () => spinner,
      succeed: () => spinner,
      info: () => spinner,
      warn: () => spinner,
      fail: () => spinner,
    };
    spinners.push(spinner);
    return spinner;
  },
}));

const ITEM = { id: "claude-adapter", label: "Claude Code adapter", kind: "npm" as const };

describe("cliAdapter progress rendering", () => {
  beforeEach(() => {
    spinners.length = 0;
  });

  it("renders `detail` verbatim instead of a meaningless 0 B byte count", async () => {
    const { cliAdapter } = await import("@/lib/server/lifecycle/adapters/cli");
    const adapter = cliAdapter();
    adapter.onEvent({ kind: "category-a-install-start", item: ITEM });
    adapter.onEvent({
      kind: "category-a-install-progress",
      item: ITEM,
      bytesDownloaded: 0,
      bytesTotal: null,
      detail: "downloading ~345 MB, first run only — 12s elapsed",
    });

    const line = spinners.at(-1)!.text;
    expect(line).toContain("downloading ~345 MB, first run only — 12s elapsed");
    expect(line).not.toContain("0 B");
  });

  it("still renders byte counts when no detail is supplied (binary downloads)", async () => {
    const { cliAdapter } = await import("@/lib/server/lifecycle/adapters/cli");
    const adapter = cliAdapter();
    const binary = { id: "yt-dlp", label: "yt-dlp", kind: "binary" as const };
    adapter.onEvent({ kind: "category-a-install-start", item: binary });
    adapter.onEvent({
      kind: "category-a-install-progress",
      item: binary,
      bytesDownloaded: 2 * 1024 * 1024,
      bytesTotal: 4 * 1024 * 1024,
    });

    expect(spinners.at(-1)!.text).toContain("2.0 MB / 4.0 MB");
  });
});

describe("splash renderer", () => {
  it("handles `detail` too — the splash is where a cold first boot is actually watched", () => {
    // The splash is raw HTML loaded by Electron, so this asserts on the source
    // rather than executing it: the point is that a future edit to the event
    // shape can't silently leave this renderer behind.
    const splash = readFileSync(
      path.join(process.cwd(), "electron", "splash.html"),
      "utf-8",
    );
    expect(splash).toContain("e.detail");
    // And the detail must reach the subtitle, not just the row's meta column —
    // that line is the one a user reads while deciding whether to force-quit.
    expect(splash).toMatch(/setSubtitle\([^)]*e\.detail/);
  });
});
