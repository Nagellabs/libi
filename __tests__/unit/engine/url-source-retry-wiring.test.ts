/**
 * Every `UrlSource` libi constructs must carry the bounded retry policy.
 *
 * Mediabunny's default is an INFINITE retry loop for same-origin URLs, so a
 * `new UrlSource(url)` written without options is not a smaller version of the
 * right thing — it is the 2026-08-18 bug (a dead local server spinning every
 * video source forever behind a mediabunny-internal stack trace). The source
 * sweep below is deliberately static so it also covers the fourth site nobody
 * has written yet; the runtime case proves the option actually reaches
 * mediabunny rather than merely appearing in the file.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SEARCH_DIRS = ["lib", "app", "components", "hooks", "mcp"];

function sourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path.relative(ROOT, full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("UrlSource retry-policy wiring", () => {
  it("passes getRetryDelay at every construction site", () => {
    const bare: string[] = [];
    let sites = 0;
    for (const dir of SEARCH_DIRS) {
      for (const file of sourceFiles(dir)) {
        const text = fs.readFileSync(file, "utf-8");
        if (!text.includes("new UrlSource(")) continue;
        for (const line of text.split("\n")) {
          if (!line.includes("new UrlSource(")) continue;
          sites++;
          if (!line.includes("getRetryDelay")) {
            bare.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
          }
        }
      }
    }
    // Guards the sweep itself — a refactor that renames the class must not turn
    // this into a test that passes by finding nothing.
    expect(sites).toBeGreaterThanOrEqual(3);
    expect(bare).toEqual([]);
  });
});

describe("MediaBunnyFrameSource", () => {
  it("hands the bounded policy to the UrlSource it creates", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    vi.doMock("mediabunny", () => ({
      Input: class {
        async getPrimaryVideoTrack() { return null; }
        dispose() {}
      },
      UrlSource: class {
        constructor(_url: string, options?: Record<string, unknown>) {
          seen.push(options);
        }
      },
      CanvasSink: class {},
      ALL_FORMATS: [],
    }));

    const { MediaBunnyFrameSource } = await import("@/lib/engine/media-bunny-frame-source");
    const { mediaFetchRetryDelay } = await import("@/lib/engine/media-fetch-retry");

    const source = new MediaBunnyFrameSource("http://127.0.0.1:3456/api/files/f1", 1080);
    // init() runs async in the constructor; let it reach `new UrlSource`.
    await Promise.resolve();
    source.dispose();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.getRetryDelay).toBe(mediaFetchRetryDelay);
    vi.doUnmock("mediabunny");
  });
});
