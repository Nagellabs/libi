import fs from "node:fs";
import path from "node:path";

/**
 * The dir `playwright.config.ts` exported as LIBI_TEST_AGENT_CLI_DIRS — the only
 * place the spawned libi looks for an agent CLI. It sits beside the scratch
 * LIBI_HOME, not inside it: the resolver treats everything under LIBI_HOME as
 * libi's own tree and never reports a CLI there as the user's.
 */
export function fakeCliDir(): string {
  const dir = process.env.LIBI_TEST_AGENT_CLI_DIRS;
  if (!dir) throw new Error("LIBI_TEST_AGENT_CLI_DIRS is not set — see playwright.config.ts");
  return dir;
}

/**
 * Plant a fake `claude` that answers `--version` and otherwise only echoes its
 * arguments — it is never an agent. Posix only (CI is ubuntu, dev is macOS).
 */
export function plantFakeClaude(version = "99.0.0"): string {
  const dir = fakeCliDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "claude");
  fs.writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\necho "fake claude: $*"\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

export function removeFakeClaude(): void {
  fs.rmSync(path.join(fakeCliDir(), "claude"), { force: true });
}

/**
 * Remove the whole fake-CLI dir after the spec. Guarded: only a `-fake-cli` dir
 * outside the repo is ever deleted, so a mis-set LIBI_TEST_AGENT_CLI_DIRS can't
 * take anything else with it.
 */
export function removeFakeCliDir(): void {
  const dir = path.resolve(fakeCliDir());
  const repo = path.resolve(__dirname, "..", "..");
  const rel = path.relative(repo, dir);
  const insideRepo = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!dir.endsWith("-fake-cli") || insideRepo) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
