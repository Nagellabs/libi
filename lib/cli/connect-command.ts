// lib/cli/connect-command.ts
//
// The real-world half of `libi connect`: the dependencies `runConnect`
// (./connect.ts — pure, injectable, unit-tested) is written against, plus the
// terminal output. Everything that touches the machine lives here; everything
// that decides what to do lives there.
//
// This command deliberately does NOT boot a server, bind a port, or run
// migrations, and there is no Category A install phase. It reads
// `<LIBI_HOME>/mcp-port` to learn where a running libi is listening (falling
// back to the configured default when libi isn't up yet — the registration is
// still correct, the tools just appear later), shells out to the user's OWN
// `claude`/`codex` binaries, and records and writes libi's skills for both
// agents through the install service, so a running libi keeps them current.
// Finding the two CLIs takes up to ~10 s in the worst case: they resolve one
// after the other (Claude's registration runs in between), and each resolution
// is a bounded login-shell PATH probe (≤ 2 s; reused only if the previous one
// is under 5 s old) plus `--version` (≤ 3 s). Each `mcp add` it then runs has
// its own 30 s bound on top of that.
//
// It is NOT free of side effects under `~/.libi`, though: the install service
// opens the database, and `getDb()` creates the standard `LIBI_HOME` scaffold
// plus an empty `libi.sqlite` the first time it runs. That is the only thing
// this command writes there, and it is a consequence of reading and recording
// skill installs, not of booting anything.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { getMcpPortFile } from "@/lib/libi-home";
import { resolveAgentCli, type ResolvedAgentCli } from "@/lib/agents/cli/resolve";
import { resolveCmdShimNativeTarget, spawnViaNodeIfScript } from "@/lib/agents/cli/spawn-shape";
import { isWindows } from "@/lib/platform";
import type { UserCliSource } from "@/lib/agents/user-cli";
import { backupCodexConfig } from "@/lib/codex-config/backup";
import { resolveCodexHome } from "@/lib/codex-config/canonical";
import { addSkillInstall, listSkillInstalls } from "@/mcp/skills/installs";
import { trackServerEvent } from "@/lib/analytics/server";
import {
  MCP_SERVER_NAME,
  addedServerName,
  resolveConnectDir,
  resolveConnectUrl,
  runConnect,
} from "./connect";

interface RunResult {
  ok: boolean;
  stderr: string;
  /** Where `config.toml` was copied to before a codex write, if anywhere. */
  configBackup?: string | null;
}

/**
 * Copy the user's `config.toml` aside before a `codex mcp add`/`remove`.
 *
 * `codex mcp add` re-serializes the ENTIRE file, and `codex mcp remove` does
 * not undo that — measured on codex-cli 0.153.4 (see lib/codex-config/backup.ts).
 * libi is the one that invoked it, so libi is the one that owes the user a copy.
 *
 * Keyed on the BINARY, not on the args: this same `run` also drives `claude mcp
 * add` (a different config, in a different format, that codex never touches),
 * and any codex add or remove is just as capable of rewriting the file as
 * libi's own registration is.
 */
function backupCodexConfigFor(
  bin: string,
  args: string[],
  env?: Record<string, string>,
): string | null {
  const base = path.basename(bin).toLowerCase();
  const isCodex = base === "codex" || base === "codex.exe";
  const writes = args[0] === "mcp" && (args[1] === "add" || args[1] === "remove");
  if (!isCodex || !writes) return null;
  return backupCodexConfig(env?.CODEX_HOME ?? resolveCodexHome());
}

/** The one shape of `child_process.execFile` this module uses, narrowed so a
 *  test can substitute a fake without reproducing the real overload set. */
export type ExecFileLike = (
  bin: string,
  args: string[],
  options: { cwd: string; timeout: number; windowsHide: boolean; env?: NodeJS.ProcessEnv },
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

/**
 * What `execFile` is actually handed for `bin`. On Windows a `.cmd`/`.bat`
 * shim — what `npm i -g @anthropic-ai/claude-code` (or `@openai/codex`) puts
 * in `%APPDATA%\npm` — cannot be execFile'd at all: since the CVE-2024-27980
 * fix Node refuses it with `spawn EINVAL` (measured on the Windows QA VM, Node
 * 22.20, claude-code 2.1.267). So run the shim's TARGET, as the chat's CLI
 * resolver does (`lib/agents/cli/resolve.ts`): a native `.exe` directly, a
 * `.js` through node. A shim of any other shape is passed through unchanged.
 *
 * `isWindows()`, never a `process.platform` literal: a bundler can fold that
 * comparison against the build machine (see `lib/platform.ts`).
 */
export function spawnShapeFor(
  bin: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): { command: string; args: string[] } {
  if (!isWindows() || !/\.(cmd|bat)$/i.test(bin)) return { command: bin, args: [] };
  const native = resolveCmdShimNativeTarget(bin, readFile);
  if (native) return { command: native, args: [] };
  return spawnViaNodeIfScript(bin, (p) => p, readFile);
}

const nodeExecFile: ExecFileLike = (bin, args, options, callback) => {
  execFile(bin, args, options, callback);
};

function exec(
  execFileImpl: ExecFileLike,
  bin: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    // windowsHide: a packaged Windows app has no console of its own, so
    // spawning `claude`/`codex` without it flashes a terminal window.
    // `env` is layered OVER the process env (a codex call needs CODEX_HOME,
    // but the child still needs PATH and HOME); undefined inherits as-is.
    const shape = spawnShapeFor(bin);
    execFileImpl(
      shape.command,
      [...shape.args, ...args],
      { cwd, timeout: 30_000, windowsHide: true, env: env ? { ...process.env, ...env } : undefined },
      (err, _stdout, stderr) => resolve({ ok: !err, stderr: String(stderr ?? "") }),
    );
  });
}

/** `claude mcp add … libi <url>` on a folder that already has the entry exits
 *  1 with "MCP server libi already exists in local config" (measured against
 *  Claude Code 2.1.245, on stderr). `libi connect` must be re-runnable — the
 *  URL changes whenever the studio port does — so a duplicate name is treated
 *  as "replace it", not as a failure: remove once, in the SAME scope the add
 *  targeted, and add again. Exactly one retry; a second failure is reported
 *  as-is so the user gets the real message. */
export function removeArgsFor(addArgs: string[], name: string = MCP_SERVER_NAME): string[] {
  const scopeAt = addArgs.indexOf("--scope");
  // Claude Code's default scope is `local`; naming it explicitly keeps the
  // removal inside the scope the add collided with. Codex has no scopes at
  // all (registrations are always user-wide) and rejects the flag, so its
  // remove carries just the name.
  const scope =
    scopeAt >= 0 ? addArgs[scopeAt + 1] : addArgs.includes("--transport") ? "local" : null;
  return ["mcp", "remove", ...(scope ? ["--scope", scope] : []), name];
}

/** Build the `ConnectDeps["run"]` over an injectable `execFile`. Exported as a
 *  factory purely so the retry above can be unit-tested against a fake child
 *  process instead of a real `claude`/`codex` binary. Every add it runs is
 *  `libi connect` registering libi's OWN entry, which is why a duplicate name
 *  is replaced rather than reported. `env` is optional (CODEX_HOME for a codex
 *  call); `libi connect` passes none and inherits the process env. */
export function makeRun(
  execFileImpl: ExecFileLike = nodeExecFile,
): (bin: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<RunResult> {
  return async function run(bin, args, cwd, env) {
    // ONE copy for the whole call, including the remove+re-add retry below:
    // the second and third spawns rewrite a file codex itself just wrote, so
    // backing those up as well would bury the user's own version.
    const backup = backupCodexConfigFor(bin, args, env);
    // Present only when a copy was actually taken, so a claude add — or a codex
    // call with nothing yet to protect — keeps the exact `{ ok, stderr }` shape
    // every other caller was written against.
    const configBackup = backup ? { configBackup: backup } : {};
    const first = await exec(execFileImpl, bin, args, cwd, env);
    const isAdd = args[0] === "mcp" && args[1] === "add";
    if (first.ok || !isAdd || !/already exists/i.test(first.stderr)) {
      return { ...first, ...configBackup };
    }
    const removed = await exec(execFileImpl, bin, removeArgsFor(args, addedServerName(args)), cwd, env);
    if (!removed.ok) return { ...first, ...configBackup };
    return { ...(await exec(execFileImpl, bin, args, cwd, env)), ...configBackup };
  };
}

const run = makeRun();

/** `libi connect` finds the CLIs through the same resolver as the app. A
 *  found-but-broken CLI is still handed over: `mcp add` will fail loudly and
 *  the step prints the command for the user to run. */
function toUserCliSource(r: ResolvedAgentCli): UserCliSource {
  if (r === null) return { kind: "none" };
  return { kind: "user", path: r.path };
}

export async function connectCommand(
  dirArg: string | undefined,
  opts: { global?: boolean },
): Promise<void> {
  const dir = resolveConnectDir(dirArg, process.env);
  const { url, running } = resolveConnectUrl(process.env, () => {
    try {
      return fs.readFileSync(getMcpPortFile(), "utf-8").trim();
    } catch {
      return null;
    }
  });

  process.stdout.write(
    `[libi] Connecting ${opts.global ? "all folders" : dir} to ${url}\n`,
  );
  if (!running) {
    process.stdout.write(
      `[libi] libi isn't running right now — the tools appear once you start it (npx @nagellabs/libi, or the desktop app).\n`,
    );
  }

  // No `libiRoots` override needed: `resolveAgentCli` defaults to
  // `libiTreeRoots()`, which is anchored on libi's own package root
  // (`packageRoot(__dirname)`, resolved inside `lib/agents/user-cli.ts`) as
  // well as `process.cwd()` — correct here even though `libi connect`
  // deliberately stays in the folder the user is connecting, rather than
  // chdir-ing to libi's package root the way `startStudio` does. Left on cwd
  // alone, nothing under libi's own install would be recognised as libi's,
  // and the `@openai/codex` that npm hoists next to an installed
  // `@nagellabs/libi` — `<consumer>/node_modules/.bin/codex`, on PATH for the
  // whole `npx libi …` run — would count as the user's codex. Measured, not
  // theoretical: an early run reported `codex: registered "libi"` and really
  // wrote `~/.codex/config.toml` on a machine whose owner has no codex at all.
  // The resolver rejects that hit and answers `null`, so the user now reads
  // "codex is not on your PATH" rather than "the only codex on your PATH is
  // libi's bundled copy" (that wording remains for injected sources).
  const steps = await runConnect(
    { dir, global: Boolean(opts.global), url, running },
    {
      // `holdEventLoop`: this is a one-shot process. The login-shell probe inside the
      // resolver unrefs its shell so it never holds a server open; here nothing else
      // holds the loop, and Node used to exit mid-lookup — "Connecting …", exit 0,
      // nothing registered and nothing installed.
      findClaude: async () => toUserCliSource(await resolveAgentCli("claude-code", { holdEventLoop: true })),
      findCodex: async () => toUserCliSource(await resolveAgentCli("codex", { holdEventLoop: true })),
      run,
      installSkills: addSkillInstall,
      listInstalls: listSkillInstalls,
    },
  );

  for (const step of steps) {
    if (step.status === "skipped" && step.id !== "skills") continue;
    process.stdout.write(`[libi] ${step.status === "done" ? "✓" : "→"} ${step.detail}\n`);
  }

  // A refused or failed skills install (any outcome other than the
  // one-level-per-agent skip `user_level_installed`, an unmigrated DB
  // included) means the run did not do what it promised, even though every
  // step was "handled" rather than thrown — fail the process so scripts and
  // CI notice. Registration (`claude`/`codex`) steps never set `failed`, so
  // a missing/broken CLI keeps its existing exit-0-regardless behavior.
  if (steps.some((step) => step.failed)) {
    process.exitCode = 1;
  }

  // Find by id, not by position: `runConnect` owns the order of its steps and
  // is free to change it.
  const claude = steps.find((s) => s.id === "claude")?.status === "done";
  const codex = steps.find((s) => s.id === "codex")?.status === "done";
  trackServerEvent("cli_connected", {
    agent: claude && codex ? "both" : claude ? "claude" : codex ? "codex" : "none",
    scope: opts.global ? "global" : "folder",
  });

  process.stdout.write(
    `[libi] Next: open \`claude\` or \`codex\`${opts.global ? "" : ` in ${dir}`} and type /mcp — "${MCP_SERVER_NAME}" should be listed.\n` +
      `[libi] Manage these on Agents → Global setup in libi.\n`,
  );
}
