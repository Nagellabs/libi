import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ACESTEP_VERSION,
  ACESTEP_GIT_REPO,
  ACESTEP_GIT_SHA,
  ACESTEP_MODEL_REPO,
  ACESTEP_MODEL_VERSION,
  ACESTEP_FILES,
  ACESTEP_DOWNLOAD_SIZE_HUMAN,
  DEFAULT_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
  MUSIC_STYLES,
  aceStepModelsDir,
  aceStepModelFilePaths,
  installTokenPath,
  readInstalledToken,
  writeInstalledToken,
  isAceStepModelInstalled,
  estimateGenerationSeconds,
  listMusicStatus,
} from "@/lib/music/models";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-music-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ace-step model catalog", () => {
  it("pins git source + model version + size", () => {
    // PyPI sdist is broken; we install from a pinned commit on the official
    // ACE-Step GitHub repo (Apache-2.0). Reflect that in the version label.
    expect(ACESTEP_GIT_REPO).toBe("https://github.com/ace-step/ACE-Step.git");
    expect(ACESTEP_GIT_SHA).toMatch(/^[a-f0-9]{40}$/);
    expect(ACESTEP_VERSION).toBe(`git+${ACESTEP_GIT_SHA.slice(0, 7)}`);
    expect(ACESTEP_MODEL_REPO).toBe("ACE-Step/ACE-Step-v1-3.5B");
    expect(ACESTEP_MODEL_VERSION).toMatch(/^v1-3\.5B-/);
    expect(ACESTEP_DOWNLOAD_SIZE_HUMAN).toMatch(/GB/);
    expect(ACESTEP_FILES.length).toBeGreaterThan(0);
    expect(ACESTEP_FILES.every((f) => f.relPath && f.url)).toBe(true);
  });

  it("has duration policy + a non-empty style catalog", () => {
    expect(DEFAULT_DURATION_SECONDS).toBe(30);
    expect(MAX_DURATION_SECONDS).toBe(240);
    expect(MUSIC_STYLES.length).toBeGreaterThan(3);
    expect(MUSIC_STYLES.every((s) => s.id && s.label)).toBe(true);
  });

  it("model dir is ~/.libi/models/ace-step (dependency-manager parity)", () => {
    expect(aceStepModelsDir()).toBe(path.join(tmp, "models", "ace-step"));
    expect(installTokenPath()).toBe(
      path.join(tmp, "models", "ace-step", ".install-token"),
    );
  });

  it("install check is version-aware (files AND token)", () => {
    expect(isAceStepModelInstalled()).toBe(false);
    const dir = aceStepModelsDir();
    for (const p of aceStepModelFilePaths()) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "x");
    }
    expect(isAceStepModelInstalled()).toBe(false);
    writeInstalledToken("wrong-version");
    expect(readInstalledToken()).toBe("wrong-version");
    expect(isAceStepModelInstalled()).toBe(false);
    writeInstalledToken(ACESTEP_MODEL_VERSION);
    expect(isAceStepModelInstalled()).toBe(true);
    void dir;
  });

  it("estimateGenerationSeconds scales with duration + device", () => {
    const e30 = estimateGenerationSeconds(30);
    const e60 = estimateGenerationSeconds(60);
    expect(e60).toBeGreaterThan(e30);
    expect(e30).toBeGreaterThan(0);
  });

  it("listMusicStatus reports installed flag + size + duration policy", () => {
    const s = listMusicStatus();
    expect(s.modelInstalled).toBe(false);
    expect(s.downloadSizeHuman).toBe(ACESTEP_DOWNLOAD_SIZE_HUMAN);
    expect(s.defaultDurationSeconds).toBe(30);
    expect(s.maxDurationSeconds).toBe(240);
    expect(Array.isArray(s.styles)).toBe(true);
  });
});
