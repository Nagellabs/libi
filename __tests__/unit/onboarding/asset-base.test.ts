/**
 * The shipping asset base must stay behind the full SSRF guard. A
 * loopback-reachable default would let a URL that merely resolves to a
 * private address be fetched by every install on earth — and the entire
 * reason the build routes through the shared download path is to inherit
 * that guard, not to route around it.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  resolveAssetSource,
  assetUrl,
  DEFAULT_ONBOARDING_ASSET_BASE,
} from "@/lib/onboarding/piece/asset-base";
import { assertPublicHttpUrl } from "@/lib/net/url-guard";
import { ONBOARDING_ASSETS_V1 } from "@/lib/onboarding/piece/v1/assets";

const ENV = "LIBI_ONBOARDING_ASSET_BASE";
afterEach(() => {
  delete process.env[ENV];
});

describe("resolveAssetSource", () => {
  it("defaults to the public bucket behind assertPublicHttpUrl", () => {
    delete process.env[ENV];
    const s = resolveAssetSource("v1");
    expect(s.baseUrl).toBe(`${DEFAULT_ONBOARDING_ASSET_BASE}/v1`);
    expect(s.overridden).toBe(false);
    expect(s.guard).toBe(assertPublicHttpUrl);
  });

  it("relaxes the guard ONLY when the env var overrode the base", () => {
    process.env[ENV] = "http://127.0.0.1:51999/fixtures";
    const s = resolveAssetSource("v1");
    expect(s.overridden).toBe(true);
    expect(s.guard).not.toBe(assertPublicHttpUrl);
  });

  it("builds per-slug urls with no double slash", () => {
    process.env[ENV] = "http://127.0.0.1:51999/fixtures/";
    const s = resolveAssetSource("v1");
    expect(assetUrl(s, "logo-mark.png")).toBe(
      "http://127.0.0.1:51999/fixtures/v1/logo-mark.png",
    );
  });

  it("rejects an override that is not http(s)", () => {
    process.env[ENV] = "file:///etc";
    expect(() => resolveAssetSource("v1")).toThrow(/http/i);
  });

  it("the relaxed guard has exactly one production call site", () => {
    // Grep-level containment: this guard exists for one env-gated branch. If a
    // second file reaches for it, the containment argument is gone and this
    // fails loudly rather than in a security review a year from now.
    //
    // The roots below are every place non-test TypeScript lives, INCLUDING the
    // repo root's own config/instrumentation files. The guard's doc comment
    // promises "exactly one non-test call site" without qualification, so a
    // scan that skipped components/, hooks/ or bin/ would let the comment
    // become a lie without anything failing.
    const hits: string[] = [];
    const scanFile = (p: string) => {
      if (!/\.tsx?$/.test(path.basename(p))) return;
      const src = fs.readFileSync(p, "utf8");
      if (src.includes("assertDevLoopbackOrPublicHttpUrl") && !p.endsWith("url-guard.ts")) {
        hits.push(path.relative(process.cwd(), p));
      }
    };
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p);
          continue;
        }
        scanFile(p);
      }
    };
    for (const r of [
      "lib",
      "mcp",
      "app",
      "scripts",
      "electron",
      "components",
      "hooks",
      "bin",
    ]) {
      const dir = path.join(process.cwd(), r);
      if (fs.existsSync(dir)) walk(dir);
    }
    // Repo-root .ts files (next.config.ts, instrumentation.ts, proxy.ts, …) —
    // scanned non-recursively so this doesn't descend into __tests__/ or e2e/.
    for (const e of fs.readdirSync(process.cwd(), { withFileTypes: true })) {
      if (e.isFile()) scanFile(path.join(process.cwd(), e.name));
    }
    expect(hits).toEqual(["lib/onboarding/piece/asset-base.ts"]);
  });

  it("refuses a version or slug that is not a single path segment", () => {
    // `..` normalizes away at the HTTP layer, so a traversal-shaped version
    // would silently rebase every download on the bucket root rather than
    // failing. Constants today — asserted so it stays that way.
    delete process.env[ENV];
    expect(() => resolveAssetSource("../..")).toThrow(/invalid onboarding asset version/);
    expect(() => resolveAssetSource("v1/extra")).toThrow(/invalid onboarding asset version/);
    expect(() => resolveAssetSource("")).toThrow(/invalid onboarding asset version/);

    const s = resolveAssetSource("v1");
    expect(() => assetUrl(s, "../secrets.txt")).toThrow(/invalid onboarding asset slug/);
    expect(() => assetUrl(s, "nested/logo.png")).toThrow(/invalid onboarding asset slug/);
  });

  it("accepts every slug the shipping manifest actually pins", () => {
    // The segment rule must not be stricter than the slugs Task 1 generated —
    // a rule that rejects real assets fails the build, not an attacker.
    delete process.env[ENV];
    const s = resolveAssetSource("v1");
    for (const asset of ONBOARDING_ASSETS_V1) {
      expect(assetUrl(s, asset.slug)).toBe(`${s.baseUrl}/${asset.slug}`);
    }
  });
});
