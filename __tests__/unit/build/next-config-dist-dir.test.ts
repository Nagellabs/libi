import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `npm run test:e2e` spawns `node bin/libi.js`, which runs `next dev` in the
 * checkout. Next 16 locks `<distDir>/dev/lock` for a dev server, so with the
 * default `.next` a dev app already running in the same checkout made the
 * e2e server die with "Another next dev server is already running" — which is
 * why 0.1.16's web e2e last ran on an older commit than the one it shipped.
 *
 * `LIBI_NEXT_DIST_DIR` gives the e2e server its own Next dir. Unset (every
 * production path: lib/server/next-server.ts, lib/cli/studio.ts, the release
 * build), Next builds into and serves from `.next` exactly as before.
 */
const ROOT = path.resolve(__dirname, "..", "..", "..");

type NextConfigShape = { distDir?: string };

/** The config Next gets in `phase`: the module exports a function of the phase. */
async function loadNextConfig(phase: string = PHASE_DEVELOPMENT_SERVER): Promise<NextConfigShape> {
  vi.resetModules();
  const mod = (await import("../../../next.config")) as {
    default: NextConfigShape | ((phase: string, ctx: { defaultConfig: object }) => NextConfigShape);
  };
  return typeof mod.default === "function" ? mod.default(phase, { defaultConfig: {} }) : mod.default;
}

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("next.config.ts distDir", () => {
  it("is `.next` when LIBI_NEXT_DIST_DIR is unset (every production path)", async () => {
    delete process.env.LIBI_NEXT_DIST_DIR;
    expect((await loadNextConfig()).distDir).toBe(".next");
  });

  it("is the variable's value in the dev-server phase (the e2e servers), whatever NODE_ENV says", async () => {
    process.env.LIBI_NEXT_DIST_DIR = ".next-e2e";
    // `next dev` keeps an inherited NODE_ENV; the phase, not NODE_ENV, decides.
    (process.env as Record<string, string>).NODE_ENV = "test";
    expect((await loadNextConfig(PHASE_DEVELOPMENT_SERVER)).distDir).toBe(".next-e2e");
  });

  // `next build` and `next({ dev: false })` (the packaged app, npx) re-read this file:
  // a value left exported in the shell must not move them.
  it.each([["build", PHASE_PRODUCTION_BUILD], ["the production server", PHASE_PRODUCTION_SERVER]])(
    "stays `.next` for %s with LIBI_NEXT_DIST_DIR set",
    async (_name, phase) => {
      process.env.LIBI_NEXT_DIST_DIR = ".next-e2e";
      (process.env as Record<string, string>).NODE_ENV = "development";
      expect((await loadNextConfig(phase)).distDir).toBe(".next");
    },
  );
});

describe("playwright.config.ts", () => {
  let home = "";
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pw-config-"));
    // Pose as a worker re-loading the config: the ports count as already checked,
    // so importing it probes nothing, and every scratch path lands in `home`.
    process.env.LIBI_E2E_PORT = "3799";
    process.env.LIBI_E2E_PORTS_CHECKED = "3799,3800";
    process.env.LIBI_E2E_HOME = home;
    delete process.env.LIBI_TEST_AGENT_CLI_DIRS;
    delete process.env.LIBI_E2E_USER_HOME;
    delete process.env.LIBI_FAKE_ZERNIO_CONFIG;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(`${home}-fake-cli`, { recursive: true, force: true });
  });

  it("gives the web e2e server its own Next dir, so it runs beside a dev app from the same checkout", async () => {
    vi.resetModules();
    const config = (await import("../../../playwright.config")).default as {
      webServer: { env: Record<string, string> };
    };
    expect(config.webServer.env.LIBI_NEXT_DIST_DIR).toBe(".next-e2e");
  });

  it("puts next-env.d.ts back after the run (`next dev` points it at the e2e dir)", async () => {
    vi.resetModules();
    const config = (await import("../../../playwright.config")).default as { globalTeardown?: string };
    expect(config.globalTeardown).toBe("./e2e/support/global-teardown.ts");
    expect(fs.existsSync(path.join(ROOT, "e2e", "support", "global-teardown.ts"))).toBe(true);
  });
});

describe("e2e/support/harness.ts next-env.d.ts snapshot", () => {
  let root = "";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-next-env-"));
    delete process.env.LIBI_E2E_NEXT_ENV_DTS;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("restores what the runner saw before the e2e server rewrote it", async () => {
    const { rememberNextEnvDts, restoreNextEnvDts } = await import("../../../e2e/support/harness");
    const file = path.join(root, "next-env.d.ts");
    fs.writeFileSync(file, 'import "./.next/dev/types/routes.d.ts";\n');
    rememberNextEnvDts(root);
    fs.writeFileSync(file, 'import "./.next-e2e/dev/types/routes.d.ts";\n');
    // A worker re-loading the config must not overwrite the runner's snapshot.
    rememberNextEnvDts(root);
    restoreNextEnvDts(root);
    expect(fs.readFileSync(file, "utf8")).toBe('import "./.next/dev/types/routes.d.ts";\n');
  });

  it("removes a next-env.d.ts the run created where there was none", async () => {
    const { rememberNextEnvDts, restoreNextEnvDts } = await import("../../../e2e/support/harness");
    rememberNextEnvDts(root);
    fs.writeFileSync(path.join(root, "next-env.d.ts"), "x");
    restoreNextEnvDts(root);
    expect(fs.existsSync(path.join(root, "next-env.d.ts"))).toBe(false);
  });
});

describe("the e2e Next dirs stay out of git and out of the type-check", () => {
  const E2E_DIST_DIRS = [".next-e2e", ".next-electron-e2e", ".next-skill-eval"];

  it.each(E2E_DIST_DIRS)("%s is gitignored", (dir) => {
    const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    expect(gitignore).toContain(`/${dir}/`);
  });

  // `next dev` appends `<distDir>/types/**/*.ts` and `<distDir>/dev/types/**/*.ts`
  // to tsconfig.json's `include` when they are missing — a tracked-file edit on
  // every e2e run. Listing them keeps the file untouched; excluding the dir keeps
  // tsc from reading a second copy of Next's global route types.
  it.each(E2E_DIST_DIRS)("tsconfig.json already lists %s's type globs and excludes the dir", (dir) => {
    const raw = fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const tsconfig = JSON.parse(raw) as { include: string[]; exclude: string[] };
    expect(tsconfig.include).toEqual(expect.arrayContaining([`${dir}/types/**/*.ts`, `${dir}/dev/types/**/*.ts`]));
    expect(tsconfig.exclude).toContain(dir);
  });

  it.each(E2E_DIST_DIRS)("%s is ignored by eslint (it is build output)", (dir) => {
    const eslintConfig = fs.readFileSync(path.join(ROOT, "eslint.config.mjs"), "utf8");
    expect(eslintConfig).toContain(`"${dir}/**"`);
  });

  it.each(E2E_DIST_DIRS)("%s is left out of production file tracing", async (dir) => {
    delete process.env.LIBI_NEXT_DIST_DIR;
    const config = (await loadNextConfig(PHASE_PRODUCTION_BUILD)) as { outputFileTracingExcludes?: Record<string, string[]> };
    expect(config.outputFileTracingExcludes?.["*"]).toContain(`${dir}/**`);
  });
});

describe("the release build", () => {
  it("never inherits LIBI_NEXT_DIST_DIR: it builds `.next`, which everything after it reads", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "next-build-release.js"), "utf8");
    const dropped = src.indexOf("delete env.LIBI_NEXT_DIST_DIR");
    expect(dropped).toBeGreaterThan(-1);
    expect(dropped).toBeLessThan(src.indexOf('spawnSync("npx", ["next", "build"]'));
  });
});
