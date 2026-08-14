import { describe, it, expect } from "vitest";
import {
  START_MARKER,
  END_MARKER,
  stripLegacyLibiBlock,
  sweepLegacyCodexConfig,
  type SweepDeps,
} from "@/lib/codex-config/migrate-legacy";

// Owned names: `libi` plus every bundled def display name. The fixtures below
// use the two names that were actually emitted by the old writer.
const OWNED = new Set(["libi", "YouTube Downloader", "my_custom_never_owned"].filter((n) => n !== "my_custom_never_owned"));

describe("stripLegacyLibiBlock", () => {
  it("(a) HEALTHY: removes markers + libi-owned tables, preserves user content byte-for-byte", () => {
    const input = [
      "# my personal codex config",
      "model = \"gpt-5\"",
      "",
      "[projects.\"/Users/me\"]",
      "trust_level = \"trusted\"",
      "",
      START_MARKER,
      "",
      "[mcp_servers.libi]",
      "command = \"node\"",
      "args = [\"serve\"]",
      "",
      "[mcp_servers.\"YouTube Downloader\"]",
      "command = \"npx\"",
      "args = [\"-y\", \"@kevinwatt/yt-dlp-mcp\"]",
      "",
      END_MARKER,
      "",
    ].join("\n");

    const out = stripLegacyLibiBlock(input, OWNED);

    // Markers gone.
    expect(out).not.toContain(START_MARKER);
    expect(out).not.toContain(END_MARKER);
    // Owned tables gone.
    expect(out).not.toContain("[mcp_servers.libi]");
    expect(out).not.toContain("[mcp_servers.\"YouTube Downloader\"]");
    expect(out).not.toContain("@kevinwatt/yt-dlp-mcp");
    // User content byte-preserved (exact lines).
    expect(out).toContain("# my personal codex config");
    expect(out).toContain("model = \"gpt-5\"");
    expect(out).toContain("[projects.\"/Users/me\"]");
    expect(out).toContain("trust_level = \"trusted\"");
  });

  it("(b) OBSERVED CORRUPTION: markers wrap everything — user tables SURVIVE, only markers + owned tables removed", () => {
    const input = [
      START_MARKER,
      "notify = [\"osascript\", \"turn-ended\"]",
      "[mcp_servers.libi]",
      "command = \"node\"",
      "args = [\"serve-mcp\"]",
      "[mcp_servers.\"YouTube Downloader\"]",
      "command = \"npx\"",
      "args = [\"-y\", \"@kevinwatt/yt-dlp-mcp\"]",
      "[projects.\"/Users/me\"]",
      "trust_level = \"trusted\"",
      "[tui.model_availability_nux]",
      "seen = true",
      "[marketplaces.openai-bundled]",
      "url = \"https://example.com\"",
      "[plugins.\"documents@openai-primary-runtime\"]",
      "enabled = true",
      END_MARKER,
    ].join("\n");

    const out = stripLegacyLibiBlock(input, OWNED);

    // Both markers gone.
    expect(out).not.toContain(START_MARKER);
    expect(out).not.toContain(END_MARKER);
    // Owned mcp_servers tables gone.
    expect(out).not.toContain("[mcp_servers.libi]");
    expect(out).not.toContain("[mcp_servers.\"YouTube Downloader\"]");
    expect(out).not.toContain("@kevinwatt/yt-dlp-mcp");
    expect(out).not.toContain("serve-mcp");

    // Every user construct SURVIVES byte-exact.
    expect(out).toContain("notify = [\"osascript\", \"turn-ended\"]");
    expect(out).toContain("[projects.\"/Users/me\"]");
    expect(out).toContain("trust_level = \"trusted\"");
    expect(out).toContain("[tui.model_availability_nux]");
    expect(out).toContain("seen = true");
    expect(out).toContain("[marketplaces.openai-bundled]");
    expect(out).toContain("url = \"https://example.com\"");
    expect(out).toContain("[plugins.\"documents@openai-primary-runtime\"]");
    expect(out).toContain("enabled = true");
  });

  it("(c) NO MARKERS: returns input unchanged (identity)", () => {
    const input = [
      "model = \"gpt-5\"",
      "",
      "[mcp_servers.libi]",
      "command = \"node\"",
      "",
      "[projects.foo]",
      "trust_level = \"trusted\"",
      "",
    ].join("\n");

    // Even though it contains an owned mcp_servers table, with NO markers the
    // function is identity — the sweep only runs strip when a marker is present.
    expect(stripLegacyLibiBlock(input, OWNED)).toBe(input);
  });

  it("(d) OWNED-NAME DETECTION: bare + quoted owned tables removed; non-owned preserved", () => {
    const input = [
      START_MARKER,
      "[mcp_servers.libi]",
      "command = \"node\"",
      "[mcp_servers.\"YouTube Downloader\"]",
      "command = \"npx\"",
      "[mcp_servers.my_custom]",
      "command = \"my-custom-cmd\"",
      END_MARKER,
    ].join("\n");

    const out = stripLegacyLibiBlock(input, OWNED);

    expect(out).not.toContain("[mcp_servers.libi]");
    expect(out).not.toContain("[mcp_servers.\"YouTube Downloader\"]");
    // Non-owned custom MCP survives.
    expect(out).toContain("[mcp_servers.my_custom]");
    expect(out).toContain("command = \"my-custom-cmd\"");
  });

  it("removes an owned table WITH its .env sub-table (sub-table shares the parent name prefix)", () => {
    const input = [
      START_MARKER,
      "[mcp_servers.libi]",
      "command = \"node\"",
      "[mcp_servers.libi.env]",
      "FOO = \"bar\"",
      "[mcp_servers.other]",
      "command = \"x\"",
      END_MARKER,
    ].join("\n");

    const out = stripLegacyLibiBlock(input, OWNED);

    expect(out).not.toContain("[mcp_servers.libi]");
    expect(out).not.toContain("[mcp_servers.libi.env]");
    expect(out).not.toContain("FOO = \"bar\"");
    // A DIFFERENT non-owned server starts a new (preserved) block.
    expect(out).toContain("[mcp_servers.other]");
    expect(out).toContain("command = \"x\"");
  });
});

// ---- Sweep ----

function makeSweepDeps(opts: {
  isCanonical: boolean;
  fileContents: string | null; // null => file missing
}): {
  deps: SweepDeps;
  record: {
    reads: string[];
    writes: Array<{ path: string; contents: string }>;
  };
} {
  const record = {
    reads: [] as string[],
    writes: [] as Array<{ path: string; contents: string }>,
  };
  const deps: SweepDeps = {
    isCanonical: () => opts.isCanonical,
    codexHome: "/fake/codex",
    ownedNames: OWNED,
    readFile: (p: string) => {
      record.reads.push(p);
      if (opts.fileContents === null) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return opts.fileContents;
    },
    writeFile: (p: string, contents: string) => {
      record.writes.push({ path: p, contents });
    },
    now: () => "2026-07-05T00-00-00",
  };
  return { deps, record };
}

describe("sweepLegacyCodexConfig", () => {
  it("writes a backup BEFORE modifying, then writes the stripped config", () => {
    const contents = [
      START_MARKER,
      "notify = [\"x\"]",
      "[mcp_servers.libi]",
      "command = \"node\"",
      END_MARKER,
    ].join("\n");
    const { deps, record } = makeSweepDeps({ isCanonical: true, fileContents: contents });

    sweepLegacyCodexConfig(deps);

    // Two writes: backup first, then the config.
    expect(record.writes.length).toBe(2);
    const [backup, config] = record.writes;
    expect(backup.path).toContain("config.toml.libi-backup-");
    expect(backup.contents).toBe(contents); // backup is the ORIGINAL bytes
    expect(config.path).toBe("/fake/codex/config.toml");
    // Config write is the stripped result.
    expect(config.contents).not.toContain(START_MARKER);
    expect(config.contents).not.toContain("[mcp_servers.libi]");
    expect(config.contents).toContain("notify = [\"x\"]");
  });

  it("no-op AND writes NO backup when there is no marker", () => {
    const contents = [
      "model = \"gpt-5\"",
      "[mcp_servers.libi]",
      "command = \"node\"",
    ].join("\n");
    const { deps, record } = makeSweepDeps({ isCanonical: true, fileContents: contents });

    sweepLegacyCodexConfig(deps);

    expect(record.writes).toEqual([]);
  });

  it("no-op when the config file is missing", () => {
    const { deps, record } = makeSweepDeps({ isCanonical: true, fileContents: null });

    expect(() => sweepLegacyCodexConfig(deps)).not.toThrow();
    expect(record.writes).toEqual([]);
  });

  it("worktree-safety: isCanonical()=false returns WITHOUT opening the file (no read, no write)", () => {
    const contents = [START_MARKER, "[mcp_servers.libi]", END_MARKER].join("\n");
    const { deps, record } = makeSweepDeps({ isCanonical: false, fileContents: contents });

    sweepLegacyCodexConfig(deps);

    expect(record.reads).toEqual([]);
    expect(record.writes).toEqual([]);
  });

  it("is idempotent: a second run (post-strip, no marker) is a no-op", () => {
    const original = [
      START_MARKER,
      "[mcp_servers.libi]",
      "command = \"node\"",
      END_MARKER,
    ].join("\n");
    let current = original;
    const record = { writes: [] as Array<{ path: string; contents: string }> };
    const deps: SweepDeps = {
      isCanonical: () => true,
      codexHome: "/fake/codex",
      ownedNames: OWNED,
      readFile: () => current,
      writeFile: (p, contents) => {
        record.writes.push({ path: p, contents });
        if (p === "/fake/codex/config.toml") current = contents; // simulate on-disk update
      },
      now: () => "2026-07-05T00-00-00",
    };

    sweepLegacyCodexConfig(deps); // first run strips
    const writesAfterFirst = record.writes.length;
    expect(writesAfterFirst).toBeGreaterThan(0);

    sweepLegacyCodexConfig(deps); // second run — no marker now
    expect(record.writes.length).toBe(writesAfterFirst); // no additional writes
  });

  it("never throws even if writeFile fails", () => {
    const contents = [START_MARKER, "[mcp_servers.libi]", END_MARKER].join("\n");
    const deps: SweepDeps = {
      isCanonical: () => true,
      codexHome: "/fake/codex",
      ownedNames: OWNED,
      readFile: () => contents,
      writeFile: () => {
        throw new Error("disk full");
      },
      now: () => "2026-07-05T00-00-00",
    };

    expect(() => sweepLegacyCodexConfig(deps)).not.toThrow();
  });
});
