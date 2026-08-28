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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
      expect(guard).toContain("date -u +%u");
      expect(guard).toContain("Friday or Saturday");
      const inputs = Object.keys(wf.on.workflow_dispatch.inputs ?? {});
      expect(inputs).not.toContain("force");
      expect(inputs).not.toContain("skip_window");
    }
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
