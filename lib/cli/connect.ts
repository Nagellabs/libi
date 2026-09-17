import fs from "node:fs";
import path from "node:path";
import { getLibiHome, resolveMcpHttpPort } from "@/lib/libi-home";
import { classifyCliPath, libiInstallRoots, type UserCliSource } from "@/lib/agents/user-cli";
import { LIBI_MCP_ENTRY_NAME } from "@/lib/mcp/agent-surface";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import type { AddSkillInstallInput, SkillInstallView } from "@/lib/agents/skill-installs-types";
import { AGENT_SKILL_TARGETS } from "@/lib/agents/skill-targets";

/**
 * The name this writes into the user's own agent config — and, deliberately,
 * the same name libi's in-app ACP entry uses, so an in-app session REPLACES
 * this registration instead of mounting libi twice. Single-sourced from
 * `lib/mcp/agent-surface.ts` because the two halves drifting apart is exactly
 * the bug: see `LIBI_MCP_ENTRY_NAME` there.
 */
export const MCP_SERVER_NAME = LIBI_MCP_ENTRY_NAME;

/** Default: the folder the user ran `libi connect` from (bin/libi.js records it in LIBI_LAUNCH_CWD before chdir-ing). */
export function resolveConnectDir(arg: string | undefined, env: Record<string, string | undefined>): string {
  const base = env.LIBI_LAUNCH_CWD || process.cwd();
  return arg ? path.resolve(base, arg) : base;
}

export function resolveConnectUrl(env: NodeJS.ProcessEnv, readPortFile: () => string | null): { url: string; running: boolean } {
  const raw = readPortFile();
  const port = raw && Number.isFinite(Number.parseInt(raw, 10)) ? Number.parseInt(raw, 10) : resolveMcpHttpPort(env);
  return { url: `http://127.0.0.1:${port}/mcp`, running: raw !== null };
}

/** Always the user scope: libi's tools are for the whole account, whichever folder `connect` ran in. */
export function claudeMcpAddArgs(url: string): string[] {
  return ["mcp", "add", "--transport", "http", "--scope", "user", MCP_SERVER_NAME, url];
}
export function codexMcpAddArgs(url: string): string[] {
  return ["mcp", "add", MCP_SERVER_NAME, "--url", `${url}?agent=codex`];
}

/** `fs.realpathSync`, falling back to a plain resolve for a path that isn't on disk. */
function realpathBestEffort(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `root` and its realpath — either spelling may be the one a value matches. */
function rootSpellings(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    out.add(root);
    out.add(realpathBestEffort(root));
  }
  return [...out];
}

/**
 * `env.LIBI_HOME` — the fingerprint of the old `--connect-agent` writer.
 *
 * `buildReferenceServerEnv` (`lib/mcp/safe-env.ts`, as it stood before the
 * HTTP switch) pinned `LIBI_HOME` UNCONDITIONALLY on every stdio entry it
 * wrote, and nothing else does that: a person registering an upstream by hand
 * has no reason to tell someone else's MCP server where libi keeps its data.
 *
 * It replaced a `${VAR}` heuristic, which was wrong twice over. `${VAR}` is
 * Claude Code's own documented env-expansion idiom, so a user's own
 * `ElevenLabs` entry with `ELEVENLABS_API_KEY: "${ELEVENLABS_API_KEY}"` — the
 * form Anthropic's docs recommend — read as libi's and was deleted. And a
 * bundled server that needed no key (`YouTube Downloader`) never got a
 * `${VAR}` at all, so libi's own entry survived the cleanup that ate the
 * user's.
 *
 * The rule: the value counts when it resolves to, or inside, the home THIS
 * libi runs with, OR when its last segment is `.libi`. The second half matters
 * because the entry was written by whichever libi ran back then, with
 * whichever `LIBI_HOME` that run used — a different worktree, an older
 * install — and `~/.libi` is the shape they all share. A `LIBI_HOME` pointing
 * somewhere else entirely is NOT a fingerprint; a stale entry left behind is a
 * far cheaper mistake than a deleted registration the user wrote.
 */
function hasLibiHomePin(env: unknown): boolean {
  if (!env || typeof env !== "object") return false;
  const value = (env as Record<string, unknown>).LIBI_HOME;
  if (typeof value !== "string" || !value.trim()) return false;
  const resolved = realpathBestEffort(value);
  if (path.basename(resolved) === ".libi") return true;
  try {
    return classifyCliPath(resolved, rootSpellings([getLibiHome()])) === "libi-internal";
  } catch {
    return false;
  }
}

/** An ABSOLUTE path inside libi's own tree, in `command` or anywhere in `args`. */
function pointsIntoLibiTree(entry: { command?: unknown; args?: unknown }, libiRoots: string[]): boolean {
  const roots = rootSpellings(libiRoots);
  const candidates: unknown[] = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  return candidates.some((c) => {
    // Absolute only. `classifyCliPath` compares with `path.relative`, which
    // resolves a relative spelling against `process.cwd()` — and cwd is never
    // trusted as a root here (see `libiInstallRoots`), precisely because under
    // an installed `libi connect` it IS the user's folder. A bare `npx` or a
    // relative path therefore cannot be judged at all, and is left alone.
    if (typeof c !== "string" || !path.isAbsolute(c)) return false;
    // Judge both spellings — `classifyCliPath`'s contract is the realpath, but
    // the raw path is what a root written literally will match.
    return [c, realpathBestEffort(c)].some((spelling) => classifyCliPath(spelling, roots) === "libi-internal");
  });
}

/**
 * Does this `.mcp.json` entry look like something LIBI wrote?
 *
 * The name says nothing either way, so it is never consulted. The old
 * `--connect-agent` wrote its entries under `fal-ai`, `ElevenLabs`,
 * `YouTube Downloader` — exactly the names a user gives their OWN
 * registration of the same upstream — so a name-keyed cleanup would leave
 * every one of those pre-HTTP entries in place forever. Two fingerprints,
 * either of which is conclusive; anything else is left alone, because leaving
 * a stale libi entry behind is a far cheaper mistake than deleting a
 * registration the user wrote.
 */
function looksLibiWritten(entry: unknown, libiRoots: string[]): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { command?: unknown; args?: unknown; env?: unknown };
  return hasLibiHomePin(e.env) || pointsIntoLibiTree(e, libiRoots);
}

/**
 * Drop any root that IS, or CONTAINS, the folder being connected — belt and
 * braces over `libiInstallRoots()`, which already excludes cwd.
 *
 * The edge worth stating: a `LIBI_HOME` that happens to BE (or to contain) the
 * connect dir is still the user's folder for this purpose. We would rather
 * leave libi's own stale entries in a `.mcp.json` sitting inside someone's
 * `LIBI_HOME` than delete entries they wrote. A root strictly INSIDE the
 * connect dir is kept — connecting `~` does not make `~/.libi` the user's.
 */
function rootsOutsideConnectDir(dir: string, roots: string[]): string[] {
  const target = realpathBestEffort(dir);
  return roots.filter((root) => classifyCliPath(target, rootSpellings([root])) !== "libi-internal");
}

/**
 * Undo what `--connect-agent` (pre-HTTP) wrote into a folder. An entry is
 * removed when, and only when, `looksLibiWritten` recognises the entry
 * itself — whatever it is called.
 *
 * The roots default to `libiInstallRoots()`, NOT `libiTreeRoots()`: the latter
 * folds in `process.cwd()`, which under an installed `libi connect` is the very
 * folder being cleaned.
 */
export function cleanupLegacyConnectFiles(dir: string, libiRoots: string[] = libiInstallRoots()): string[] {
  const roots = rootsOutsideConnectDir(dir, libiRoots);
  const touched: string[] = [];
  const mcpJson = path.join(dir, ".mcp.json");
  if (fs.existsSync(mcpJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpJson, "utf-8")) as { mcpServers?: Record<string, unknown> };
      const servers = parsed.mcpServers ?? {};
      const before = Object.keys(servers).length;
      for (const name of Object.keys(servers)) {
        if (looksLibiWritten(servers[name], roots)) delete servers[name];
      }
      if (Object.keys(servers).length !== before) {
        fs.writeFileSync(mcpJson, JSON.stringify({ ...parsed, mcpServers: servers }, null, 2) + "\n");
        touched.push(mcpJson);
      }
    } catch { /* not ours to fix */ }
  }
  const settings = path.join(dir, ".claude", "settings.local.json");
  if (fs.existsSync(settings)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settings, "utf-8")) as Record<string, unknown>;
      if ("enableAllProjectMcpServers" in parsed) {
        delete parsed.enableAllProjectMcpServers;
        fs.writeFileSync(settings, JSON.stringify(parsed, null, 2) + "\n");
        touched.push(settings);
      }
    } catch { /* not ours to fix */ }
  }
  return touched;
}

export interface ConnectStep {
  id: "claude" | "codex" | "skills" | "legacy";
  /** Set on `skills` steps: which agent's install the line is about. */
  agentId?: SetupAgentId;
  status: "done" | "printed" | "skipped";
  detail: string;
  /**
   * Set on a `skills` step whose install did not happen: refused by
   * validation, or failed outright (no migrated DB yet, a write error) — every
   * outcome except the one-level-per-agent skip `user_level_installed`, which
   * stays a normal skip and never sets this.
   * `connectCommand` fails the whole run (`process.exitCode = 1`) when any
   * step carries it. Registration (`claude`/`codex`) steps never set it —
   * those keep their existing exit-0-regardless behavior.
   */
  failed?: boolean;
}

export interface ConnectDeps {
  findClaude: () => UserCliSource | Promise<UserCliSource>;
  findCodex: () => UserCliSource | Promise<UserCliSource>;
  /**
   * `configBackup` is the copy taken before a `codex mcp` write — codex
   * re-serializes the WHOLE of `config.toml` on `mcp add`, dropping empty
   * `args = []`, turning `120` into `120.0` and reordering env, and
   * `codex mcp remove` does not put any of it back. libi cannot avoid that
   * (hand-editing the file is worse), so it takes a copy and SAYS SO here.
   */
  run: (bin: string, args: string[], cwd: string) => Promise<{ ok: boolean; stderr: string; configBackup?: string | null }>;
  /** Record + write one install through the install service (`mcp/skills/installs.ts`). */
  installSkills: (input: AddSkillInstallInput) => Promise<SkillInstallView>;
  listInstalls: () => Promise<SkillInstallView[]>;
}

async function register(id: "claude" | "codex", found: UserCliSource, args: string[], cwd: string, deps: ConnectDeps): Promise<ConnectStep> {
  const printed = `${id} ${args.join(" ")}`;
  if (found.kind !== "user") {
    const why =
      found.kind === "none"
        ? `${id} is not on your PATH — run this yourself once ${id} is installed:`
        : `the only ${id} on your PATH is libi's bundled copy — install ${id} yourself, then run:`;
    return { id, status: "printed", detail: `${why}\n    ${printed}` };
  }
  let res: { ok: boolean; stderr: string; configBackup?: string | null };
  try {
    res = await deps.run(found.path, args, cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id, status: "printed", detail: `${id} mcp add could not run (${message}) — run it yourself:\n    ${printed}` };
  }
  if (!res.ok) return { id, status: "printed", detail: `${id} mcp add failed (${res.stderr.trim() || "no output"}) — run it yourself:\n    ${printed}` };
  const codexNote =
    id === "codex"
      ? ` (Codex registrations are always user-wide)${
          res.configBackup
            ? `\n    codex rewrote your config.toml — a copy of the previous one is at ${res.configBackup}`
            : ""
        }`
      : "";
  return { id, status: "done", detail: `${id}: registered "${MCP_SERVER_NAME}"${codexNote}` };
}

function isInstallError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && err.name === "SkillInstallError" && typeof (err as { code?: unknown }).code === "string";
}

function installedLine(name: string, view: SkillInstallView, everyFolder: boolean): string {
  const skipped = view.skippedNames.length
    ? ` — skipped ${view.skippedNames.length} you already use: ${view.skippedNames.join(", ")}`
    : "";
  const count = `${view.installedCount} ${view.installedCount === 1 ? "skill" : "skills"}`;
  return `${name} skills: ${count} in ${view.path}${everyFolder ? " (every folder)" : ""}${skipped}`;
}

async function installFor(agentId: SetupAgentId, name: string, opts: { dir: string; global: boolean }, deps: ConnectDeps): Promise<ConnectStep[]> {
  const steps: ConnectStep[] = [];
  // Every folder will have them, so the folder installs libi recorded for
  // this agent go — say which. Listed up front (before the add runs) so the
  // add can't have raced a folder install into existence in between, but
  // NOT printed yet: the service keeps a folder install standing when a
  // `--global` add fails (both when the write itself fails, and when
  // removing a folder install fails — see `mcp/skills/installs.ts#addUserInstall`),
  // so claiming "removed from …" ahead of the outcome would lie on a failure.
  let folders: SkillInstallView[] = [];
  if (opts.global) {
    // A failure here (e.g. no migrated DB yet) is not fatal: `installSkills` below
    // makes the same call and reports it properly, with the "re-run" guidance.
    try {
      folders = (await deps.listInstalls()).filter((i) => i.agentId === agentId && i.scope === "folder");
    } catch {
      folders = [];
    }
  }
  const input: AddSkillInstallInput = opts.global
    ? { agentId, scope: "user", source: "cli" }
    : { agentId, scope: "folder", folderPath: opts.dir, source: "cli" };
  try {
    const view = await deps.installSkills(input);
    // Only now, ahead of the "done" line, since the removal really happened.
    for (const f of folders) {
      steps.push({ id: "skills", agentId, status: "printed", detail: `${name} skills: removed from ${f.path} — every folder has them now` });
    }
    steps.push({ id: "skills", agentId, status: "done", detail: installedLine(name, view, opts.global) });
  } catch (err) {
    if (isInstallError(err) && err.code === "user_level_installed") {
      steps.push({ id: "skills", agentId, status: "skipped", detail: `${name} skills: not installed here — ${err.message}` });
    } else if (isInstallError(err) && err.code === "unknown_agent") {
      // Not a validation code "every folder" would fix, and not the generic
      // "start libi once" case either — an unknown agent is a libi bug, not
      // something a re-run addresses. Still a `SkillInstallError` other than
      // `user_level_installed`, so it fails the run.
      steps.push({ id: "skills", agentId, status: "printed", detail: `${name} skills: could not install (${err.message})`, failed: true });
    } else if (isInstallError(err)) {
      // `refused_home` is the one validation code where "every folder" is
      // actually the right answer, and the CLI says so in its OWN words
      // rather than the service's UI-flavored message ("choose Every
      // folder") with a CLI hint bolted on — the two used to mix, which read
      // oddly outside a form. Every other `InstallFolderError` (not_writable,
      // refused_libi_home, …) names a folder that "every folder" wouldn't fix
      // either, so it keeps printing the service message alone. Gated on
      // `!opts.global`: a `--global` add can throw `not_writable` with this
      // same code family, and `refused_home` itself is folder-only (it can
      // never fire on a `--global` install, which validates no folder).
      const detail =
        !opts.global && err.code === "refused_home"
          ? `${name} skills: That's your home folder — run libi connect --global to install libi's skills for every folder.`
          : `${name} skills: ${err.message}`;
      steps.push({ id: "skills", agentId, status: "printed", detail, failed: true });
    } else {
      // Nothing was installed, so this fails the run too: a script reading the
      // exit code alone must not see success over an unmigrated DB.
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ id: "skills", agentId, status: "printed", detail: `${name} skills: could not install (${message}) — start libi once, then re-run libi connect`, failed: true });
    }
  }
  return steps;
}

export async function runConnect(opts: { dir: string; global: boolean; url: string; running: boolean }, deps: ConnectDeps): Promise<ConnectStep[]> {
  const steps: ConnectStep[] = [];
  steps.push(await register("claude", await deps.findClaude(), claudeMcpAddArgs(opts.url), opts.dir, deps));
  steps.push(await register("codex", await deps.findCodex(), codexMcpAddArgs(opts.url), opts.dir, deps));
  for (const target of AGENT_SKILL_TARGETS) {
    steps.push(...(await installFor(target.agentId, target.name, opts, deps)));
  }
  const touched = opts.global ? [] : cleanupLegacyConnectFiles(opts.dir);
  steps.push(touched.length ? { id: "legacy", status: "done", detail: `removed old --connect-agent entries from ${touched.join(", ")}` } : { id: "legacy", status: "skipped", detail: "" });
  return steps;
}

/** The server name an `mcp add` argv targets: the first argument after
 *  `mcp add` that is neither a flag nor a flag's value — `claude mcp add
 *  --scope user <name> …`, `codex mcp add <name> --url …`. Falls back to
 *  libi's own name, which is what every `libi connect` add targets. Pure, so
 *  a caller can ask "which name would this add register?" without touching
 *  the machine. */
export function addedServerName(args: string[]): string {
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--") break;
    if (args[i].startsWith("-")) {
      i++;
      continue;
    }
    return args[i];
  }
  return MCP_SERVER_NAME;
}
