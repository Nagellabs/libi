// B2a — reclaim staged runtimes the loader can never select again.
//
// Since the A0b fix, selection is by VERSION across every candidate: each
// staged prefix and the bundled snapshot alike. So once a shell update raises
// the bundled version, any staged runtime at or below it is unreachable by
// definition — bundled outranks it on version and wins the tie too.
//
// `pruneUserRuntimes`' keep-2 rule cannot catch these. Its job is rollback, so
// it counts versions, and a user holding exactly ONE stale staged runtime
// keeps it forever. That is the observed case on a real machine: 0.1.1 staged,
// shell updated to 0.1.3, 1.3 GB stranded.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pruneRuntimesBelowBundled } from "@/lib/runtime/runtime-prune";

let root: string;

function stage(...versions: string[]): void {
  for (const v of versions) {
    fs.mkdirSync(path.join(root, v, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, v, "marker"), v);
  }
}

const staged = (): string[] => fs.readdirSync(root).sort();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-prune-bundled-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("pruneRuntimesBelowBundled", () => {
  // THE observed case, and the one keep-2 cannot reach.
  it("removes a lone staged runtime older than bundled", () => {
    stage("0.1.1");
    const { removed } = pruneRuntimesBelowBundled({ bundledVersion: "0.1.3", rootDir: root });
    expect(removed).toHaveLength(1);
    expect(staged()).toEqual([]);
  });

  it("removes one equal to bundled — bundled wins the tie, so it is dead weight", () => {
    stage("0.1.3");
    pruneRuntimesBelowBundled({ bundledVersion: "0.1.3", rootDir: root });
    expect(staged()).toEqual([]);
  });

  // Rollback must not be weakened: anything newer than bundled is still
  // selectable AND is still the thing a broken newer runtime falls back to.
  it("keeps anything newer than bundled", () => {
    stage("0.1.4", "0.1.7");
    pruneRuntimesBelowBundled({ bundledVersion: "0.1.3", rootDir: root });
    expect(staged()).toEqual(["0.1.4", "0.1.7"]);
  });

  it("prunes only the unreachable half of a mixed set", () => {
    stage("0.1.1", "0.1.3", "0.1.5");
    pruneRuntimesBelowBundled({ bundledVersion: "0.1.3", rootDir: root });
    expect(staged()).toEqual(["0.1.5"]);
  });

  // Deleting the tree you are executing out of is a uniquely bad way to save
  // disk. A staged runtime CAN be the running one.
  it("never deletes the running prefix, even when it is older than bundled", () => {
    stage("0.1.1");
    pruneRuntimesBelowBundled({
      bundledVersion: "0.1.3",
      protectPrefix: path.join(root, "0.1.1"),
      rootDir: root,
    });
    expect(staged()).toEqual(["0.1.1"]);
  });

  // An older shell publishes no bundled version. "Unknown" must never be read
  // as "everything is stale" — that would delete every staged runtime a user
  // has, on the first boot after a downgrade.
  it("prunes NOTHING when the bundled version is unknown", () => {
    stage("0.1.1", "0.1.2");
    const { removed } = pruneRuntimesBelowBundled({ bundledVersion: null, rootDir: root });
    expect(removed).toEqual([]);
    expect(staged()).toEqual(["0.1.1", "0.1.2"]);
  });

  it("leaves installer debris and dotted entries to the other sweep", () => {
    stage("0.1.1");
    fs.mkdirSync(path.join(root, ".tmp-abc"), { recursive: true });
    fs.mkdirSync(path.join(root, "0.1.2.old-1"), { recursive: true });
    pruneRuntimesBelowBundled({ bundledVersion: "0.1.3", rootDir: root });
    expect(staged()).toEqual([".tmp-abc", "0.1.2.old-1"]);
  });

  it("is a no-op on a home with no runtime directory at all", () => {
    const missing = path.join(root, "nope");
    expect(() => pruneRuntimesBelowBundled({ bundledVersion: "0.1.3", rootDir: missing })).not.toThrow();
  });
});
