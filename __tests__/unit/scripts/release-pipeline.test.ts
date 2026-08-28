/**
 * The CI release pipeline's load-bearing invariants.
 *
 * A release workflow is the worst place for a silent regression: it runs a
 * handful of times a year, always under time pressure, and the failure modes
 * are permanent — a release missing a platform's update feed breaks that
 * platform's updater forever, not just for that version. Nothing here can be
 * caught by running the workflow, because running it publishes.
 *
 * So the invariants are asserted against the YAML and the scripts directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { load } from "js-yaml";

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github/workflows/release.yml");
const wf = load(readFileSync(WORKFLOW, "utf8")) as {
  jobs: Record<string, Record<string, unknown>>;
};
const job = (name: string) => {
  const j = wf.jobs[name];
  if (!j) throw new Error(`release.yml has no job "${name}"`);
  return j;
};
const stepsOf = (name: string) =>
  (job(name).steps as Array<Record<string, unknown>>) ?? [];

describe("release.yml: what must never drift", () => {
  it("builds each shell on its own OS", () => {
    // electron-builder rebuilds native modules for the HOST's ABI mid-build,
    // so a cross-built shell ships binaries the app cannot load.
    expect(job("mac")["runs-on"]).toMatch(/^macos-/);
    expect(job("windows")["runs-on"]).toBe("windows-2022");
  });

  it("pins the Windows runner rather than tracking windows-latest", () => {
    // `windows-latest` moved to VS2026, which the lockfile's node-gyp cannot
    // detect: `npm ci` then dies rebuilding node-pty with "Could not find any
    // Visual Studio installation to use". Bump node-gyp before moving this.
    expect(job("windows")["runs-on"]).not.toBe("windows-latest");
  });

  it("publishes to npm before either shell builds", () => {
    // The shell bundles a PUBLISHED runtime (--from-registry), so a shell built
    // before the publish would bundle the previous version.
    for (const shell of ["mac", "windows"]) {
      expect(job(shell).needs).toContain("npm");
    }
  });

  it("gives the npm job an OIDC token and nothing more than it needs", () => {
    const perms = job("npm").permissions as Record<string, string>;
    // Without id-token:write npm silently falls back to an anonymous publish
    // and fails at the very last step, after every gate has run.
    expect(perms["id-token"]).toBe("write");
    expect(perms.contents).toBe("write");
    // The top-level default must stay read so no other job inherits write.
    expect((wf as unknown as { permissions: Record<string, string> }).permissions.contents).toBe("read");
  });

  it("never lets a build job create the GitHub Release", () => {
    // Whichever runner finished first would publish half the artifacts.
    for (const shell of ["mac", "windows"]) {
      const build = stepsOf(shell).map((s) => String(s.run ?? "")).join("\n");
      expect(build).toContain("--no-github-release");
    }
  });

  it("publishes the release only when mac succeeded and Windows did not FAIL", () => {
    // A deliberately skipped Windows leg may still ship; a broken one may not.
    // Shipping mac-only because Windows failed looks identical, in the release
    // list, to shipping mac-only on purpose.
    const cond = String(job("publish").if);
    expect(cond).toContain("needs.mac.result == 'success'");
    expect(cond).toContain("needs.windows.result == 'success'");
    expect(cond).toContain("needs.windows.result == 'skipped'");
  });

  it("declares a missing Windows feed only when Windows was SKIPPED", () => {
    const publish = stepsOf("publish").map((s) => String(s.run ?? "")).join("\n");
    expect(publish).toContain("--allow-missing=win");
    // Guarded on 'skipped' — never on 'failure', which would ship silently.
    expect(publish).toMatch(/needs\.windows\.result == 'skipped'\s*&&\s*'--allow-missing=win'/);
  });

  it("hands both build jobs the commit the gates actually tested", () => {
    // --skip-checks is honoured in CI only against this evidence.
    for (const shell of ["mac", "windows"]) {
      const yaml = JSON.stringify(job(shell));
      expect(yaml).toContain("LIBI_GATES_SHA");
      expect(yaml).toContain("needs.gates.outputs.sha");
      expect(job(shell).needs).toContain("gates");
    }
  });

  it("refuses to publish outside the weekend, with no bypass input", () => {
    // A window anyone can tick off is not a window. Changing it means editing
    // the file, which is a considered act with a diff.
    const guard = stepsOf("window").map((s) => String(s.run ?? "")).join("\n");
    expect(guard).toContain('date -u +%u');
    const inputs = Object.keys(
      ((wf as unknown as { on: { workflow_dispatch: { inputs: object } } }).on)
        .workflow_dispatch.inputs,
    );
    expect(inputs).not.toContain("force");
    expect(inputs).not.toContain("skip_window");
  });

  it("references exactly the secrets that exist in the `release` environment", () => {
    // Verified against the live environment on 2026-08-23: all six names match,
    // no orphans. Pinned here because a rename typo is invisible until release
    // day — GitHub substitutes an unset secret with an EMPTY STRING rather than
    // failing, so `CSC_LINK: ""` reaches electron-builder and the mac job dies
    // at signing with a message about the certificate, not about the typo.
    const referenced = new Set(
      [...readFileSync(WORKFLOW, "utf8").matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]),
    );
    expect([...referenced].sort()).toEqual([
      "APPLE_API_ISSUER",
      "APPLE_API_KEY_ID",
      "APPLE_API_KEY_P8",
      "APPLE_CERT_P12_BASE64",
      "APPLE_CERT_PASSWORD",
      // Optional and deliberately absent from the environment: the workflow
      // falls back to github.token, and it is only added if a protected-branch
      // ruleset refuses that push.
      "RELEASE_PUSH_TOKEN",
      "SENTRY_AUTH_TOKEN",
    ]);
  });

  it("keeps the notary key out of the checkout and shreds it", () => {
    const steps = stepsOf("mac");
    const write = steps.find((s) => String(s.run ?? "").includes("key.p8"));
    expect(String(write?.run)).toContain("RUNNER_TEMP");
    const shred = steps.find((s) => String(s.name ?? "").toLowerCase().includes("shred"));
    // `if: always()` — a failed build must not leave the key on the runner.
    expect(shred?.if).toBe("always()");
  });
});

describe("release-electron.js --ci: the mac signing material", () => {
  // Asserted on source: the script is a top-to-bottom release driver with no
  // exports and side effects on import, and its step 0 (the release window)
  // exits before the signing preflight on any non-release day — so there is no
  // way to reach this branch end-to-end from a test.
  const SRC = readFileSync(path.join(ROOT, "scripts/release-electron.js"), "utf8");

  it("requires every one of the five inputs", () => {
    // A MISSING one does not fail electron-builder. It produces an unsigned or
    // un-notarized app that looks like a successful build and ships — which is
    // the exact accident APPLE_KEYCHAIN_PROFILE exists to prevent locally.
    for (const key of [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
    ]) {
      expect(SRC).toContain(`"${key}"`);
    }
  });

  it("notarizes the dmg with the API key in CI and the keychain profile locally", () => {
    // The dmg gets its OWN notarization pass — electron-builder staples the
    // .app and then builds the dmg around it, so the container carries no
    // ticket and Gatekeeper has to reach Apple to clear it. Offline, that is
    // the "damaged / cannot be opened" experience notarization exists to stop.
    const block = SRC.slice(SRC.indexOf("const notaryAuth"), SRC.indexOf("--wait"));
    expect(block).toContain("--key-id");
    expect(block).toContain("--issuer");
    expect(block).toContain("--keychain-profile");
  });

  it("refuses to cross-build: each target checks it is on its own OS", () => {
    expect(SRC).toContain('const requiredPlatform = isMacTarget ? "darwin" : "win32"');
  });
});

describe("release-github.js: the one outward step", () => {
  const run = (args: string[]) => {
    try {
      return {
        status: 0,
        out: execFileSync("node", ["scripts/release-github.js", ...args], {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { status: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  };

  it("refuses when an update feed is absent", () => {
    // The mac artifacts alone. Publishing this would leave every Windows user
    // with an update check that fails silently, forever.
    const dir = "__tests__/fixtures/release-assets/mac-only";
    const r = run([`--assets=${dir}`, "--dry-run"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("latest.yml");
  });

  it("ships without a platform when that is stated explicitly", () => {
    const dir = "__tests__/fixtures/release-assets/mac-only";
    const r = run([`--assets=${dir}`, "--allow-missing=win", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("deliberately shipping WITHOUT: win");
  });

  it("accepts a complete two-platform asset set", () => {
    const dir = "__tests__/fixtures/release-assets/both";
    const r = run([`--assets=${dir}`, "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("latest-mac.yml");
    expect(r.out).toContain("latest.yml");
  });

  it("refuses an empty asset directory rather than making an empty release", () => {
    const dir = "__tests__/fixtures/release-assets/empty";
    const r = run([`--assets=${dir}`, "--allow-missing=mac,win", "--dry-run"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("nothing to publish");
  });
});

describe("the Windows installer ships under a second, version-free name", () => {
  const SRC = readFileSync(path.join(ROOT, "scripts/release-electron.js"), "utf8");

  it("copies the installer to Libi-Setup-x64.exe rather than renaming it", () => {
    // libi-site links to releases/latest/download/Libi-Setup-x64.exe, and
    // GitHub matches asset names literally, so the name must not carry the
    // version. A RENAME would be wrong: on Windows the NSIS installer is also
    // the electron-updater feed artifact named by latest.yml, and reusing one
    // name across versions breaks blockmap differential downloads.
    expect(SRC).toContain('copyFileSync(installer, stableInstaller)');
    expect(SRC).toContain('"Libi-Setup-x64.exe"');
    // The versioned original must still be the thing latest.yml describes.
    expect(SRC).toContain('`Libi Setup ${version}.exe`');
  });

  it("attaches both names to the release", () => {
    expect(SRC).toContain("assets = [installer, stableInstaller, ...winFeed]");
  });
});

/**
 * `skip_electron` — the npm-only run.
 *
 * Asserted here rather than exercised, for the reason at the top of this file:
 * the only way to observe a release shape is to publish it, and two of the
 * three shapes below cannot be rehearsed at all (`dry_run` skips every shell,
 * so it cannot distinguish "skipped because dry run" from "skipped because
 * skip_electron"). That leaves the YAML as the only thing testable before the
 * fact.
 *
 * The conditions are EVALUATED, not string-matched. A string match proves a
 * clause is present; it cannot prove the shape it produces, and the failure
 * that matters here is a shape — a run that cuts a GitHub Release carrying no
 * assets.
 */
type Ctx = {
  inputs: Record<string, boolean>;
  needs: Record<string, { result: string }>;
};

/** Evaluate one job's `if:` against a run context, using the small expression
 *  vocabulary release.yml actually uses. */
function evalIf(expr: string, ctx: Ctx): boolean {
  const js = expr
    .replace(/\$\{\{|\}\}/g, "")
    .replace(/always\(\)/g, "true")
    .replace(/\balways\b(?!\()/g, "true")
    .replace(/==/g, "===")
    .trim();
  return Function("inputs", "needs", `"use strict"; return (${js});`)(
    ctx.inputs,
    ctx.needs,
  ) as boolean;
}

/** Run the whole job graph for one set of inputs, honouring the fact that a
 *  job whose `if:` is false reports 'skipped' to everything downstream. */
function shapeOf(
  inputs: { dry_run?: boolean; skip_electron?: boolean; skip_windows?: boolean },
  outcomes: { mac?: string; windows?: string } = {},
) {
  const i = {
    dry_run: false,
    skip_electron: false,
    skip_windows: false,
    ...inputs,
  };
  const ctx: Ctx = { inputs: i, needs: {} };
  const macRuns = evalIf(String(job("mac").if), ctx);
  const winRuns = evalIf(String(job("windows").if), ctx);
  ctx.needs.mac = { result: macRuns ? outcomes.mac ?? "success" : "skipped" };
  ctx.needs.windows = {
    result: winRuns ? outcomes.windows ?? "success" : "skipped",
  };
  return {
    mac: ctx.needs.mac.result,
    windows: ctx.needs.windows.result,
    publish: evalIf(String(job("publish").if), ctx) ? "runs" : "skipped",
  };
}

describe("the two failures of the first real release — 2026-08-28", () => {
  // Both happened AFTER npm had published 0.1.5 and become irreversible, which
  // is what makes them worth pinning rather than just fixing: everything in the
  // shell jobs runs on the far side of the point of no return.

  it("checks the shell jobs out with the history the gates check needs", () => {
    // `--skip-checks` is honoured only against LIBI_GATES_SHA, and proving that
    // commit is an ancestor requires it to be IN the checkout. actions/checkout
    // defaults to fetch-depth 1, so at the tag the gates commit is simply
    // absent: "4b38bb73 is not a commit in this checkout", about a minute after
    // the npm publish.
    for (const shell of ["mac", "windows"]) {
      const co = stepsOf(shell).find((st) =>
        String(st.uses ?? "").includes("actions/checkout"),
      );
      const w = (co?.with ?? {}) as Record<string, unknown>;
      expect(w.ref, `${shell} must build the published tag`).toBeDefined();
      expect(
        String(w["fetch-depth"]),
        `${shell} needs full history for the gates-provenance check`,
      ).toBe("0");
    }
  });

  it("lets publish stay shallow — it needs no ancestry", () => {
    // Stated so the rule above reads as a requirement of the gates check rather
    // than a blanket "deepen every checkout".
    const co = stepsOf("publish").find((st) =>
      String(st.uses ?? "").includes("actions/checkout"),
    );
    expect((co?.with as Record<string, unknown>)?.["fetch-depth"]).toBeUndefined();
  });

  it("polls the registry instead of failing closed on the publish lag", () => {
    // A publish's writes land before its reads do. The Windows shell starts
    // seconds after the npm job and asked for a version it had just published,
    // and was told "(nothing)". release-npm.js had already learned this on
    // 2026-08-14 and polls; this script had not, so one script carried the
    // lesson and its sibling died of it.
    const src = readFileSync(
      path.join(ROOT, "scripts/release-electron.js"),
      "utf8",
    );
    const preflight = src.slice(
      src.indexOf("── 3. registry preflight"),
      src.indexOf("── 4."),
    );
    expect(preflight, "registry preflight section not found").not.toBe("");
    // Per-VERSION document, not the aggregated packument: it is what
    // --from-registry must resolve, and it updates first.
    expect(preflight).toMatch(/npm", \[\s*"view",\s*`@nagellabs\/libi@\$\{version\}`/);
    expect(preflight).toContain("REGISTRY_ATTEMPTS");
    // A single attempt is the bug; anything that cannot retry re-introduces it.
    const attempts = Number(
      /REGISTRY_ATTEMPTS = (\d+)/.exec(preflight)?.[1] ?? "1",
    );
    expect(attempts).toBeGreaterThan(1);
  });
});

describe("release.yml gates vs test.yml: the same run, or a weaker one", () => {
  // The release gates exist to re-run ordinary CI before anything publishes.
  // On 2026-08-28 they were WEAKER than it: gates ran
  // `node scripts/ensure-native-modules.js`, which only ever repairs
  // better-sqlite3, while test.yml ran `npm rebuild better-sqlite3 node-pty`.
  // `npm ci --ignore-scripts` leaves pty.node uncompiled, so the ws-origin and
  // ws-port suites did not fail — they failed to LOAD, taking two files' worth
  // of tests out of the run. test.yml's own comment predicts this exactly, and
  // the first release dispatch hit it anyway, because nothing tied the two
  // files together.
  const testWf = load(
    readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8"),
  ) as { jobs: Record<string, { steps: Array<Record<string, unknown>> }> };

  const nativeStep = (steps: Array<Record<string, unknown>>) =>
    steps.find((st) => String(st.name ?? "").toLowerCase().includes("native"));

  it("builds the same native modules before running the same suite", () => {
    const gatesStep = nativeStep(stepsOf("gates"));
    const ciStep = nativeStep(Object.values(testWf.jobs)[0].steps);
    expect(gatesStep, "release.yml gates has no native-module step").toBeDefined();
    expect(ciStep, "test.yml has no native-module step").toBeDefined();
    expect(String(gatesStep!.run).trim()).toBe(String(ciStep!.run).trim());
  });

  it("rebuilds node-pty specifically, whichever way that step is written", () => {
    // Named because it is the one whose absence is silent: a missing
    // better-sqlite3 SIGKILLs the worker loudly, a missing pty.node just
    // removes two files from the count.
    expect(String(nativeStep(stepsOf("gates"))!.run)).toContain("node-pty");
  });
});

describe("release.yml: skip_electron (the npm-only run)", () => {
  it("is offered as an input at all", () => {
    const inputs = (
      wf as unknown as {
        on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      }
    ).on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toContain("skip_electron");
  });

  it("skips BOTH shells, never just one", () => {
    // The flag is skip_electron and not skip_mac on purpose: a release either
    // has a desktop half or it does not, and a one-platform desktop release is
    // what `skip_windows` exists for — a Windows build that failed on the day.
    expect(shapeOf({ skip_electron: true })).toEqual({
      mac: "skipped",
      windows: "skipped",
      publish: "skipped",
    });
  });

  it("cuts NO GitHub Release, rather than one carrying no assets", () => {
    // WHY this matters: electron-updater's github provider reads
    // latest-mac.yml / latest.yml from the LATEST release, and libi-site's
    // download buttons point at releases/latest/download/<name>. An
    // asset-less release becomes the latest one, so it would take out
    // auto-update for every installed app and 404 both download links — as a
    // side effect of a run whose only intent was to move the npm package.
    expect(shapeOf({ skip_electron: true }).publish).toBe("skipped");
  });

  it("states that guarantee in publish's OWN condition, not only via mac", () => {
    // Read this with the test above. TODAY the outcome is already guaranteed
    // by a different clause: skip_electron skips mac, and publish requires
    // `needs.mac.result == 'success'`, so publish cannot run either way.
    // Deleting `!inputs.skip_electron` from publish therefore changes NOTHING
    // observable, and the outcome test above keeps passing — verified by
    // mutation, which is the only reason this second test exists.
    //
    // The clause is not decoration, though. The foreseeable regression is
    // someone giving mac the same treatment Windows has — a
    // `|| needs.mac.result == 'skipped'` added for symmetry, so a deliberately
    // skipped shell does not block the release. That edit is reasonable in
    // isolation and would silently open the asset-less-release path. This
    // assertion is what survives it.
    expect(String(job("publish").if)).toContain("!inputs.skip_electron");
  });

  it("leaves the npm job alone — that is the entire point of the run", () => {
    // npm has no `if:`; it must stay unconditional or the flag would skip the
    // one thing it exists to ship.
    expect(job("npm").if).toBeUndefined();
  });

  it("changes nothing about the runs that do not set it", () => {
    // Every condition reduces to its previous form when the flag is false, so
    // adding it cannot have altered the shapes that already shipped releases.
    expect(shapeOf({})).toEqual({
      mac: "success",
      windows: "success",
      publish: "runs",
    });
    expect(shapeOf({ skip_windows: true })).toEqual({
      mac: "success",
      windows: "skipped",
      publish: "runs",
    });
    expect(shapeOf({ dry_run: true })).toEqual({
      mac: "skipped",
      windows: "skipped",
      publish: "skipped",
    });
    // A FAILED Windows leg still blocks the release; the new flag must not
    // have opened a path around that.
    expect(shapeOf({}, { windows: "failure" }).publish).toBe("skipped");
    expect(shapeOf({}, { mac: "failure" }).publish).toBe("skipped");
  });
});
