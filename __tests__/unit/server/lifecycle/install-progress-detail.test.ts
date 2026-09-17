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

  /**
   * `dependency-manager` opens a download with a bare `downloading` tick
   * (no bytes, no total — the response headers have not landed) and CLOSES it
   * with an `extracting` tick that carries no byte fields at all. Rendering
   * either wrote `(0 B)`: for ~1.5 s at the start, and for two frames right
   * before the green tick, which made a finished 27.1 MB download look like it
   * had restarted.
   */
  it("says nothing rather than `(0 B)` for a tick with no bytes, no total and no detail", async () => {
    const { cliAdapter } = await import("@/lib/server/lifecycle/adapters/cli");
    const adapter = cliAdapter();
    const binary = { id: "ffmpeg", label: "ffmpeg", kind: "binary" as const };
    adapter.onEvent({ kind: "category-a-install-start", item: binary });
    // The opening tick.
    adapter.onEvent({
      kind: "category-a-install-progress",
      item: binary,
      bytesDownloaded: 0,
      bytesTotal: null,
    });
    expect(spinners.at(-1)!.text).not.toContain("0 B");
    expect(spinners.at(-1)!.text).toBe("Verifying ffmpeg");

    adapter.onEvent({
      kind: "category-a-install-progress",
      item: binary,
      bytesDownloaded: 27 * 1024 * 1024,
      bytesTotal: 27 * 1024 * 1024,
    });
    expect(spinners.at(-1)!.text).toContain("27.0 MB / 27.0 MB");

    // The closing `extracting` tick — must not wind the counter back to zero.
    adapter.onEvent({
      kind: "category-a-install-progress",
      item: binary,
      bytesDownloaded: 0,
      bytesTotal: null,
    });
    expect(spinners.at(-1)!.text).toContain("27.0 MB / 27.0 MB");
    expect(spinners.at(-1)!.text).not.toContain("0 B");
  });

  /**
   * ora erases `Math.ceil(width / stream.columns)` lines, defaulting the
   * width with `??` — which a pty reporting `columns === 0` sails straight
   * past. The division yields Infinity and `clear()` writes `ESC[1A ESC[0K`
   * forever: measured at ~5 MB/s with the process pegged at 98 % CPU, the
   * Node.js runtime download stalled at zero bytes, and a 6.5 GB log after 21
   * minutes with boot never finishing.
   */
  it("makes a 0-column TTY read as 80 columns, through resizes", async () => {
    const { guardStreamColumns, FALLBACK_COLUMNS } = await import(
      "@/lib/server/lifecycle/adapters/cli"
    );
    const tty: { isTTY?: boolean; columns?: number } = { isTTY: true, columns: 0 };
    guardStreamColumns(tty);
    expect(tty.columns).toBe(FALLBACK_COLUMNS);
    // A real width still wins …
    tty.columns = 132;
    expect(tty.columns).toBe(132);
    // … and node re-asserting 0 from `_refreshSize()` on SIGWINCH cannot
    // restore the hang.
    tty.columns = 0;
    expect(tty.columns).toBe(FALLBACK_COLUMNS);
  });

  it("leaves a non-TTY stream alone", async () => {
    const { guardStreamColumns } = await import("@/lib/server/lifecycle/adapters/cli");
    const pipe: { isTTY?: boolean; columns?: number } = { isTTY: false, columns: undefined };
    guardStreamColumns(pipe);
    expect(pipe.columns).toBeUndefined();
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

  /** Same issue on the packaged splash, where QA saw `ffmpeg 0 B` at both ends of a
   *  finished 27.1 MB download. Source assertion for the same reason as above. */
  it("does not render a byte row for a tick with no bytes and no total", () => {
    const splash = readFileSync(path.join(process.cwd(), "electron", "splash.html"), "utf-8");
    expect(splash).toMatch(/else if \(e\.bytesDownloaded > 0 \|\| e\.bytesTotal\)/);
  });
});
