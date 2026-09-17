import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mcpLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  exportLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Drive playwright-core's answer for the verify() cases below.
const pw = vi.hoisted(() => ({ executablePath: "" }));
vi.mock("playwright-core", () => ({
  chromium: { executablePath: () => pw.executablePath },
}));

import { serverLogger } from "@/lib/logger";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { getCustomInstaller, ENSURE_CHROMIUM_INSTALL_SENTINEL } from "@/mcp/registry/installers";
import { LIBI_INSTALLED_MARKER } from "@/lib/server/lifecycle/housekeeping";
import { playwrightChromiumRevision, resolvePlaywrightCoreCli } from "@/lib/playwright/paths";
import { CHROMIUM_DOWNLOAD_MB } from "@/lib/export/chromium-size";

// Chromium left the `libi` core def and is re-homed here: an
// extension row of its own, installed by libi itself inside the
// first canvas export — or from this row's retry chip in Settings.
describe("libi-export bundled def (Canvas export / Chromium)", () => {
  const def = BUNDLED_MCP_SERVERS.find((d) => d.id === "libi-export");

  it("exists as a noServer tier-2 row with chromium as its only, custom-installed dep", () => {
    expect(def).toBeDefined();
    expect(def!.name).toBe("Canvas export (Chromium)");
    expect(def!.core).toBe(false);
    expect(def!.noServer).toBe(true);
    expect(def!.installFlow).toBe("tier-2");
    expect(def!.command).toBe("");
    expect(def!.args).toEqual([]);
    expect(def!.npmUrl).toBeNull();
    // libi installs this itself — there is no agent-followed plan.
    expect(def!.installPlanPath).toBeUndefined();
    expect(def!.dependencies).toHaveLength(1);
    expect(def!.dependencies[0]).toMatchObject({
      binary: "chromium",
      installFlow: "tier-2",
      customInstallerId: "playwright-chromium",
      // On demand: the Settings chip offers Download / Re-download instead of
      // promising an automatic install.
      manualInstall: true,
    });
  });

  it("discloses the same size the export tool and the chip quote, and names the Download button", () => {
    expect(def!.description).toContain(`~${CHROMIUM_DOWNLOAD_MB} MB`);
    expect(def!.description).toMatch(/Download button/);
    expect(def!.description).not.toMatch(/or here/);
  });

  it("no other def carries chromium any more", () => {
    const carriers = BUNDLED_MCP_SERVERS.filter((d) =>
      d.dependencies.some((dep) => dep.binary === "chromium"),
    ).map((d) => d.id);
    expect(carriers).toEqual(["libi-export"]);
  });
});

describe("playwright-chromium installer", () => {
  it("declares no command of its own — every install path goes through ensureChromium", () => {
    // A re-review found two spawn sites (this declaration via
    // execFileAsync, and ensureChromium's streaming spawn) with no shared
    // single-flight: a Settings click mid-export queued a second
    // `playwright install --force` behind playwright's __dirlock and then
    // force-removed the revision the export was about to launch. The
    // declaration is now a sentinel that DependencyManager.runCustomInstaller
    // routes to ensureChromium, which decides `--force` per call.
    const installer = getCustomInstaller("playwright-chromium")!;
    expect(installer.install.command).toBe(ENSURE_CHROMIUM_INSTALL_SENTINEL);
    expect(installer.install.args).toEqual([]);
    expect(installer.install.timeoutMs).toBe(10 * 60_000);
  });

  describe("verify (what 'installed' means)", () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pw-verify-"));
      pw.executablePath = path.join(tmp, "chromium-1217", "chrome-mac-arm64", "chrome");
      fs.mkdirSync(path.dirname(pw.executablePath), { recursive: true });
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it("reports the executable only once Playwright's own INSTALLATION_COMPLETE marker exists beside it", async () => {
      const installer = getCustomInstaller("playwright-chromium")!;
      expect(await installer.verify()).toBeNull();
      // The binary lands early in the zip: an install killed mid-extraction
      // (timeout, cancel, crash) has an executable and no marker. Treating
      // that as installed would make the next export skip the download and
      // launch a broken bundle.
      fs.writeFileSync(pw.executablePath, "");
      expect(await installer.verify()).toBeNull();
      fs.writeFileSync(path.join(tmp, "chromium-1217", "INSTALLATION_COMPLETE"), "");
      expect(await installer.verify()).toBe(pw.executablePath);
    });
  });

  describe("onInstalled (the marker the boot prune reads)", () => {
    let tmp: string;
    let prev: string | undefined;
    let revision: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pw-installer-"));
      prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
      process.env.PLAYWRIGHT_BROWSERS_PATH = tmp;
      revision = playwrightChromiumRevision()!;
      vi.mocked(serverLogger.warn).mockClear();
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("stamps chromium-<pinned revision> as libi-installed after a successful install", () => {
      const dir = path.join(tmp, `chromium-${revision}`);
      fs.mkdirSync(dir, { recursive: true });
      const shell = path.join(tmp, `chromium_headless_shell-${revision}`);
      fs.mkdirSync(shell, { recursive: true });

      getCustomInstaller("playwright-chromium")!.onInstalled!(path.join(dir, "chrome"));

      expect(fs.existsSync(path.join(dir, LIBI_INSTALLED_MARKER))).toBe(true);
      // Not fetched by libi (--no-shell), so not claimed by libi: if another
      // tool put it there, pruning it later would break that tool.
      expect(fs.existsSync(path.join(shell, LIBI_INSTALLED_MARKER))).toBe(false);
    });

    it("never turns a working install into a failure: a missing revision dir is a warning, not a throw", () => {
      expect(() =>
        getCustomInstaller("playwright-chromium")!.onInstalled!("/nowhere/chrome"),
      ).not.toThrow();
      const warned = vi.mocked(serverLogger.warn).mock.calls.map(([f]) => f);
      expect(warned).toContainEqual(
        expect.objectContaining({ tag: "export", op: "chromium_mark" }),
      );
    });
  });
});

describe("lib/playwright/paths", () => {
  it("resolves playwright-core's CLI and the chromium revision beside it", () => {
    const cli = resolvePlaywrightCoreCli();
    expect(cli).toMatch(/node_modules[\\/]playwright-core[\\/]cli\.js$/);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(path.dirname(cli), "browsers.json"), "utf-8"),
    ) as { browsers: Array<{ name: string; revision: string }> };
    const expected = manifest.browsers.find((b) => b.name === "chromium")!.revision;
    expect(playwrightChromiumRevision()).toBe(expected);
  });
});
