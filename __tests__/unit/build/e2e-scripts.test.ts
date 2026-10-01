import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorktreeEnv } from "@/lib/dev/worktree-bootstrap";

/**
 * 0.1.16 suites report F3 and F7.
 *
 * F3: Playwright's webServer runs `node bin/libi.js` itself, so `predev`'s
 * native-module repair never ran for an e2e suite. After any `npm ci` (whose
 * `prepare` builds better-sqlite3 for Electron) the spawned libi died in
 * Category A. Both suites now repair first, and `test:electron` also repairs
 * the Electron binary it launches.
 *
 * F7: a worktree boot merged the canonical checkout's `.env.local` (keys and
 * all) into the e2e server. Both e2e servers opt out of that merge with
 * LIBI_NO_ENV_FILES=1. (Next's own loader still reads `.env*` from the
 * checkout the server boots in; this covers only the worktree bootstrap's merge.)
 */
const ROOT = path.resolve(__dirname, "..", "..", "..");
const scripts = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
  .scripts;

describe("package.json e2e pre-hooks", () => {
  it("test:e2e:ui repairs the native-module ABI first too (its server is the same `node bin/libi.js`)", () => {
    expect(scripts["pretest:e2e:ui"]).toBe("node scripts/ensure-native-modules.js");
  });

  it("test:e2e repairs the native-module ABI first", () => {
    expect(scripts["pretest:e2e"]).toBe("node scripts/ensure-native-modules.js");
  });

  it("test:electron repairs both the native-module ABI and the Electron binary first", () => {
    const pre = scripts["pretest:electron"] ?? "";
    expect(pre).toContain("node scripts/ensure-native-modules.js");
    expect(pre).toContain("node scripts/ensure-electron-binary.js");
  });
});

describe("the e2e servers start without the checkout's dotenv files", () => {
  const saved = { ...process.env };
  let home = "";
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-e2e-scripts-"));
    process.env.LIBI_E2E_PORT = "3799";
    process.env.LIBI_E2E_PORTS_CHECKED = "3799,3800";
    process.env.LIBI_E2E_HOME = home;
    process.env.LIBI_ELECTRON_E2E_PORTS_CHECKED = "3477,3478";
    for (const k of ["LIBI_PORT", "LIBI_HOME", "LIBI_ELECTRON_E2E_OWNS_SERVER", "LIBI_ELECTRON_E2E_PORT", "LIBI_ELECTRON_E2E_HOME", "LIBI_TEST_AGENT_CLI_DIRS", "LIBI_E2E_USER_HOME", "LIBI_FAKE_ZERNIO_CONFIG", "LIBI_E2E_OWNED_SCRATCH"]) {
      delete process.env[k];
    }
    // The Electron config creates its home at load: name one here, so nothing is left in /tmp.
    process.env.LIBI_ELECTRON_E2E_HOME = `${home}-el`;
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(`${home}-fake-cli`, { recursive: true, force: true });
    fs.rmSync(`${home}-el`, { recursive: true, force: true });
    fs.rmSync(`${home}-el-fake-cli`, { recursive: true, force: true });
  });

  const configs = {
    "playwright.config": () => import("../../../playwright.config"),
    "playwright.electron.config": () => import("../../../playwright.electron.config"),
  };
  it.each(Object.keys(configs) as Array<keyof typeof configs>)("%s passes LIBI_NO_ENV_FILES=1 to its server", async (name) => {
    vi.resetModules();
    const config = (await configs[name]()).default as unknown as { webServer: { env: Record<string, string> } };
    expect(config.webServer.env.LIBI_NO_ENV_FILES).toBe("1");
  });
});

describe("worktree bootstrap: LIBI_NO_ENV_FILES", () => {
  let tmp = "";
  let wt = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-noenv-"));
    execSync("git init -q -b main", { cwd: tmp });
    execSync("git config user.email t@t && git config user.name t", { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "README"), "x");
    execSync("git add . && git commit -qm init", { cwd: tmp });
    fs.writeFileSync(path.join(tmp, ".env.local"), "FAL_AI=sk_should_not_reach_e2e\n");
    wt = path.join(tmp, "..", `${path.basename(tmp)}-wt`);
    execSync(`git worktree add -q "${wt}" -b feat`, { cwd: tmp });
  });
  afterEach(() => {
    execSync(`git worktree remove --force "${wt}"`, { cwd: tmp });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // The e2e servers pin LIBI_HOME and LIBI_PORT, so the bootstrap sets up no home and picks no port.
  const e2eEnv = { LIBI_HOME: "/tmp/libi-e2e-x", LIBI_PORT: "3799" } as unknown as NodeJS.ProcessEnv;

  it("merges the canonical .env.local by default (a dev app keeps its keys)", async () => {
    const r = await resolveWorktreeEnv({ startPath: wt, cwd: wt, libiRoot: tmp, env: e2eEnv, now: () => "T" });
    expect(r.envOverrides).toEqual({ FAL_AI: "sk_should_not_reach_e2e" });
    expect(r.logLine).toMatch(/\+envFiles=\.env\.local/);
  });

  it("merges nothing, and says nothing about env files, under LIBI_NO_ENV_FILES=1", async () => {
    const r = await resolveWorktreeEnv({ startPath: wt, cwd: wt, libiRoot: tmp, env: { ...e2eEnv, LIBI_NO_ENV_FILES: "1" }, now: () => "T" });
    expect(r.envOverrides).toBeUndefined();
    expect(r.envFiles).toBeUndefined();
    expect(r.logLine).toBeDefined();
    expect(r.logLine).not.toMatch(/envFiles/);
  });
});
