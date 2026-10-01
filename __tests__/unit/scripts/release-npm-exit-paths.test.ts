// `scripts/release-npm.js`, RUN end to end, for the exit paths after the
// publish. Review m-7: these were covered only by greps over the source, so a
// refactor that printed the annotation to stderr, or exited 1 on the
// "accepted, not yet served" path again, would have passed.
//
// The script runs as it does in CI (`none --ci`), from a copy of scripts/ in a
// temp root, with `git`, `npm`, `curl` and `node` replaced by fakes on PATH.
// The fakes play a registry in one of several states; the script's polls run
// with no sleep (LIBI_RELEASE_VERIFY_DELAY_MS_FOR_TESTS=0) but the full attempt
// counts. That knob is honoured only alongside VITEST=true, which the fake env
// passes; a case below proves it is ignored without it. Nothing here touches
// the network or the real repo.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const V = "0.1.99";
const TARBALL = Buffer.from("the tarball npm stored");
const INTEGRITY = `sha512-${createHash("sha512").update(TARBALL).digest("base64")}`;

type Registry = {
  /** npm publish exits non-zero (npm refused the PUT). */
  publishFails?: boolean;
  /** Once published, the per-version document answers 200. */
  docServed?: boolean;
  /** Once published, the packument (`npm view`) serves the version. */
  packumentServed?: boolean;
  /** What a tarball GET returns once published. */
  tarball?: "match" | "mismatch" | "fail";
};

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "release-npm-e2e-"));
  cpSync(path.join(process.cwd(), "scripts/release-npm.js"), path.join(root, "scripts/release-npm.js"));
  cpSync(path.join(process.cwd(), "scripts/lib"), path.join(root, "scripts/lib"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function runRelease(reg: Registry, opts: { vitestMarker?: boolean; timeoutMs?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "release-npm-run-"));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(path.join(state, "tarball-match"), TARBALL);
  writeFileSync(path.join(state, "tarball-mismatch"), "bytes a broken edge served");
  writeFileSync(
    path.join(state, "doc.json"),
    JSON.stringify({
      version: V,
      dist: { tarball: `https://registry.npmjs.org/@nagellabs/libi/-/libi-${V}.tgz`, integrity: INTEGRITY },
    }),
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@nagellabs/libi", version: V, publishConfig: { access: "public" } }),
  );
  const log = path.join(state, "calls.log");
  const fake = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  const published = `[ -f "${state}/published" ]`;
  fake(
    "git",
    `case "$1 $2" in
  "status --porcelain"|"log --oneline") exit 0;;
  "rev-parse -q") exit 0;;
  "rev-list -n"|"rev-parse HEAD") echo abc123;;
  "ls-remote --tags") echo "abc123 refs/tags/v${V}";;
  *) exit 0;;
esac`,
  );
  fake(
    "npm",
    `case "$1" in
  --version) echo 11.6.0;;
  publish) ${reg.publishFails ? "exit 1" : `touch "${state}/published"`};;
  view) ${reg.packumentServed ? `${published} || exit 1; case "$3" in libi.shellApiVersion) echo 3;; *) echo ${V};; esac` : "exit 1"};;
  *) exit 0;;
esac`,
  );
  // curl: -w %{http_code} → the version doc's status; -fs <doc> → the doc;
  // -fsSL <tarball> → the tarball; -s <packument> → {}.
  fake(
    "curl",
    `args="$*"; url="\${@: -1}"
if [[ "$args" == *"-w"* ]]; then
  ${reg.docServed ? `${published} && echo 200 || echo 404` : "echo 404"}; exit 0
fi
if [[ "$1" == "-fsSL" ]]; then
  ${published} || exit 22
  ${reg.tarball === "fail" || !reg.tarball ? "exit 22" : `cat "${state}/tarball-${reg.tarball}"`}; exit 0
fi
if [[ "$1" == "-fs" ]]; then
  ${reg.docServed ? `${published} || exit 22; cat "${state}/doc.json"` : "exit 22"}; exit 0
fi
echo '{}'`,
  );
  fake("node", "exit 0"); // next-build-release.js
  const out = path.join(state, "github_output");
  const summary = path.join(state, "step_summary");
  writeFileSync(out, "");
  writeFileSync(summary, "");
  try {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/release-npm.js"), "none", "--ci"], {
      cwd: root,
      encoding: "utf8",
      // A clean env, not process.env: nothing of the host's npm/GitHub state
      // may leak into the run. (Cast: this repo types ProcessEnv with a required NODE_ENV.)
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: out,
        GITHUB_STEP_SUMMARY: summary,
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
        SENTRY_AUTH_TOKEN: "x",
        LIBI_RELEASE_VERIFY_DELAY_MS_FOR_TESTS: "0",
        // The second marker the delay override requires (review rm-1).
        ...(opts.vitestMarker === false ? {} : { VITEST: "true" }),
      } as unknown as NodeJS.ProcessEnv,
      timeout: opts.timeoutMs ?? 60_000,
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
    return {
      status: r.status,
      signal: r.signal,
      stdout: r.stdout,
      stderr: r.stderr,
      output: readFileSync(out, "utf8"),
      summary: readFileSync(summary, "utf8"),
      tarballGets: calls.filter((c) => c.startsWith("curl -fsSL")).length,
      versionViews: calls.filter((c) => c === "npm view @nagellabs/libi version").length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("release-npm.js after npm accepted the publish", () => {
  it("nothing served within the budget → exit 0, the ::warning:: on stdout, the live-check command, published=true", () => {
    const r = runRelease({});
    expect(r.status, r.stderr).toBe(0);
    // One line, at the start of a stdout line, or GitHub doesn't read it.
    expect(r.stdout).toMatch(/^::warning title=npm publish accepted - not served yet::[^\n]*npm run release:verify-live -- 0\.1\.99$/m);
    expect(r.stderr).not.toContain("::warning");
    expect(r.output).toContain("published=true");
    expect(r.summary).toContain(`npm run release:verify-live -- ${V}`);
    // The whole doc poll ran; the tarball was never fetched (no document).
    expect(r.versionViews).toBe(100);
    expect(r.tarballGets).toBe(0);
  }, 60_000);

  it("document served but the tarball GET never completes → exit 0 with the warning after 20 GETs, never a corruption verdict", () => {
    const r = runRelease({ docServed: true, tarball: "fail" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^::warning title=npm publish accepted - not served yet::/m);
    expect(r.stdout + r.stderr).not.toMatch(/real corruption signal/);
    expect(r.tarballGets).toBe(20);
    expect(r.output).toContain("published=true");
  }, 60_000);

  it("a tarball digest MISMATCH → exit 1 at once, no green warning, published=true still recorded for the push", () => {
    const r = runRelease({ docServed: true, tarball: "mismatch" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not match its registry-declared/);
    expect(r.stderr).toMatch(/real corruption signal/);
    expect(r.stdout).not.toMatch(/^::warning/m);
    expect(r.tarballGets).toBe(1);
    expect(r.output).toContain("published=true");
  }, 60_000);

  it("fully served and matching → exit 0 'is live', no warning", () => {
    const r = runRelease({ docServed: true, packumentServed: true, tarball: "match" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`@nagellabs/libi@${V} is live`);
    expect(r.stdout).toContain(`tarball integrity: verified (${INTEGRITY})`);
    expect(r.stdout).not.toMatch(/^::warning/m);
  }, 60_000);
});

describe("release-npm.js when npm did NOT accept the publish", () => {
  it("a failed publish exits non-zero before published=true, so nothing claims success", () => {
    const r = runRelease({ publishFails: true, docServed: true, packumentServed: true, tarball: "match" });
    expect(r.status).not.toBe(0);
    expect(r.output).not.toContain("published=true");
    expect(r.stdout).not.toMatch(/^::warning/m);
    expect(r.stdout).not.toContain("is live");
  }, 60_000);
});

describe("the test-only poll delay cannot shorten a real release's wait", () => {
  it("with the marker it is active, and says so", () => {
    const r = runRelease({ docServed: true, packumentServed: true, tarball: "match" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/TEST-ONLY registry poll delay override active: 0 ms/);
  }, 60_000);

  it("without VITEST=true it is ignored: the first poll sleeps the real 15 s", () => {
    // Nothing is ever served, so after its first poll the script sleeps. With
    // the override honoured that sleep is 0 and all 100 polls finish in about
    // a second (the first case above); ignored, the process is still asleep
    // after the first poll when the 4 s bound kills it.
    const r = runRelease({}, { vitestMarker: false, timeoutMs: 4_000 });
    expect(r.signal).toBe("SIGTERM");
    expect(r.versionViews).toBe(1);
    expect(r.stdout).toMatch(/ignoring LIBI_RELEASE_VERIFY_DELAY_MS_FOR_TESTS/);
    expect(r.stdout).not.toMatch(/override active/);
  }, 30_000);
});
