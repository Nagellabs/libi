import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Review N1. Inside a Turbopack-bundled Next server libi can't find its own
 * code from `__dirname` (`/ROOT/…`), so whether it is a dev build can't be
 * read from where the code lives. The dev launcher says so instead: the
 * `inDevCheckout()` branch of `bin/libi.js` puts `LIBI_DEV_CHECKOUT_ROOT=<the
 * checkout root>` in the env of the server it spawns, and an installed launch
 * strips an inherited one (lib/templates/cloud/catalog-setting.ts#isMarkedDevCheckout).
 */
const BIN = path.resolve(__dirname, "..", "..", "..", "bin", "libi.js");
const { withDevCheckoutMarker } = createRequire(import.meta.url)(BIN) as {
  withDevCheckoutMarker: (env: Record<string, string | undefined>, devCheckout: boolean, root: string) => Record<string, string | undefined>;
};

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dev-marker-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("bin/libi.js — the dev checkout marker", () => {
  it("a dev checkout's launch carries its root, real-pathed (the server compares it to its own real cwd)", () => {
    const link = path.join(tmp, "link");
    fs.mkdirSync(path.join(tmp, "checkout"));
    fs.symlinkSync(path.join(tmp, "checkout"), link);
    const env = withDevCheckoutMarker({ PATH: "/usr/bin" }, true, link);
    expect(env.LIBI_DEV_CHECKOUT_ROOT).toBe(fs.realpathSync(path.join(tmp, "checkout")));
    expect(env.PATH).toBe("/usr/bin");
  });

  it("an installed launch never carries one, even one inherited from a dev studio's terminal", () => {
    const env = withDevCheckoutMarker({ LIBI_DEV_CHECKOUT_ROOT: "/some/checkout" }, false, tmp);
    expect("LIBI_DEV_CHECKOUT_ROOT" in env).toBe(false);
  });

  it("the env the server is spawned with is the marked one, set for the dev branch", () => {
    const source = fs.readFileSync(BIN, "utf-8");
    const main = source.slice(source.indexOf("if (require.main === module)"));
    const marked = main.indexOf("withDevCheckoutMarker(env, inDevCheckout(), PKG_ROOT)");
    const spawned = main.indexOf("spawn(NODE, launchArgs, { stdio: \"inherit\", env })");
    expect(marked).toBeGreaterThan(0);
    expect(spawned).toBeGreaterThan(marked);
    expect(main.slice(marked, spawned)).not.toMatch(/\benv\s*=\s*\{/);
  });

  it("the real repo's root is what the dev branch marks", () => {
    const env = withDevCheckoutMarker({}, true, path.dirname(path.dirname(BIN)));
    expect(env.LIBI_DEV_CHECKOUT_ROOT).toBe(fs.realpathSync(path.dirname(path.dirname(BIN))));
    expect(fs.existsSync(path.join(env.LIBI_DEV_CHECKOUT_ROOT!, ".git"))).toBe(true);
  });
});
