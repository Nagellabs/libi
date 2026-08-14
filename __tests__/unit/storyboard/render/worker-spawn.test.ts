// __tests__/unit/storyboard/render/worker-spawn.test.ts
//
// How the isolated storyboard render worker is LAUNCHED. Separate from
// index.test.ts because these tests mock the node-runtime resolver, which the
// real-render tests in that file need unmocked.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The whole point of the fix: the worker is spawned with a REAL node, never
// `process.execPath` (which under the packaged app is the Electron binary with
// `runAsNode` fused off — spawning it boots a second Libi GUI). Mocking the
// resolver is what lets us assert that without depending on the host machine.
vi.mock("@/lib/runtime/node-runtime", () => ({
  resolveNodeCommand: () => "/fake/libi/bin/node",
}));

const { resolveWorkerSpawn, workerReadScopes } = await import("@/lib/storyboard/render");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-worker-spawn-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function touch(abs: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "");
}

/** A source checkout: `.ts` worker + tsx, not under node_modules. */
function makeSourceTree(): string {
  const root = path.join(tmp, "checkout");
  touch(path.join(root, "lib/storyboard/render/worker-entry.ts"));
  touch(path.join(root, "node_modules/tsx/dist/cli.mjs"));
  return root;
}

/** An installed copy with npm-HOISTED deps: the package sits at
 *  `<x>/node_modules/@nagellabs/libi`, its dependencies at `<x>/node_modules`. */
function makeInstalledTree(): { root: string; hoisted: string } {
  const base = path.join(tmp, "install");
  const root = path.join(base, "node_modules/@nagellabs/libi");
  touch(path.join(root, "dist-cli/lib/storyboard/render/worker-entry.js"));
  touch(path.join(root, "lib/storyboard/render/worker-entry.ts"));
  touch(path.join(base, "node_modules/tsx/dist/cli.mjs"));
  return { root, hoisted: path.join(base, "node_modules") };
}

describe("workerReadScopes", () => {
  it("includes the hoisted node_modules that is a SIBLING of the package root", () => {
    const { root, hoisted } = makeInstalledTree();
    const scopes = workerReadScopes(root);
    expect(scopes).toContain(root);
    // Without this the compiled worker dies at its first `require` with
    // ERR_ACCESS_DENIED — the loader's readPackageJSON is permission-checked.
    expect(scopes).toContain(hoisted);
  });

  it("includes a nested node_modules inside the package root", () => {
    const root = path.join(tmp, "pkg");
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    expect(workerReadScopes(root)).toContain(path.join(root, "node_modules"));
  });

  it("never repeats a scope and always leads with the project root", () => {
    const { root } = makeInstalledTree();
    const scopes = workerReadScopes(root);
    expect(scopes[0]).toBe(root);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it("terminates on a tree with no node_modules anywhere", () => {
    const root = path.join(tmp, "bare");
    fs.mkdirSync(root, { recursive: true });
    expect(workerReadScopes(root, () => false)).toEqual([root]);
  });
});

describe("resolveWorkerSpawn", () => {
  it("uses a real node, not process.execPath, in source mode", () => {
    const { command, args } = resolveWorkerSpawn(makeSourceTree());
    expect(command).toBe("/fake/libi/bin/node");
    expect(command).not.toBe(process.execPath);
    expect(args).toContain("--import");
    expect(args).toContain("tsx");
  });

  it("uses a real node, not process.execPath, in compiled mode", () => {
    const { root } = makeInstalledTree();
    const { command, args } = resolveWorkerSpawn(root);
    expect(command).toBe("/fake/libi/bin/node");
    expect(command).not.toBe(process.execPath);
    // The compiled twin build-cli.js emits — NOT `lib/…/worker-entry.js`, which
    // nothing produces and which the old prod branch pointed at.
    expect(args.at(-1)).toBe(path.join(root, "dist-cli/lib/storyboard/render/worker-entry.js"));
  });

  it("refuses tsx for a copy installed under node_modules, even with tsx right there", () => {
    // A nested (unhoisted) install puts tsx inside the package's OWN
    // node_modules, so the "is tsx present" probe alone would happily pick
    // source mode. It must not: tsx skips the tsconfig `paths` matcher for any
    // file under a node_modules segment, so every `@/…` import in this render
    // tree would throw MODULE_NOT_FOUND at load. The compiled tree is the only
    // correct answer here.
    const { root } = makeInstalledTree();
    touch(path.join(root, "node_modules/tsx/dist/cli.mjs"));
    const { args } = resolveWorkerSpawn(root);
    expect(args).not.toContain("--import");
    expect(args.join(" ")).not.toContain("worker-entry.ts");
    expect(args.at(-1)).toBe(path.join(root, "dist-cli/lib/storyboard/render/worker-entry.js"));
  });

  it("grants every read scope the compiled worker needs", () => {
    const { root, hoisted } = makeInstalledTree();
    const { args } = resolveWorkerSpawn(root);
    expect(args).toContain(`--allow-fs-read=${root}`);
    expect(args).toContain(`--allow-fs-read=${hoisted}`);
  });

  it("keeps the RCE boundary shut in BOTH modes", () => {
    for (const root of [makeSourceTree(), makeInstalledTree().root]) {
      const { args } = resolveWorkerSpawn(root);
      // The permission model must be ON …
      expect(args.some((a) => a === "--permission" || a === "--experimental-permission")).toBe(true);
      // … and these two are the RCE primitives. Never grant them.
      expect(args.some((a) => a.startsWith("--allow-fs-write"))).toBe(false);
      expect(args.some((a) => a.startsWith("--allow-child-process"))).toBe(false);
    }
  });

  it("throws a named error when no worker entry exists at all", () => {
    const root = path.join(tmp, "empty");
    fs.mkdirSync(root, { recursive: true });
    // Previously this returned a path nothing produces and let the spawn hang
    // for the full 20s render timeout.
    expect(() => resolveWorkerSpawn(root)).toThrow(/storyboard render worker not found/);
  });

  it("strips provider secrets from the spawned env in compiled mode", () => {
    const { root } = makeInstalledTree();
    process.env.LIBI_WORKER_SPAWN_PROBE_API_KEY = "sk-secret";
    try {
      const { env } = resolveWorkerSpawn(root);
      expect(env.LIBI_WORKER_SPAWN_PROBE_API_KEY).toBeUndefined();
    } finally {
      delete process.env.LIBI_WORKER_SPAWN_PROBE_API_KEY;
    }
  });
});
