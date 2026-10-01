import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCodexModelWindows,
  codexMaxWindowFor,
} from "@/lib/agents/codex-model-windows";
import { serverLogger } from "@/lib/logger";

// Codex's real `models_cache.json` shape (trimmed to the fields this reader
// uses), matching the facts checked against a live cache 2026-09-27: gpt-6
// family + gpt-5.6-sol all report 272000 / 872000 / 95.
function fixtureCache(models: Array<Record<string, unknown>>) {
  return JSON.stringify({
    fetched_at: "2026-09-27T09:56:45.145575Z",
    etag: 'W/"deadbeef"',
    client_version: "0.155.0",
    identity: "test",
    models,
  });
}

const SOL = { slug: "gpt-6-sol", context_window: 272_000, max_context_window: 872_000, effective_context_window_percent: 95 };
const ASTRA = { slug: "gpt-6-astra", context_window: 272_000, max_context_window: 872_000, effective_context_window_percent: 95 };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-windows-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeCache(models: Array<Record<string, unknown>>) {
  fs.writeFileSync(path.join(dir, "models_cache.json"), fixtureCache(models));
}

describe("readCodexModelWindows / codexMaxWindowFor", () => {
  it("reads sol's max window from a well-shaped fixture cache", () => {
    writeCache([SOL, ASTRA]);
    const windows = readCodexModelWindows({ codexHome: dir });
    expect(windows.get("gpt-6-sol")).toEqual({ contextWindow: 272_000, maxContextWindow: 872_000 });
    expect(codexMaxWindowFor("gpt-6-sol", { codexHome: dir })).toBe(872_000);
  });

  it("returns null for an unknown slug", () => {
    writeCache([SOL]);
    expect(codexMaxWindowFor("gpt-9-nonexistent", { codexHome: dir })).toBeNull();
    expect(readCodexModelWindows({ codexHome: dir }).get("gpt-9-nonexistent")).toBeUndefined();
  });

  it("strips a /<effort> suffix before lookup — slug/high resolves the same as the bare slug", () => {
    writeCache([SOL]);
    expect(codexMaxWindowFor("gpt-6-sol/high", { codexHome: dir })).toBe(872_000);
    expect(codexMaxWindowFor("gpt-6-sol/high", { codexHome: dir })).toBe(
      codexMaxWindowFor("gpt-6-sol", { codexHome: dir }),
    );
  });

  it("maxContextWindow is null when the field is absent or invalid, without dropping the entry", () => {
    writeCache([
      { slug: "no-max", context_window: 100_000 },
      { slug: "bad-max", context_window: 100_000, max_context_window: "lots" },
      { slug: "negative-max", context_window: 100_000, max_context_window: -5 },
    ]);
    const windows = readCodexModelWindows({ codexHome: dir });
    expect(windows.get("no-max")).toEqual({ contextWindow: 100_000, maxContextWindow: null });
    expect(windows.get("bad-max")).toEqual({ contextWindow: 100_000, maxContextWindow: null });
    expect(windows.get("negative-max")).toEqual({ contextWindow: 100_000, maxContextWindow: null });
  });

  it("skips entries with an invalid slug or a non-finite-positive context_window", () => {
    writeCache([
      { slug: "", context_window: 100_000, max_context_window: 200_000 },
      { slug: 42, context_window: 100_000, max_context_window: 200_000 },
      { slug: "no-context-window", max_context_window: 200_000 },
      { slug: "zero-context-window", context_window: 0, max_context_window: 200_000 },
      { slug: "negative-context-window", context_window: -1, max_context_window: 200_000 },
      { slug: "nan-context-window", context_window: Number.NaN, max_context_window: 200_000 },
      SOL,
    ]);
    const windows = readCodexModelWindows({ codexHome: dir });
    expect(windows.size).toBe(1);
    expect(windows.has("gpt-6-sol")).toBe(true);
  });

  it("missing file -> empty map, no throw, one debug log naming the reason", () => {
    const debug = vi.spyOn(serverLogger, "debug").mockImplementation(() => {});
    try {
      const windows = readCodexModelWindows({ codexHome: path.join(dir, "does-not-exist") });
      expect(windows.size).toBe(0);
      expect(codexMaxWindowFor("gpt-6-sol", { codexHome: path.join(dir, "does-not-exist") })).toBeNull();
      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({ tag: "codex-config", op: "models_cache_unreadable" }),
        expect.any(String),
      );
    } finally {
      debug.mockRestore();
    }
  });

  it("bad JSON -> empty map, no throw", () => {
    const debug = vi.spyOn(serverLogger, "debug").mockImplementation(() => {});
    try {
      fs.writeFileSync(path.join(dir, "models_cache.json"), "{ not json ][");
      expect(() => readCodexModelWindows({ codexHome: dir })).not.toThrow();
      expect(readCodexModelWindows({ codexHome: dir }).size).toBe(0);
      expect(debug).toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
  });

  it("wrong shape (no models array) -> empty map, no throw", () => {
    const debug = vi.spyOn(serverLogger, "debug").mockImplementation(() => {});
    try {
      for (const bad of ['{}', '{"models": "nope"}', "[]", '"just a string"', "42"]) {
        fs.writeFileSync(path.join(dir, "models_cache.json"), bad);
        expect(readCodexModelWindows({ codexHome: dir }).size).toBe(0);
      }
      expect(debug).toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
  });

  it("oversize file (> 2 MB) -> empty map, no throw, never parsed", () => {
    const debug = vi.spyOn(serverLogger, "debug").mockImplementation(() => {});
    try {
      const huge = fixtureCache([SOL]) + " ".repeat(2 * 1024 * 1024 + 10);
      fs.writeFileSync(path.join(dir, "models_cache.json"), huge);
      const windows = readCodexModelWindows({ codexHome: dir });
      expect(windows.size).toBe(0);
      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({ tag: "codex-config", op: "models_cache_unreadable" }),
        expect.any(String),
      );
    } finally {
      debug.mockRestore();
    }
  });

  it("memoizes by mtime+size (no re-parse when the file is untouched); re-reads once it actually changes", () => {
    writeCache([SOL]);
    const file = path.join(dir, "models_cache.json");
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      const first = readCodexModelWindows({ codexHome: dir });
      expect(first.get("gpt-6-sol")?.maxContextWindow).toBe(872_000);
      const readsAfterFirst = readSpy.mock.calls.length;
      expect(readsAfterFirst).toBeGreaterThan(0);

      // Nothing changed on disk — a second call must be a memo hit (same Map
      // reference, no further fs.readFileSync), not a second parse.
      const second = readCodexModelWindows({ codexHome: dir });
      expect(second).toBe(first);
      expect(readSpy.mock.calls.length).toBe(readsAfterFirst);

      // Genuinely modify the file (new content, mtime moved well into the
      // future so it can't collide with the original by fs timestamp
      // precision) — the next read must pick up the change.
      writeCache([{ ...SOL, max_context_window: 999_000 }]);
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(file, future, future);
      const third = readCodexModelWindows({ codexHome: dir });
      expect(third.get("gpt-6-sol")?.maxContextWindow).toBe(999_000);
      expect(readSpy.mock.calls.length).toBeGreaterThan(readsAfterFirst);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("never writes, creates or touches anything under the fixture dir", () => {
    writeCache([SOL]);
    const before = fs.readdirSync(dir).sort();
    readCodexModelWindows({ codexHome: dir });
    codexMaxWindowFor("gpt-6-sol", { codexHome: dir });
    readCodexModelWindows({ codexHome: path.join(dir, "missing") });
    const after = fs.readdirSync(dir).sort();
    expect(after).toEqual(before);
  });
});
