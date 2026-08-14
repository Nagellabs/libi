import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import {
  getSkillDigestCacheSetting,
  setSkillDigestCacheSetting,
} from "@/lib/db/settings";
import { getBundledSkillDigests, __resetDigestMemoForTests } from "@/mcp/skills/digest";

describe("skill digest cache", () => {
  let bundledRoot: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "digest-cache-"));
    fs.mkdirSync(path.join(bundledRoot, "mcp", "skills", "ai-asset-generation"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundledRoot, "mcp", "skills", "ai-asset-generation", "SKILL.md"),
      "---\nname: ai-asset-generation\ndescription: d\n---\nv1",
    );
    process.chdir(bundledRoot);
    createTestDb();
    __resetDigestMemoForTests();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    resetTestDb();
    fs.rmSync(bundledRoot, { recursive: true, force: true });
  });

  it("settings round-trip: set then get", () => {
    expect(getSkillDigestCacheSetting()).toBeNull();
    setSkillDigestCacheSetting({ version: "1.2.3", digests: { a: "x" } });
    expect(getSkillDigestCacheSetting()).toEqual({
      version: "1.2.3",
      digests: { a: "x" },
    });
  });

  it("returns null on malformed/empty-version stored JSON", () => {
    setSkillDigestCacheSetting({ version: "1", digests: {} });
    setSkillDigestCacheSetting({ version: "", digests: {} });
    expect(getSkillDigestCacheSetting()).toBeNull();
  });

  it("cache mode: reuses stored digests when version matches", () => {
    setSkillDigestCacheSetting({
      version: "9.9.9",
      digests: { "ai-asset-generation": "stored-digest" },
    });
    const d = getBundledSkillDigests({ version: "9.9.9", bypassCache: false });
    expect(d["ai-asset-generation"]).toBe("stored-digest");
  });

  it("cache mode: recomputes + persists when version differs", () => {
    setSkillDigestCacheSetting({
      version: "1.0.0",
      digests: { "ai-asset-generation": "stale-digest" },
    });
    const d = getBundledSkillDigests({ version: "2.0.0", bypassCache: false });
    expect(d["ai-asset-generation"]).toMatch(/^[0-9a-f]{64}$/);
    expect(d["ai-asset-generation"]).not.toBe("stale-digest");
    expect(getSkillDigestCacheSetting()?.version).toBe("2.0.0");
  });

  it("bypass mode: recomputes and does not write the cache", () => {
    const d = getBundledSkillDigests({ version: "3.0.0", bypassCache: true });
    expect(d["ai-asset-generation"]).toMatch(/^[0-9a-f]{64}$/);
    expect(getSkillDigestCacheSetting()).toBeNull();
  });
});
