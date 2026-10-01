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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";

const ROOT = process.cwd();

type Workflow = {
  on: { workflow_dispatch: { inputs?: Record<string, unknown> } };
  jobs: Record<string, Record<string, unknown>>;
};
const read = (f: string) => {
  const at = path.join(ROOT, ".github/workflows", f);
  if (!existsSync(at)) {
    // These files are read at module scope, so a missing one would otherwise
    // surface as a bare ENOENT with the whole suite reporting "no tests" — the
    // least useful possible message for the most consequential possible edit.
    throw new Error(
      `.github/workflows/${f} is missing.\n\n` +
        (f === "release-npm.yml"
          ? "That filename is npm trusted-publisher CONFIGURATION, not just a name: " +
            "npm binds the OIDC publisher to org + repo + workflow filename. If this " +
            "file was renamed or moved, publishing is already broken and will fail " +
            "with a 404 on the PUT. Update the trusted publisher on npmjs.com " +
            "(@nagellabs/libi → Settings → Trusted Publisher) to the new name, and " +
            "update EXPECTED in this file to match."
          : "The release pipeline's invariants are asserted against this file."),
    );
  }
  return load(readFileSync(at, "utf8")) as Workflow;
};

/** The release is TWO workflows as of 2026-08-28. `release-npm.yml` publishes
 *  the package; `release-electron.yml` wraps an already-published version in
 *  desktop shells and cuts the GitHub Release. They were one workflow until
 *  the shells could only be exercised by publishing first — which cost two
 *  version numbers in an afternoon to discover two bugs. */
const npmWf = read("release-npm.yml");
const elWf = read("release-electron.yml");

// The split's promise is "a shell fix costs a dispatch, not a version". That
// held only for bugs fixable BEFORE the npm publish until `build_ref` existed:
// every job pinned its checkout to `v<version>`, so a defect in
// `release-electron.js` or `build-runtime-bundle.js` discovered afterwards
// could not be rebuilt without minting a new version to move the tag. It cost
// a Windows shell build on 0.1.9 to notice. The checkout supplies only build
// TOOLING — the runtime comes from npm by version — so overriding it is sound.
describe("release-electron can build from a ref newer than the tag", () => {
  const inputs = elWf.on.workflow_dispatch.inputs ?? {};
  const elText = readFileSync(path.join(ROOT, ".github/workflows/release-electron.yml"), "utf8");

  it("takes a build_ref input, defaulting to blank", () => {
    expect(Object.keys(inputs)).toContain("build_ref");
    expect((inputs.build_ref as { default?: string }).default ?? "").toBe("");
  });

  it("warns that a short SHA will not resolve", () => {
    // `actions/checkout` expands a ref into `+refs/heads/<ref>*` and
    // `+refs/tags/<ref>*`, so an abbreviated commit matches nothing and the
    // job dies in checkout before any gate runs — which is exactly how the
    // first dispatch of this input failed.
    const desc = (inputs.build_ref as { description?: string }).description ?? "";
    expect(desc).toMatch(/full 40-char SHA/i);
  });

  it("a blank build_ref falls back to the version's tag", () => {
    expect(elText).toContain('[ -n "$ref" ] || ref="v$v"');
  });

  it("every checkout uses the resolved ref, not the tag directly", () => {
    const viaRef = elText.match(/ref: \$\{\{ needs\.resolve\.outputs\.ref \}\}/g) ?? [];
    const viaTag = elText.match(/ref: \$\{\{ needs\.resolve\.outputs\.tag \}\}/g) ?? [];
    expect(viaRef.length, "gates, mac, windows and publish all check out the ref").toBe(4);
    expect(viaTag.length, "a checkout left pinned to the tag would ignore build_ref").toBe(0);
  });

  it("resolve exposes the ref it computed", () => {
    const outputs = (elWf.jobs.resolve as { outputs?: Record<string, string> }).outputs ?? {};
    expect(Object.keys(outputs)).toContain("ref");
  });

  it("but the GitHub Release is still cut against the real tag", () => {
    // Whatever tooling built the shells, the Release must name the VERSION's
    // tag — that is what electron-updater's feeds and the site's stable
    // download links hang off.
    expect(elText).toContain("--tag=${{ needs.resolve.outputs.tag }}");
  });
});


/** Look a job up in whichever of the two workflows defines it. */
const job = (name: string) => {
  const j = npmWf.jobs[name] ?? elWf.jobs[name];
  if (!j) throw new Error(`neither release workflow has a job "${name}"`);
  return j;
};
/** Disambiguates the jobs that exist in BOTH (window, gates). */
const jobIn = (wf: Workflow, name: string) => {
  const j = wf.jobs[name];
  if (!j) throw new Error(`workflow has no job "${name}"`);
  return j;
};
const stepsOf = (name: string) =>
  (job(name).steps as Array<Record<string, unknown>>) ?? [];
const stepsIn = (wf: Workflow, name: string) =>
  (jobIn(wf, name).steps as Array<Record<string, unknown>>) ?? [];

describe("the release workflows: what must never drift", () => {
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

  it("will not build a shell around a version npm does not serve", () => {
    // The shell bundles a PUBLISHED runtime (--from-registry). While the two
    // halves were one workflow this was a `needs: npm` edge; now that the
    // electron half can be dispatched on its own, days later, the ordering has
    // to be checked rather than sequenced — so `resolve` asks npm and fails the
    // run before either shell starts.
    for (const shell of ["mac", "windows"]) {
      expect(jobIn(elWf, shell).needs).toContain("resolve");
    }
    const check = stepsIn(elWf, "resolve")
      .map((st) => String(st.run ?? ""))
      .join("\n");
    expect(check).toContain("npm view");
    expect(check).toContain("is not on npm");
    // Per-VERSION document, not the aggregated packument: it is what
    // --from-registry must resolve, and it becomes available first.
    expect(check).toMatch(/npm view "@nagellabs\/libi@\$v"/);
  });

  it("gives the npm job an OIDC token and nothing more than it needs", () => {
    const perms = jobIn(npmWf, "npm").permissions as Record<string, string>;
    // Without id-token:write npm silently falls back to an anonymous publish
    // and fails at the very last step, after every gate has run.
    expect(perms["id-token"]).toBe("write");
    expect(perms.contents).toBe("write");
    // The top-level default must stay read in BOTH workflows so no other job
    // inherits write.
    for (const wf of [npmWf, elWf]) {
      expect(
        (wf as unknown as { permissions: Record<string, string> }).permissions
          .contents,
      ).toBe("read");
    }
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
    //
    // BOTH workflows need their own guard, and that is the split's one real
    // cost: two files can drift apart where one could not. Each publishes
    // something outward-facing on its own — the package, and the GitHub Release
    // that starts offering every installed app an update — so neither can
    // borrow the other's window.
    for (const wf of [npmWf, elWf]) {
      const guard = stepsIn(wf, "window")
        .map((st) => String(st.run ?? ""))
        .join("\n");
      // The operator's local day, not UTC (a UTC+7 operator was refused on a
      // real Friday morning and let through on Sunday morning).
      expect(guard).toContain("export TZ=");
      expect(guard).toContain("date +%u");
      expect(guard).not.toContain("date -u");
      expect(guard).toContain("Friday or Saturday");
      const inputs = Object.keys(wf.on.workflow_dispatch.inputs ?? {});
      expect(inputs).not.toContain("force");
      expect(inputs).not.toContain("skip_window");
    }
  });

  it("pushes the version commit and tag even when only the post-publish verify failed", () => {
    // 0.1.14: npm accepted the package, the registry verifier gave up on a
    // lagging CDN, the Publish step failed, and the push was skipped — a public
    // version with no version commit and no tag. The script now reports
    // `published=true` the moment npm accepts, and the push keys off it.
    const push = stepsIn(npmWf, "npm").find((st) => st.name === "Push the version commit and tag");
    expect(push?.if).toContain("steps.publish.outputs.published == 'true'");
    expect(push?.if).toContain("!inputs.dry_run");
    const script = readFileSync(path.join(ROOT, "scripts/release-npm.js"), "utf8");
    const marker = script.indexOf("published=true");
    expect(marker).toBeGreaterThan(script.indexOf('dryRun ? ["publish", "--dry-run"] : ["publish"]'));
    // VERIFY_ATTEMPTS/VERIFY_DELAY_MS now live in ./lib/release-verify.js
    // (tested there); the verify loop itself still starts well after
    // `published=true` is written.
    expect(marker).toBeLessThan(script.indexOf("for (let attempt = 1; attempt <= VERIFY_ATTEMPTS"));
  });

  it("references exactly the secrets that exist in the `release` environment", () => {
    // Verified against the live environment on 2026-08-23: all six names match,
    // no orphans. Pinned here because a rename typo is invisible until release
    // day — GitHub substitutes an unset secret with an EMPTY STRING rather than
    // failing, so `CSC_LINK: ""` reaches electron-builder and the mac job dies
    // at signing with a message about the certificate, not about the typo.
    const both = ["release-npm.yml", "release-electron.yml"]
      .map((f) => readFileSync(path.join(ROOT, ".github/workflows", f), "utf8"))
      .join("\n");
    const referenced = new Set(
      [...both.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]),
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

  it("refuses a feed that points at a file the asset set does not contain", () => {
    // The failure v0.1.8 actually shipped. `latest.yml` named
    // Libi-Setup-0.1.8.exe while the artifact was "Libi Setup 0.1.8.exe", so
    // the feed published, the release looked complete, and electron-updater
    // got a 404 — permanently, not just for that version. The
    // feed-is-present check above went green through all of it.
    const dir = "__tests__/fixtures/release-assets/dangling-feed";
    const r = run([`--assets=${dir}`, "--dry-run"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("points at files that are not in the asset set");
    expect(r.out).toContain("Libi-Setup-0.0.0.exe");
  });

  it("refuses any asset name containing a space", () => {
    // The whole class, not the one instance: GitHub rewrites spaces to dots at
    // UPLOAD time, so a name that is self-consistent on disk can still stop
    // matching its feed once published.
    const dir = "__tests__/fixtures/release-assets/dangling-feed";
    const r = run([`--assets=${dir}`, "--dry-run"]);
    expect(r.status).toBe(1);
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
    // The versioned original must still be the thing latest.yml describes, and
    // it must carry NO SPACES — GitHub rewrites those to dots on upload while
    // electron-builder writes hyphens into the feed, and v0.1.8 shipped with
    // the two disagreeing. This name has to equal `nsis.artifactName`.
    expect(SRC).toContain('`Libi-Setup-${version}.exe`');
    expect(SRC).not.toContain('`Libi Setup ${version}.exe`');
  });

  it("looks the installer up under the name electron-builder actually writes", () => {
    // Two files have to agree on one string. If electron-builder.yml is changed
    // alone the build fails at verification with "missing artifacts"; if the
    // script is changed alone it looks for a file that was never produced.
    const ebYaml = readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
    const artifactName = /^\s*artifactName:\s*"([^"]+)"/m.exec(
      ebYaml.slice(ebYaml.indexOf("\nnsis:")),
    )?.[1];
    expect(artifactName, "nsis.artifactName is not set in electron-builder.yml").toBe(
      "Libi-Setup-${version}.exe",
    );
    expect(artifactName).not.toContain(" ");
    // The script's template literal uses the same text with JS interpolation.
    expect(SRC).toContain(`\`${artifactName}\``);
  });

  it("attaches both names to the release", () => {
    expect(SRC).toContain("assets = [installer, stableInstaller, ...winFeed]");
  });
});

/**
 * The electron workflow's run SHAPES.
 *
 * The conditions are EVALUATED against each input set, not string-matched. A
 * string match proves a clause is present; it cannot prove the shape that
 * clause produces, and a shape is what goes wrong here — a Release published
 * without the artifacts it is supposed to carry, or a dry run that quietly
 * skips the very jobs it exists to rehearse.
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
  inputs: { dry_run?: boolean; skip_windows?: boolean },
  outcomes: { mac?: string; windows?: string } = {},
) {
  const i = { dry_run: false, skip_windows: false, ...inputs };
  const ctx: Ctx = { inputs: i, needs: {} };
  // A job with no `if:` runs unconditionally — which is exactly what mac is in
  // release-electron.yml, and treating a missing condition as "false" would
  // silently report every shape as "skipped".
  const cond = (name: string) => {
    const c = jobIn(elWf, name).if;
    return c === undefined ? true : evalIf(String(c), ctx);
  };
  const macRuns = cond("mac");
  const winRuns = cond("windows");
  ctx.needs.mac = { result: macRuns ? outcomes.mac ?? "success" : "skipped" };
  ctx.needs.windows = {
    result: winRuns ? outcomes.windows ?? "success" : "skipped",
  };
  return {
    mac: ctx.needs.mac.result,
    windows: ctx.needs.windows.result,
    publish: cond("publish") ? "runs" : "skipped",
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

describe("three gates jobs, or three chances to drift apart", () => {
  // The release gates exist to re-run ordinary CI before anything publishes.
  // On 2026-08-28 they were WEAKER than it: they ran
  // `node scripts/ensure-native-modules.js`, which only ever repairs
  // better-sqlite3, while test.yml ran `npm rebuild better-sqlite3 node-pty`.
  // Both install with --ignore-scripts, so pty.node was never compiled and the
  // ws-origin/ws-port suites did not fail — they failed to LOAD, taking two
  // files' worth of tests out of the run. test.yml's own comment predicts this
  // by name, and the first release dispatch hit it anyway, because nothing tied
  // the files together.
  //
  // The split turned two gates jobs into three. That is more places to drift,
  // not fewer, so this compares all of them.
  const testWf = read("test.yml");

  const nativeStep = (steps: Array<Record<string, unknown>>) =>
    steps.find((st) => String(st.name ?? "").toLowerCase().includes("native"));

  const ciStep = nativeStep(Object.values(testWf.jobs)[0].steps as Array<Record<string, unknown>>);

  it("test.yml still has a native-module step to compare against", () => {
    expect(ciStep, "test.yml has no native-module step").toBeDefined();
  });

  it.each([
    ["release-npm.yml", () => stepsIn(npmWf, "gates")],
    ["release-electron.yml", () => stepsIn(elWf, "gates")],
  ])("%s builds the same native modules as test.yml", (_name, steps) => {
    const gatesStep = nativeStep(steps());
    expect(gatesStep, "no native-module step in this gates job").toBeDefined();
    expect(String(gatesStep!.run).trim()).toBe(String(ciStep!.run).trim());
    // Named explicitly because its absence is the silent one: a missing
    // better-sqlite3 SIGKILLs the worker loudly, a missing pty.node just
    // removes two files from the count.
    expect(String(gatesStep!.run)).toContain("node-pty");
  });

  it.each([
    ["release-npm.yml", () => stepsIn(npmWf, "gates")],
    ["release-electron.yml", () => stepsIn(elWf, "gates")],
  ])("%s runs the full gate set, not a subset", (_name, steps) => {
    const names = steps().map((st) => String(st.name ?? "").toLowerCase());
    for (const gate of ["lint", "test", "licences", "notices"]) {
      expect(names.some((n) => n.includes(gate)), `missing gate: ${gate}`).toBe(
        true,
      );
    }
  });

  // 0.1.16: test.yml installed BtbN's ffmpeg 9.0, the release gates installed
  // none, and every real-ffmpeg test in them SKIPPED through hasFfmpeg() — the
  // gates reported green over coverage they never ran. One shared action keeps
  // the three installs identical, and LIBI_REQUIRE_FFMPEG turns a missing
  // ffmpeg into a failure instead of a skip.
  type Step = Record<string, unknown>;
  it.each([
    ["test.yml", () => Object.values(testWf.jobs)[0].steps as Step[]],
    ["release-npm.yml", () => stepsIn(npmWf, "gates")],
    ["release-electron.yml", () => stepsIn(elWf, "gates")],
  ])("%s installs libi's ffmpeg before the tests, through the one shared action", (_n, steps) => {
    const s = steps();
    const ff = s.findIndex((st) => st.uses === "./.github/actions/setup-ffmpeg");
    const test = s.findIndex((st) => String(st.name).toLowerCase() === "test");
    expect(ff, "no setup-ffmpeg step").toBeGreaterThanOrEqual(0);
    expect(ff).toBeLessThan(test);
    expect((s[test].env as Record<string, string> | undefined)?.LIBI_REQUIRE_FFMPEG).toBe("1");
  });

  it("the shared action pins the n9.0 line and proves drawtext", () => {
    const a = readFileSync(path.join(ROOT, ".github/actions/setup-ffmpeg/action.yml"), "utf8");
    expect(a).toContain("ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz");
    expect(a).toMatch(/-filters\)"\s*\n\s*if ! grep -q drawtext/);
    // curl's plain --retry does not retry a 404, which is what BtbN's daily
    // re-upload window looks like.
    expect(a).toContain("--retry 5 --retry-all-errors");
    expect(a).toContain("sha256sum -c");
    // A composite action's `run` steps need an explicit shell, and bash is what
    // makes `set -o pipefail` mean anything.
    const parsed = load(a) as { runs: { using: string; steps: Step[] } };
    expect(parsed.runs.using).toBe("composite");
    for (const st of parsed.runs.steps.filter((x) => x.run)) {
      expect(st.shell).toBe("bash");
    }
  });
});

describe("setup-ffmpeg, run for real against a fake BtbN release", () => {
  // The action is on the release path now (both gates jobs), so its failure
  // modes are exercised, not just string-matched: the script in action.yml is
  // executed under bash with `curl` answering from a fixture directory.
  type ActionStep = { run: string; env: Record<string, string> };
  const action = load(
    readFileSync(path.join(ROOT, ".github/actions/setup-ffmpeg/action.yml"), "utf8"),
  ) as { runs: { steps: ActionStep[] } };
  const step = action.runs.steps[0];
  const ASSET = step.env.ASSET;

  const FAKE_FFMPEG = (filters: string) =>
    `#!/bin/bash\ncase "$1" in\n  -version) echo "ffmpeg version n9.0-fake Copyright"; echo "built with gcc";;\n` +
    `  -hide_banner) echo " ... ${filters} V->V  (fake)";;\nesac\n`;

  function runAction(opts: {
    listed?: boolean;
    corrupt?: boolean;
    /** Only the FIRST download of the asset is corrupt (a re-upload race). */
    corruptOnce?: boolean;
    checksumsMissing?: boolean;
    drawtext?: boolean;
  }) {
    const dir = mkdtempSync(path.join(tmpdir(), "setup-ffmpeg-"));
    const release = path.join(dir, "release");
    const bin = path.join(dir, "bin");
    const dest = path.join(dir, "dest");
    const log = path.join(dir, "curl.log");
    const workParent = path.join(dir, "work");
    for (const d of [release, bin, dest, workParent]) mkdirSync(d);
    // Something of the caller's in the directory it hands the action.
    writeFileSync(path.join(workParent, "keep-me"), "not the action's to delete");
    try {
      // A tarball shaped like BtbN's: <top>/bin/{ffmpeg,ffprobe}.
      const top = path.join(dir, "pkg", "ffmpeg-n9.0-fake");
      mkdirSync(path.join(top, "bin"), { recursive: true });
      const ff = FAKE_FFMPEG(opts.drawtext === false ? "scale" : "drawtext");
      writeFileSync(path.join(top, "bin", "ffmpeg"), ff);
      writeFileSync(path.join(top, "bin", "ffprobe"), ff);
      chmodSync(path.join(top, "bin", "ffmpeg"), 0o755);
      chmodSync(path.join(top, "bin", "ffprobe"), 0o755);
      execFileSync("tar", ["-cJf", path.join(release, ASSET), "-C", path.join(dir, "pkg"), "ffmpeg-n9.0-fake"]);
      const sum = execFileSync("sha256sum", [path.join(release, ASSET)], { encoding: "utf8" }).split(" ")[0];
      if (opts.corrupt) writeFileSync(path.join(release, ASSET), "not the bytes BtbN hashed");
      // <asset>.1 is what the FIRST fetch of <asset> gets, when present.
      if (opts.corruptOnce) writeFileSync(path.join(release, `${ASSET}.1`), "an upload mid-replacement");
      const lines = [`${"0".repeat(64)}  ffmpeg-master-latest-linux64-gpl.tar.xz`];
      if (opts.listed !== false) lines.push(`${sum}  ${ASSET}`);
      if (!opts.checksumsMissing) writeFileSync(path.join(release, "checksums.sha256"), lines.join("\n") + "\n");
      // curl -fsSL --retry … -o <out> <url>: serve <url>'s basename from the
      // fixture release, exit 22 (curl -f's HTTP error) when absent.
      writeFileSync(
        path.join(bin, "curl"),
        `#!/bin/bash\necho "$*" >> "${log}"\nout=""; url=""\n` +
          `while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --retry|--retry-delay) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done\n` +
          `f="${release}/\${url##*/}"\n[ -f "$f" ] || exit 22\n` +
          // Count fetches per file; serve <file>.<n> for the n-th when it exists.
          `n=$(( $(cat "$f.count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f.count"\n` +
          `[ -f "$f.$n" ] && f="$f.$n"\ncp "$f" "$out"\n`,
      );
      chmodSync(path.join(bin, "curl"), 0o755);
      const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          ...step.env,
          PATH: `${dest}:${bin}:${process.env.PATH}`,
          SETUP_FFMPEG_WORK_DIR: workParent,
          SETUP_FFMPEG_INSTALL_DIR: dest,
        },
      });
      return {
        status: r.status,
        out: r.stdout + r.stderr,
        installed: existsSync(path.join(dest, "ffmpeg")) && existsSync(path.join(dest, "ffprobe")),
        curl: existsSync(log) ? readFileSync(log, "utf8") : "",
        keptCallersFile: existsSync(path.join(workParent, "keep-me")),
        assetFetches: Number(
          existsSync(path.join(release, `${ASSET}.count`))
            ? readFileSync(path.join(release, `${ASSET}.count`), "utf8").trim()
            : "0",
        ),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("verifies the asset against checksums.sha256, installs both binaries and prints the version", () => {
    const r = runAction({});
    expect(r.status, r.out).toBe(0);
    expect(r.installed).toBe(true);
    expect(r.out).toContain(`${ASSET}: OK`);
    expect(r.out).toContain("ffmpeg version n9.0-fake");
    expect(r.curl).toContain("--retry 5 --retry-all-errors");
    expect(r.assetFetches).toBe(1);
  });

  it("never deletes the directory it is given, only its own subdirectory", () => {
    for (const r of [runAction({}), runAction({ corrupt: true })]) {
      expect(r.keptCallersFile).toBe(true);
    }
  });

  it("a mismatch from a re-upload race is re-fetched once and then installs", () => {
    const r = runAction({ corruptOnce: true });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/re-fetching both once/);
    expect(r.assetFetches).toBe(2);
    expect(r.installed).toBe(true);
  });

  it("a rotated-out release line fails naming the asset and the file to update", () => {
    const r = runAction({ listed: false });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error[^\n]*ffmpeg-n9\.0-latest-linux64-gpl-9\.0\.tar\.xz is no longer in BtbN's latest release/);
    expect(r.out).toContain("Update ASSET in .github/actions/setup-ffmpeg/action.yml");
    expect(r.installed).toBe(false);
    // It never even downloads the tarball.
    expect(r.curl).not.toContain(`/${ASSET}`);
  });

  it("bytes that do not match the checksum are refused, not installed", () => {
    const r = runAction({ corrupt: true });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error[^\n]*does not match BtbN's checksums\.sha256, twice/);
    // Says what it most likely is, and what to do.
    expect(r.out).toMatch(/::error[^\n]*daily re-upload[^\n]*re-run the job/);
    expect(r.assetFetches).toBe(2);
    expect(r.installed).toBe(false);
  });

  it("no checksums file (after the retries) fails with its own message", () => {
    const r = runAction({ checksumsMissing: true });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error[^\n]*could not download .*checksums\.sha256/);
  });

  it("an ffmpeg without drawtext fails the step", () => {
    const r = runAction({ drawtext: false });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error[^\n]*no drawtext filter/);
  });
});

describe("Sentry source maps reach the build that actually ships", () => {
  // The shell ships almost nothing of its own: `files:` is dist-electron plus
  // package.json, and the product arrives as an installed @nagellabs/libi
  // snapshot under extraResources, pulled --from-registry. So the maps that
  // matter are the ones built during the npm PUBLISH, not during either shell
  // build.
  //
  // That job had `environment: release` — which makes a secret available to
  // `secrets.*` and does NOT put it in the process environment. Nothing does
  // that but an explicit `env:` mapping, and the missing one is silent:
  // next-build-release.js warns and carries on, so 0.1.5, 0.1.6 and 0.1.7 all
  // published with production stack traces left minified.
  it("passes SENTRY_AUTH_TOKEN into the npm publish step", () => {
    const publish = stepsIn(npmWf, "npm").find((st) => st.name === "Publish");
    expect(publish, "release-npm.yml has no Publish step").toBeDefined();
    const env = (publish!.env ?? {}) as Record<string, string>;
    expect(
      env.SENTRY_AUTH_TOKEN,
      "the publish builds the shipped runtime; without this its maps never upload",
    ).toContain("secrets.SENTRY_AUTH_TOKEN");
  });

  it("does not require it in the Windows shell, and that is deliberate", () => {
    // Windows has no `environment: release`, so it cannot see the secret at
    // all. That is fine and must not be "fixed" by adding the environment: the
    // .next it builds is discarded (the shipped one comes from the registry),
    // dist-electron is not minified, and main-process crashes are reported
    // through the RUNTIME's Sentry client, whose maps come from the npm job.
    // Adding `environment: release` here would buy nothing and would add a
    // reviewer pause to every dry run — the loop that makes shell bugs cost a
    // dispatch instead of a version.
    expect(jobIn(elWf, "windows").environment).toBeUndefined();
  });
});

describe("the mac build raises the file-descriptor ceiling before signing", () => {
  // Three builds died on EMFILE, on a DIFFERENT file each time — the signature
  // of a concurrent open storm, not a leaked handle. `asar` packing is disabled
  // by design (electron-builder.yml explains why), so electron-builder copies,
  // hashes and signs every file of the bundled runtime individually.
  //
  // The trap: `ulimit -n` alone does not fix it. macOS enforces a separate
  // per-process ceiling in the kernel, and the shell reports a limit above it
  // quite happily — one build printed a 65536 limit and hit EMFILE regardless.
  const build = () =>
    stepsIn(elWf, "mac").find((st) =>
      String(st.name ?? "").toLowerCase().includes("build"),
    );

  it("raises the KERNEL ceiling, not only the shell limit", () => {
    const run = String(build()?.run ?? "");
    expect(run).toContain("kern.maxfilesperproc");
    expect(run).toContain("ulimit -n");
  });

  it("raises it BEFORE the build, not after", () => {
    const run = String(build()?.run ?? "");
    expect(run.indexOf("kern.maxfilesperproc")).toBeLessThan(
      run.indexOf("release-electron.js"),
    );
  });

  it("prints both numbers, so a repeat failure says which one did not move", () => {
    // The first fix looked correct and was not. Without the echo the second
    // failure would have looked identical to the first.
    const run = String(build()?.run ?? "");
    expect(run).toMatch(/echo .*kern\.maxfilesperproc.*ulimit/);
  });
});

describe("the npm workflow's FILENAME is trusted-publisher configuration", () => {
  // npm's trusted publisher (OIDC) is bound to org + repo + workflow filename.
  // Renaming this file stops publishing, and it fails as a 404 on the PUT
  // rather than as an auth error, so it reads like a missing package:
  //
  //   npm error 404  ...could not be found or you do not have permission
  //
  // It happened for real on 2026-08-28, splitting release.yml into two files.
  // Nothing in the repo recorded that the name was load-bearing, because the
  // configuration that depends on it lives on npmjs.com.
  //
  // This test cannot verify the npm-side setting — no API here reaches it. What
  // it CAN do is make the rename impossible to do silently: change the filename
  // and this fails, pointing at the setting that has to change with it.
  const EXPECTED = "release-npm.yml";

  it("is the exact filename registered with npm as a trusted publisher", () => {
    expect(existsSync(path.join(ROOT, ".github/workflows", EXPECTED))).toBe(true);
  });

  it("is the file that actually runs the publish — the binding is to THIS name", () => {
    // A guard on a filename is worthless if the publish later moves to another
    // file. Assert the two are the same thing.
    const publishStep = stepsIn(npmWf, "npm").find((st) =>
      String(st.run ?? "").includes("release-npm.js"),
    );
    expect(publishStep, `${EXPECTED} does not run scripts/release-npm.js`).toBeDefined();
  });

  it("says so in the file, where someone renaming it would look", () => {
    // A test alone fails AFTER the rename. The comment is what prevents it.
    const src = readFileSync(
      path.join(ROOT, ".github/workflows", EXPECTED),
      "utf8",
    );
    expect(src).toMatch(/trusted publisher/i);
    expect(src).toMatch(/rename/i);
  });

  it("keeps the publish out of every OTHER workflow, so one binding is enough", () => {
    // If a second workflow could publish to npm it would need its own trusted
    // publisher entry, and the one nobody registered would fail on release day.
    const others = readdirSync(path.join(ROOT, ".github/workflows")).filter(
      (f) => f !== EXPECTED,
    );
    for (const f of others) {
      const src = readFileSync(path.join(ROOT, ".github/workflows", f), "utf8");
      expect(src, `${f} must not run release-npm.js`).not.toContain(
        "scripts/release-npm.js",
      );
    }
  });
});

describe("the split: two workflows, and what each half must guarantee", () => {
  // `release.yml` became `release-npm.yml` + `release-electron.yml` on
  // 2026-08-28. It briefly carried a `skip_electron` input for npm-only weeks;
  // the split replaces it, because "don't run the second workflow" needs no
  // flag, no extra job condition, and no way to get half-applied.

  it("keeps the old single workflow deleted, so neither half is shadowed", () => {
    // A leftover release.yml would still be dispatchable, and it would publish
    // through the code paths this refactor exists to fix.
    expect(existsSync(path.join(ROOT, ".github/workflows/release.yml"))).toBe(
      false,
    );
  });

  it("puts the npm publish in one workflow and the shells in the other", () => {
    expect(Object.keys(npmWf.jobs)).toContain("npm");
    expect(Object.keys(npmWf.jobs)).not.toContain("mac");
    expect(Object.keys(npmWf.jobs)).not.toContain("windows");
    // The GitHub Release carries the shells' artifacts, so it belongs with them.
    expect(Object.keys(npmWf.jobs)).not.toContain("publish");
    expect(Object.keys(elWf.jobs)).toEqual(
      expect.arrayContaining(["resolve", "mac", "windows", "publish"]),
    );
    expect(Object.keys(elWf.jobs)).not.toContain("npm");
  });

  it("carries no skip_electron flag in either half", () => {
    for (const wf of [npmWf, elWf]) {
      expect(Object.keys(wf.on.workflow_dispatch.inputs ?? {})).not.toContain(
        "skip_electron",
      );
    }
  });

  it("takes the version to wrap as an INPUT — this is the whole point", () => {
    // While the halves were joined, a shell could only ever be built after an
    // irreversible npm publish, so every bug in a shell job cost a version
    // number to find. Two did, in one afternoon. Taking the version as input
    // means the electron half re-runs against the same published version as
    // often as needed.
    expect(Object.keys(elWf.on.workflow_dispatch.inputs ?? {})).toContain(
      "version",
    );
  });

  it("still BUILDS both shells on an electron dry run, and withholds only the Release", () => {
    // The inverse of the npm workflow's dry run, and the reason this one is
    // useful: a dry run that skipped the shells would rehearse nothing that has
    // ever actually broken.
    expect(String(jobIn(elWf, "mac").if ?? "")).not.toContain("dry_run");
    expect(String(jobIn(elWf, "windows").if ?? "")).not.toContain("dry_run");
    expect(String(jobIn(elWf, "publish").if)).toContain("!inputs.dry_run");
  });

  it("uploads the update feed with each shell, or the release cannot be assembled", () => {
    // release-github.js refuses an asset set missing a platform's feed, and on
    // a dry run these artifacts are the only output there is.
    const feeds: Record<string, string> = {
      mac: "latest-mac.yml",
      windows: "latest.yml",
    };
    for (const [shell, feed] of Object.entries(feeds)) {
      const upload = stepsIn(elWf, shell).find((st) =>
        String(st.uses ?? "").includes("upload-artifact"),
      );
      expect(String((upload?.with as Record<string, unknown>)?.path)).toContain(
        feed,
      );
      // An empty upload must fail the job rather than yield a release with
      // nothing in it.
      expect((upload?.with as Record<string, unknown>)?.["if-no-files-found"]).toBe(
        "error",
      );
    }
  });
});

describe("release-electron.yml: the shapes a dispatch can produce", () => {
  it("builds both shells and publishes, by default", () => {
    expect(shapeOf({})).toEqual({
      mac: "success",
      windows: "success",
      publish: "runs",
    });
  });

  it("builds both shells on a dry run and publishes nothing", () => {
    // The distinguishing property of this workflow. Under the old joined
    // workflow a dry run skipped the shells entirely, which is why neither of
    // the two bugs that cost a version could ever have been rehearsed.
    expect(shapeOf({ dry_run: true })).toEqual({
      mac: "success",
      windows: "success",
      publish: "skipped",
    });
  });

  it("still publishes when Windows was skipped on purpose", () => {
    expect(shapeOf({ skip_windows: true })).toEqual({
      mac: "success",
      windows: "skipped",
      publish: "runs",
    });
  });

  it("publishes nothing when either shell FAILED", () => {
    // A failed Windows leg must not ship mac-only: in the release list that is
    // indistinguishable from shipping mac-only on purpose, and nobody would
    // notice for a version.
    expect(shapeOf({}, { windows: "failure" }).publish).toBe("skipped");
    expect(shapeOf({}, { mac: "failure" }).publish).toBe("skipped");
    // Including on a dry run, where there is nothing to publish anyway.
    expect(shapeOf({ dry_run: true }, { mac: "failure" }).publish).toBe("skipped");
  });
});

describe("the release candidate branch gets every check main does", () => {
  // Release day squashes the week branch onto `release/<version>`, pushes it,
  // and fast-forwards `main` only once that candidate is green. On 0.1.16 the
  // candidate ran Tests but NOT the License check — license-check.yml listened
  // to `main` alone — although the runbook said both. A check that first runs
  // on `main` can only report a problem as a public fix-up commit.
  type Triggers = { on: { push?: { branches?: string[] } | null } };

  it("runs the licence check on release candidates as well as main", () => {
    const lic = read("license-check.yml") as unknown as Triggers;
    const branches = lic.on.push?.branches ?? [];
    expect(branches).toContain("main");
    expect(branches).toContain("release/**");
  });

  it("runs Tests on every push", () => {
    // test.yml has no branch filter at all, which is what makes it cover the
    // candidate. A `branches:` added here would silently drop release/**.
    const tests = read("test.yml") as unknown as Triggers;
    expect("push" in tests.on).toBe(true);
    expect(tests.on.push?.branches).toBeUndefined();
  });
});

describe("a slow registry never turns a good publish red — 0.1.16", () => {
  // 0.1.16 sat in npm "processing" for ~56 minutes. The npm job's verify
  // (~25 min) exited 1 on a good publish, and the Electron side would have
  // failed on the same lag: `resolve` asked npm ONCE, and release-electron.js
  // polled only 20 × 15 s.
  const resolveRun = stepsIn(elWf, "resolve")
    .map((st) => String(st.run ?? ""))
    .join("\n");

  it("resolve polls the per-version document for up to an hour, 15 s apart", () => {
    expect(resolveRun).toMatch(/\bfor\b|\bwhile\b|\buntil\b/);
    expect(resolveRun).toContain("sleep 15");
    const bound = Number(/attempts=(\d+)/.exec(resolveRun)?.[1] ?? "0");
    expect(bound, "resolve must poll ≥ 240 × 15 s").toBeGreaterThanOrEqual(240);
    expect(resolveRun).toMatch(/npm view[^\n]*"@nagellabs\/libi@\$v"/);
  });

  it("and says to re-dispatch with the same version when it gives up", () => {
    expect(resolveRun).toMatch(/not served yet/);
    expect(resolveRun).toMatch(/re-dispatch later with the same version/);
  });

  /** Run the resolve step for real under `bash -e` (GitHub's default shell),
   *  with `npm` answering from a script and `sleep` a no-op. */
  function runResolve(opts: { failuresBeforeServed: number; version?: string }) {
    const dir = mkdtempSync(path.join(tmpdir(), "resolve-step-"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const counter = path.join(dir, "calls");
    writeFileSync(counter, "0");
    // `npm view @nagellabs/libi@<v> version …` → E404 for the first N calls,
    // then the version. Every call is counted.
    writeFileSync(
      path.join(bin, "npm"),
      `#!/bin/bash\nn=$(( $(cat "${counter}") + 1 )); echo "$n" > "${counter}"\n` +
        `if [ "$n" -le ${opts.failuresBeforeServed} ]; then echo "npm error 404" >&2; exit 1; fi\n` +
        `echo "\${2#@nagellabs/libi@}"\n`,
    );
    writeFileSync(path.join(bin, "sleep"), "#!/bin/bash\nexit 0\n");
    chmodSync(path.join(bin, "npm"), 0o755);
    chmodSync(path.join(bin, "sleep"), 0o755);
    const output = path.join(dir, "out");
    writeFileSync(output, "");
    const script = String(stepsIn(elWf, "resolve")[0].run)
      .replaceAll("${{ inputs.version }}", opts.version ?? "0.1.17")
      .replaceAll("${{ inputs.build_ref }}", "");
    try {
      const r = spawnSync("bash", ["-e", "-c", script], {
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: output },
        encoding: "utf8",
      });
      return {
        status: r.status,
        stdout: r.stdout,
        calls: Number(readFileSync(counter, "utf8").trim()),
        output: readFileSync(output, "utf8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("resolve, run for real: served on the 4th ask → outputs the version", () => {
    const r = runResolve({ failuresBeforeServed: 3 });
    expect(r.status).toBe(0);
    expect(r.calls).toBe(4);
    expect(r.output).toContain("version=0.1.17");
    expect(r.output).toContain("ref=v0.1.17");
  });

  it("resolve, run for real: never served → fails after exactly 240 asks, naming the re-dispatch", () => {
    const r = runResolve({ failuresBeforeServed: 10_000 });
    expect(r.status).toBe(1);
    expect(r.calls).toBe(240);
    expect(r.stdout).toMatch(/::error::.*not served yet.*re-dispatch later with the same version/);
    expect(r.output).not.toContain("version=");
  });

  it("the resolve job's own timeout leaves room for that hour", () => {
    const t = Number((jobIn(elWf, "resolve") as { "timeout-minutes"?: number })["timeout-minutes"] ?? 360);
    expect(t).toBeGreaterThan(60);
  });

  it("release-electron.js waits as long as resolve does", () => {
    const src = readFileSync(path.join(ROOT, "scripts/release-electron.js"), "utf8");
    const attempts = Number(/REGISTRY_ATTEMPTS = (\d+)/.exec(src)?.[1] ?? "0");
    const delay = Number((/REGISTRY_DELAY_MS = ([\d_]+)/.exec(src)?.[1] ?? "0").replace(/_/g, ""));
    expect(attempts).toBeGreaterThanOrEqual(240);
    expect(delay).toBe(15_000);
  });

  it("the version commit + tag push still runs after a publish npm accepted", () => {
    // Exit 0 on "accepted, not yet served" keeps success() true; the
    // published=='true' arm keeps the push alive even if the step fails for
    // another reason AFTER npm accepted (a mismatch, a killed runner).
    const push = stepsIn(npmWf, "npm").find((st) =>
      String(st.run ?? "").includes("git push --follow-tags origin HEAD:main"),
    );
    expect(push, "the version commit/tag push step is gone").toBeDefined();
    const cond = String(push!.if);
    expect(cond).toContain("success()");
    expect(cond).toContain("steps.publish.outputs.published == 'true'");
    expect(cond).toContain("!inputs.dry_run");
  });

  it("the local live check is wired as npm run release:verify-live", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["release:verify-live"]).toBe("node scripts/verify-npm-live.js");
  });
});

describe("the macOS shell build says how close it came to its memory ceiling", () => {
  // 0.1.16's `next build` worker ran out of heap twice on the 7 GB macos-15
  // runner; cf7ad01f raised the heap to 5 GB. Without a measurement the next
  // dependency bump finds the new ceiling on a real release run.
  const mac = stepsIn(elWf, "mac");
  const buildAt = mac.findIndex((st) =>
    String(st.run ?? "").includes("node scripts/release-electron.js --target=mac"),
  );

  it("runs the build under /usr/bin/time -l, into RUNNER_TEMP", () => {
    expect(buildAt, "mac build step not found").toBeGreaterThanOrEqual(0);
    const run = String(mac[buildAt].run);
    expect(run).toMatch(
      /\/usr\/bin\/time -l -o "\$RUNNER_TEMP\/build-time\.txt" node scripts\/release-electron\.js --target=mac/,
    );
  });

  it("reports it in a later step that runs even when the build failed", () => {
    const report = mac.findIndex((st) =>
      String(st.run ?? "").includes('node scripts/build-memory-report.js "$RUNNER_TEMP/build-time.txt"'),
    );
    expect(report, "no memory-report step").toBeGreaterThan(buildAt);
    expect(String(mac[report].if)).toContain("always()");
  });

  it("fails a DRY run, but never withholds a real Release after a good build", () => {
    // Review I-3: a trip on the real run would mark `mac` failed and `publish`
    // would skip, after a signed, notarized build. continue-on-error is TRUE
    // exactly when this is not a dry run.
    const report = mac.find((st) =>
      String(st.run ?? "").includes("node scripts/build-memory-report.js"),
    )!;
    expect(String(report["continue-on-error"]).replace(/\s+/g, "")).toBe("${{!inputs.dry_run}}");
    // And it sits after the artifact upload, so a red dry run still has them.
    const upload = mac.findIndex((st) => String(st.uses ?? "").includes("actions/upload-artifact"));
    expect(mac.indexOf(report)).toBeGreaterThan(upload);
  });

  it("the heap limit it reports against is still the one the job sets", () => {
    const env = (jobIn(elWf, "mac").env ?? {}) as Record<string, string>;
    expect(env.NODE_OPTIONS).toContain("--max-old-space-size=5120");
  });
});
