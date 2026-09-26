// Dev builds switch between the production and a development templates
// catalog (docs-local/superpowers/specs/2026-09-26-dev-catalog-switch-design.md):
// the setting's validation, its defaults, that packaged builds ignore it, and
// that the Vercel bypass token goes to the development origin and nowhere else.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema/sqlite";
import { redactLiveSecrets, resetLiveSecretsForTests } from "@/lib/security/secret-scrub";
import { redactDeep } from "@/lib/sentry/scrub";

const PROD = "https://libi.nagellabs.com";
const PREVIEW = "https://libi-site-git-templates-nagellabs.vercel.app";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

async function fresh() {
  vi.resetModules();
  const setting = await import("@/lib/templates/cloud/catalog-setting");
  setting.__resetDevBuildForTests();
  const source = await import("@/lib/templates/cloud/catalog-source");
  const db = await import("@/lib/db/settings");
  const origin = await import("@/lib/templates/cloud/catalog-origin");
  return { ...setting, ...source, ...db, ...origin };
}

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
  vi.stubEnv("LIBI_RUNTIME_SOURCE", undefined);
  createTestDb();
  resetLiveSecretsForTests();
});
afterEach(() => {
  resetTestDb();
  vi.unstubAllEnvs();
  vi.resetModules();
  resetLiveSecretsForTests();
});

describe("parseDevOrigin", () => {
  it("takes https anything and http only to this machine, reduced to the origin", async () => {
    const { parseDevOrigin } = await fresh();
    expect(parseDevOrigin(`${PREVIEW}/templates?x=1`)).toEqual({ ok: true, origin: PREVIEW });
    expect(parseDevOrigin("  http://localhost:3300/ ")).toEqual({ ok: true, origin: "http://localhost:3300" });
    expect(parseDevOrigin("http://127.0.0.1:3300")).toEqual({ ok: true, origin: "http://127.0.0.1:3300" });
    for (const bad of ["", "localhost:3300", "http://example.com", "http://192.168.1.2:3300", "ftp://x.vercel.app", "https://u:p@x.vercel.app", "javascript:alert(1)"]) {
      expect(parseDevOrigin(bad).ok, bad).toBe(false);
    }
  });
  it("refuses the production site: that is the Production choice", async () => {
    const { parseDevOrigin } = await fresh();
    expect(parseDevOrigin(`${PROD}/`)).toEqual({ ok: false, error: expect.stringMatching(/production/i) });
  });
  it("refuses the production site in every spelling: trailing dot, %2e, case, default or other port (review M3)", async () => {
    const { parseDevOrigin, parseTemplatesCatalogSetting } = await fresh();
    for (const spelling of [
      "https://libi.nagellabs.com.",
      "https://libi.nagellabs.com..",
      "https://libi.nagellabs.com%2e",
      "https://LIBI.NagelLabs.COM",
      "https://libi.nagellabs.com:443",
      "https://libi.nagellabs.com.:443/templates",
      "https://libi.nagellabs.com:8443",
    ]) {
      expect(parseDevOrigin(spelling), spelling).toEqual({ ok: false, error: expect.stringMatching(/production/i) });
      // A stored value in that spelling (a copied or hand-edited DB) reads as no address.
      expect(parseTemplatesCatalogSetting(JSON.stringify({ choice: "development", devOrigin: spelling, bypassToken: null }))?.devOrigin, spelling).toBeNull();
    }
    // Look-alikes that are NOT production stay development sites.
    expect(parseDevOrigin("https://libi.nagellabs.com.evil.example")).toMatchObject({ ok: true });
    expect(parseDevOrigin("https://staging.libi.nagellabs.com")).toMatchObject({ ok: true });
  });
  it("names only https *.vercel.app origins as Vercel deployments", async () => {
    const { isVercelPreviewOrigin } = await fresh();
    expect(isVercelPreviewOrigin(PREVIEW)).toBe(true);
    expect(isVercelPreviewOrigin("http://libi.vercel.app")).toBe(false);
    expect(isVercelPreviewOrigin("https://vercel.app")).toBe(false);
    expect(isVercelPreviewOrigin("https://libi.vercel.app.evil.com")).toBe(false);
    expect(isVercelPreviewOrigin(`${PREVIEW}/path`)).toBe(false);
    expect(isVercelPreviewOrigin("http://localhost:3300")).toBe(false);
  });
});

describe("describeCatalogSource", () => {
  it("names test mode, production and a development site", async () => {
    const { describeCatalogSource } = await fresh();
    expect(describeCatalogSource("test-mode")).toEqual({ kind: "test-mode", origin: null, host: null });
    expect(describeCatalogSource(PROD)).toEqual({ kind: "production", origin: PROD, host: "libi.nagellabs.com" });
    expect(describeCatalogSource("http://localhost:3300")).toEqual({ kind: "development", origin: "http://localhost:3300", host: "localhost:3300" });
  });
});

describe("the stored value", () => {
  it("reads anything invalid as unset, and a token only beside an origin", async () => {
    const { parseTemplatesCatalogSetting } = await fresh();
    expect(parseTemplatesCatalogSetting("{not json")).toBeNull();
    expect(parseTemplatesCatalogSetting(JSON.stringify({ choice: "development", devOrigin: "http://evil.com", bypassToken: TOKEN }))).toEqual({ choice: "development", devOrigin: null, bypassToken: null });
    expect(parseTemplatesCatalogSetting(JSON.stringify({ choice: "weird", devOrigin: PREVIEW, bypassToken: "short" }))).toEqual({ choice: "production", devOrigin: PREVIEW, bypassToken: null });
  });
  it("is not part of getSettings()", async () => {
    const { setTemplatesCatalogSetting, getSettings } = await fresh();
    setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    expect(JSON.stringify(getSettings())).not.toContain(TOKEN);
    expect(JSON.stringify(getSettings())).not.toContain("vercel");
  });
});

describe("resolveCatalog in a dev build", () => {
  it("defaults to Production when NEXT_PUBLIC_LIBI_SITE_URL is unset", async () => {
    const m = await fresh();
    expect(m.isDevBuild()).toBe(true);
    expect(m.resolveCatalog()).toMatchObject({ devBuild: true, choice: "production", devOrigin: null, active: PROD });
    expect(m.catalogSource()).toBe(PROD);
  });
  it("defaults to Development at NEXT_PUBLIC_LIBI_SITE_URL when it names another site (today's behaviour)", async () => {
    vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", "http://localhost:3300");
    const m = await fresh();
    expect(m.resolveCatalog()).toMatchObject({ choice: "development", devOrigin: "http://localhost:3300", devOriginIsDefault: true, active: "http://localhost:3300" });
  });
  it("follows the stored choice without a restart, both ways", async () => {
    vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", "http://localhost:3300");
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "production", devOrigin: null, bypassToken: null });
    expect(m.catalogSource()).toBe(PROD);
    m.setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    expect(m.catalogSource()).toBe(PREVIEW);
    expect(m.resolveCatalog()).toMatchObject({ hasBypassToken: true, bypassTokenApplies: true, devOriginIsDefault: false });
    m.setTemplatesCatalogSetting({ choice: "production", devOrigin: PREVIEW, bypassToken: TOKEN });
    expect(m.catalogSource()).toBe(PROD);
  });
  it("Development with no address anywhere is Production", async () => {
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "development", devOrigin: null, bypassToken: null });
    expect(m.resolveCatalog()).toMatchObject({ choice: "production", active: PROD });
  });
  it("a pinned scope wins over a switch made meanwhile", async () => {
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: null });
    await m.withCatalogSource(PREVIEW, async () => {
      m.setTemplatesCatalogSetting({ choice: "production", devOrigin: PREVIEW, bypassToken: null });
      await new Promise((r) => setTimeout(r, 1));
      expect(m.catalogSource()).toBe(PREVIEW);
      expect(m.catalogBucketBaseFor()).toBe("https://storage.googleapis.com/libi-dev-templates/");
    });
    expect(m.catalogSource()).toBe(PROD);
    expect(m.catalogBucketBaseFor()).toBe("https://storage.googleapis.com/libi-prod-templates/");
  });
  it("can report uses to both of its catalogs", async () => {
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "production", devOrigin: PREVIEW, bypassToken: null });
    expect(m.reachableCatalogSources()).toEqual([PROD, PREVIEW]);
  });
  it("test mode is the fixture whatever is stored, and never sends the token", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    expect(m.catalogSource()).toBe("test-mode");
    expect(m.reachableCatalogSources()).toEqual(["test-mode"]);
    expect(m.bypassHeadersFor(`${PREVIEW}/api/templates/index`)).toEqual({});
  });
});

describe("a packaged build ignores the stored setting", () => {
  it("reads its own site, sends no token, and reports to its own site only — a copied DB can't redirect it", async () => {
    vi.stubEnv("LIBI_RUNTIME_SOURCE", "bundled");
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    expect(m.isDevBuild()).toBe(false);
    expect(m.resolveCatalog()).toMatchObject({ devBuild: false, choice: "production", devOrigin: null, hasBypassToken: false, active: PROD });
    expect(m.catalogSource()).toBe(PROD);
    expect(m.reachableCatalogSources()).toEqual([PROD]);
    expect(m.bypassHeadersFor(`${PREVIEW}/api/templates/index`)).toEqual({});
    expect(m.bypassTokenForScrub()).toBeNull();
  });
  it("a staged runtime (`user`) is not a dev build either", async () => {
    vi.stubEnv("LIBI_RUNTIME_SOURCE", "user");
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "development", devOrigin: "http://localhost:3300", bypassToken: null });
    expect(m.catalogSource()).toBe(PROD);
  });
});

describe("bypassHeadersFor", () => {
  it("is the header only for https requests to exactly the stored Vercel origin", async () => {
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    expect(m.bypassHeadersFor(`${PREVIEW}/api/templates/index`)).toEqual({ "x-vercel-protection-bypass": TOKEN });
    for (const other of [
      `${PROD}/api/templates/index`,
      "https://storage.googleapis.com/libi-dev-templates/templates/x/v1/poster.jpg",
      "https://storage.googleapis.com/libi-dev-templates/tmp/x/v1/example.mp4?X-Goog-Signature=abc",
      "https://someone-else.vercel.app/api/templates/index",
      `${PREVIEW}.evil.com/api/templates/index`,
      PREVIEW.replace("https:", "http:") + "/api/templates/index",
      "not a url",
    ]) {
      expect(m.bypassHeadersFor(other), other).toEqual({});
    }
  });
  it("is never sent while the development origin is not a Vercel deployment", async () => {
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "development", devOrigin: "http://localhost:3300", bypassToken: TOKEN });
    expect(m.bypassHeadersFor("http://localhost:3300/api/templates/index")).toEqual({});
    expect(m.resolveCatalog()).toMatchObject({ hasBypassToken: true, bypassTokenApplies: false });
  });
  it("is sent to the development origin even while Production is active (a use report goes to its own catalog)", async () => {
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "production", devOrigin: PREVIEW, bypassToken: TOKEN });
    expect(m.bypassHeadersFor(`${PREVIEW}/api/templates/abcdefghijklmnopqrst/use`)).toEqual({ "x-vercel-protection-bypass": TOKEN });
    expect(m.bypassHeadersFor(`${PROD}/api/templates/abcdefghijklmnopqrst/use`)).toEqual({});
  });
});

describe("the token is a secret", () => {
  it("is masked in every log line and Sentry payload once this process has read or written it", async () => {
    const m = await fresh();
    m.setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    expect(redactLiveSecrets(`Failed query: update settings params: ${TOKEN}`)).not.toContain(TOKEN);
    expect(JSON.stringify(redactDeep({ message: `boom ${TOKEN}`, extra: { note: TOKEN } }))).not.toContain(TOKEN);
    // A fresh process (the MCP child) registers it on its first read, too.
    resetLiveSecretsForTests();
    expect(redactLiveSecrets(TOKEN)).toBe(TOKEN);
    m.getTemplatesCatalogSetting();
    expect(redactLiveSecrets(TOKEN)).not.toContain(TOKEN);
  });
  it("is redacted by key name in Sentry payloads and the logger", async () => {
    expect(redactDeep({ "x-vercel-protection-bypass": "abc", bypassToken: "abc" })).toEqual({ "x-vercel-protection-bypass": "[redacted]", bypassToken: "[redacted]" });
  });
  it("a failed write never carries the token in its error", async () => {
    const m = await fresh();
    getDb().run("DROP TABLE settings" as never);
    let thrown: unknown;
    try {
      m.setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(m.TemplatesCatalogWriteError);
    expect(String((thrown as Error).message)).not.toContain(TOKEN);
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    void settings;
  });
});

describe("the app CSP", () => {
  it("gains nothing for a development catalog: no *.vercel.app, and both buckets were already there", async () => {
    vi.resetModules();
    const { buildCsp } = await import("@/lib/security/csp");
    const csp = buildCsp();
    expect(csp).not.toContain("vercel.app");
    expect(csp).toContain("https://storage.googleapis.com/libi-dev-templates/");
    expect(csp).toContain("https://storage.googleapis.com/libi-prod-templates/");
  });
});

describe("a dev build is decided from libi's own code, never the caller's cwd (review I1)", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "libi-devbuild-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    vi.doUnmock("@/lib/runtime/package-root");
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  /** An installed libi (npm/npx) and a user's project that is itself a git worktree checkout. */
  function layout() {
    const installed = path.join(tmp(), "_npx", "abc", "node_modules", "@nagellabs", "libi");
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "@nagellabs/libi", version: "0.1.16" }));
    const project = path.join(tmp(), "my-project", ".claude", "worktrees", "feature");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "my-project" }));
    fs.mkdirSync(path.join(project, ".git"));
    return { installed, project };
  }

  it("isDevBuildAt: an installed package root is not dev, a checkout root is", async () => {
    const m = await fresh();
    const { installed, project } = layout();
    const env = { LIBI_RUNTIME_SOURCE: undefined };
    expect(m.isDevBuildAt(installed, env, false)).toBe(false);
    expect(m.isDevBuildAt(project, env, false)).toBe(true);
    expect(m.isDevBuildAt(process.cwd(), env, false)).toBe(true);
    expect(m.isDevBuildAt(process.cwd(), { LIBI_RUNTIME_SOURCE: "bundled" }, false)).toBe(false);
  });

  it("an npx-installed `serve-mcp` started inside a git worktree reads Production, ignores the stored Development choice and never sends the token", async () => {
    const { installed, project } = layout();
    vi.doMock("@/lib/runtime/package-root", () => ({ packageRoot: () => installed, findPackageRoot: () => installed }));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      const m = await fresh();
      m.setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
      expect(m.isDevBuild()).toBe(false);
      expect(m.catalogSource()).toBe(PROD);
      expect(m.reachableCatalogSources()).toEqual([PROD]);
      expect(m.bypassHeadersFor(`${PREVIEW}/api/templates/index`)).toEqual({});
    } finally {
      cwd.mockRestore();
    }
  });

  it("the real dev checkout still reads the setting, whatever the cwd", async () => {
    const { project } = layout();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      vi.resetModules();
      const setting = await import("@/lib/templates/cloud/catalog-setting");
      setting.__resetDevBuildForTests();
      const db = await import("@/lib/db/settings");
      db.setTemplatesCatalogSetting({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
      expect(setting.isDevBuild()).toBe(true);
      expect(setting.activeCatalogSource()).toBe(PREVIEW);
      expect(setting.bypassHeadersFor(`${PREVIEW}/api/templates/index`)).toEqual({ "x-vercel-protection-bypass": TOKEN });
    } finally {
      cwd.mockRestore();
    }
  });
});
