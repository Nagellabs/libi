// Release-day decisions `release-npm.js` used to leave to the maintainer.
//
// Both cost real time on real release days, and both were "the script knows
// the answer, prints it, and makes a human type it":
//
//  * `dist-electron/` blocked 0.1.2 AND 0.1.3 on consecutive days. The trigger
//    is "opened the desktop shell since the last release".
//  * On 0.1.3 the `patch` run bumped, committed and tagged, then the publish
//    sat at the 2FA browser prompt and was never completed. Re-running the
//    same command would have silently released 0.1.4 and skipped 0.1.3
//    forever; the only thing stopping that was somebody remembering a doc line.
//
// These are pure decisions so the situations above become table rows instead
// of prose. Nothing here touches the network, git, or a real directory.
import { describe, it, expect } from "vitest";

import {
  decideBump,
  decideDistElectron,
  needsVersionPush,
} from "@/scripts/lib/release-preflight.js";

describe("decideDistElectron", () => {
  it("proceeds when the directory is not there", () => {
    expect(
      decideDistElectron({ exists: false, somethingRunning: false, platform: "darwin" }),
    ).toBe("proceed");
  });

  it("removes a stale directory nothing is using", () => {
    expect(
      decideDistElectron({ exists: true, somethingRunning: false, platform: "darwin" }),
    ).toBe("remove");
  });

  // The original refusal was right for THIS case and must survive: a running
  // `npm run electron` loads its entire process tree from that directory.
  it("still refuses when something is running from it", () => {
    expect(
      decideDistElectron({ exists: true, somethingRunning: true, platform: "darwin" }),
    ).toBe("refuse");
  });

  // We cannot ask the liveness question honestly on win32. A release that
  // stops there is an inconvenience; deleting a running app's process tree
  // because a probe silently answered "nothing found" is a bug report.
  it("refuses on win32 regardless of what the probe claims", () => {
    expect(
      decideDistElectron({ exists: true, somethingRunning: false, platform: "win32" }),
    ).toBe("refuse");
  });
});

describe("decideBump", () => {
  const base = {
    pkgVersion: "0.1.3",
    publishedThisVersion: false,
    everPublishedThisVersion: false,
    tagExists: true,
    tagAtHead: true,
    explicitBump: null as string | null,
  };

  it("bumps when the tree is already at a released version", () => {
    expect(decideBump({ ...base, pkgVersion: "0.1.2", publishedThisVersion: true }))
      .toEqual({ action: "bump", bump: "patch" });
  });

  // THE 0.1.3 CASE. Bumped, tagged at HEAD, publish never completed.
  // Re-running `patch` here is what would have skipped 0.1.3 forever.
  it("resumes the publish when the version is bumped, tagged, and not on npm", () => {
    expect(decideBump(base)).toEqual({ action: "publish-as-is" });
  });

  // npm permanently refuses a version number that was unpublished inside its
  // 72h window. Treating the 404 as "free to publish" would pass every gate
  // and die at the very last step.
  it("refuses a version that was published and then unpublished", () => {
    const d = decideBump({ ...base, everPublishedThisVersion: true });
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/never accept/i);
  });

  it("refuses when the tag does not point at HEAD", () => {
    const d = decideBump({ ...base, tagAtHead: false });
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/does not cover/i);
  });

  it("refuses an unpublished, untagged version rather than guessing", () => {
    const d = decideBump({ ...base, tagExists: false, tagAtHead: false });
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/edited by hand/i);
  });

  // Auto-detect decides WHETHER to bump, never how much.
  it("honours an explicit minor even when it would have chosen patch", () => {
    expect(
      decideBump({ ...base, pkgVersion: "0.1.2", publishedThisVersion: true, explicitBump: "minor" }),
    ).toEqual({ action: "bump", bump: "minor" });
  });

  it("honours an explicit none even when it would have bumped", () => {
    expect(
      decideBump({ ...base, pkgVersion: "0.1.2", publishedThisVersion: true, explicitBump: "none" }),
    ).toEqual({ action: "publish-as-is" });
  });

  // An explicit flag is a human overriding the machine, including past a
  // refusal they understand better than this function does.
  it("lets an explicit bump override a state it would have refused", () => {
    expect(
      decideBump({ ...base, everPublishedThisVersion: true, explicitBump: "patch" }),
    ).toEqual({ action: "bump", bump: "patch" });
  });
});

describe("needsVersionPush", () => {
  // The old check asked "did I bump this run?", so on 0.1.3 — where the bump
  // happened in an earlier aborted run — the reminder was suppressed on the
  // one run that needed it.
  it("reminds when the version commit is unpushed even though this run did not bump", () => {
    expect(needsVersionPush({ commitUnpushed: true, tagUnpushed: false })).toBe(true);
  });

  it("reminds when only the tag is unpushed", () => {
    expect(needsVersionPush({ commitUnpushed: false, tagUnpushed: true })).toBe(true);
  });

  it("stays quiet when both are already pushed", () => {
    expect(needsVersionPush({ commitUnpushed: false, tagUnpushed: false })).toBe(false);
  });
});
