// __tests__/unit/templates/cloud/publish-request-media.test.ts
//
// A publish request's own example and poster: where they live, what counts as
// readable, and the sweep of folders no request owns.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPublishRequestId,
  mediaDigest,
  preparingDir,
  promotePreparedMedia,
  publishRequestDir,
  publishRequestsRoot,
  readRequestMedia,
  removePublishRequestMedia,
  sweepPublishRequestMedia,
} from "@/lib/templates/cloud/publish-request-media";
import { CAPS } from "@/lib/templates/cloud/constants";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let home = "";

function stage(dir: string, example: Buffer | null = Buffer.from("ex"), poster: Buffer | null = Buffer.from("po")) {
  fs.mkdirSync(dir, { recursive: true });
  if (example) fs.writeFileSync(path.join(dir, "example.mp4"), example);
  if (poster) fs.writeFileSync(path.join(dir, "poster.jpg"), poster);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-request-media-"));
  process.env.LIBI_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("publish request media", () => {
  it("lives under LIBI_HOME, by request id only — anything else is refused as a path", () => {
    expect(publishRequestDir(A)).toBe(path.join(home, "template-publish-requests", A));
    expect(preparingDir(A)).toBe(path.join(home, "template-publish-requests", ".preparing", A));
    for (const bad of ["", "..", "../x", A.toUpperCase(), `${A}/..`, "x".repeat(36)]) {
      expect(isPublishRequestId(bad), bad).toBe(false);
      expect(() => publishRequestDir(bad), bad).toThrow(/not a publish request id/);
    }
  });

  it("reads both files once, or nothing: missing, a symlink, or over the catalog's cap", async () => {
    stage(publishRequestDir(A));
    const media = await readRequestMedia(A);
    expect(media).toEqual({ example: Buffer.from("ex"), poster: Buffer.from("po") });
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(mediaDigest(media!)).toEqual({ example: sha("ex"), poster: sha("po") });

    fs.rmSync(path.join(publishRequestDir(A), "poster.jpg"));
    expect(await readRequestMedia(A)).toBeNull();
    fs.writeFileSync(path.join(home, "elsewhere.jpg"), "po");
    fs.symlinkSync(path.join(home, "elsewhere.jpg"), path.join(publishRequestDir(A), "poster.jpg"));
    expect(await readRequestMedia(A)).toBeNull();

    stage(publishRequestDir(B), Buffer.alloc(CAPS.example + 1));
    expect(await readRequestMedia(B)).toBeNull();
  });

  it("promotes a preparation into place in one step, and removes a request's folder and preparation", () => {
    stage(preparingDir(A));
    promotePreparedMedia(A);
    expect(fs.existsSync(preparingDir(A))).toBe(false);
    expect(fs.readdirSync(publishRequestDir(A)).sort()).toEqual(["example.mp4", "poster.jpg"]);
    stage(preparingDir(A));
    removePublishRequestMedia(A);
    expect(fs.existsSync(publishRequestDir(A))).toBe(false);
    expect(fs.existsSync(preparingDir(A))).toBe(false);
    // Never throws, never touches a path it wasn't given as an id.
    expect(() => removePublishRequestMedia("../../etc")).not.toThrow();
  });

  it("sweeps folders no request owns and old preparations — never a live request or a running preparation", () => {
    stage(publishRequestDir(A));
    stage(publishRequestDir(B));
    fs.writeFileSync(path.join(publishRequestsRoot(), "stray.txt"), "x");
    stage(preparingDir("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    stage(preparingDir("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
    const old = Date.now() / 1000 - 2 * 24 * 60 * 60;
    fs.utimesSync(preparingDir("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), old, old);

    expect(sweepPublishRequestMedia(new Set([A]))).toBe(3);
    expect(fs.readdirSync(publishRequestsRoot()).sort()).toEqual([".preparing", A]);
    expect(fs.readdirSync(path.join(publishRequestsRoot(), ".preparing"))).toEqual(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
    expect(sweepPublishRequestMedia(new Set([A]))).toBe(0);
  });

  it("a sweep with nothing there is a no-op", () => {
    expect(sweepPublishRequestMedia(new Set())).toBe(0);
  });
});
