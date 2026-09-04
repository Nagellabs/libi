import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getKnownWindow,
  recordWindow,
  resetModelWindowCacheForTests,
} from "@/lib/sessions/model-window-cache";

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-window-cache-"));
  prevHome = process.env.LIBI_HOME;
  process.env.LIBI_HOME = dir;
  resetModelWindowCacheForTests();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  resetModelWindowCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("model-window-cache", () => {
  it("returns null for a never-observed (agent, model)", () => {
    expect(getKnownWindow("claude-code", "claude-fable-5")).toBeNull();
  });

  it("records a window and reads it back, keyed by agent AND model", () => {
    recordWindow("claude-code", "claude-fable-5", 1_000_000);
    expect(getKnownWindow("claude-code", "claude-fable-5")).toBe(1_000_000);
    expect(getKnownWindow("claude-code", "haiku")).toBeNull();
    expect(getKnownWindow("codex", "claude-fable-5")).toBeNull();
  });

  it("persists across a process restart (simulated by dropping memory)", () => {
    recordWindow("claude-code", "claude-fable-5", 1_000_000);
    resetModelWindowCacheForTests();
    expect(getKnownWindow("claude-code", "claude-fable-5")).toBe(1_000_000);
  });

  it("lets a later record displace an earlier one (genuine downgrade)", () => {
    recordWindow("claude-code", "sonnet", 1_000_000);
    recordWindow("claude-code", "sonnet", 200_000);
    resetModelWindowCacheForTests();
    expect(getKnownWindow("claude-code", "sonnet")).toBe(200_000);
  });

  it("ignores invalid sizes and empty keys", () => {
    recordWindow("claude-code", "m", 0);
    recordWindow("claude-code", "m", -5);
    recordWindow("claude-code", "m", Number.NaN);
    recordWindow("", "m", 100);
    recordWindow("claude-code", "", 100);
    expect(getKnownWindow("claude-code", "m")).toBeNull();
  });

  it("starts empty on a corrupt file and can record over it", () => {
    fs.writeFileSync(path.join(dir, "model-windows.json"), "{not json");
    expect(getKnownWindow("claude-code", "claude-fable-5")).toBeNull();
    recordWindow("claude-code", "claude-fable-5", 1_000_000);
    resetModelWindowCacheForTests();
    expect(getKnownWindow("claude-code", "claude-fable-5")).toBe(1_000_000);
  });

  it("drops malformed entries while keeping valid ones on load", () => {
    fs.writeFileSync(
      path.join(dir, "model-windows.json"),
      JSON.stringify({
        "claude-code": { good: 500_000, bad: "1m", worse: -1 },
        broken: null,
      }),
    );
    expect(getKnownWindow("claude-code", "good")).toBe(500_000);
    expect(getKnownWindow("claude-code", "bad")).toBeNull();
    expect(getKnownWindow("claude-code", "worse")).toBeNull();
  });
});
