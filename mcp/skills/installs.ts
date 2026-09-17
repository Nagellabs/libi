import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skillInstalls } from "@/lib/db/schema";
import type { SkillInstallRow } from "@/lib/db/schema/types";
import { MCP_SUPERVISED_ENV, getLibiAgentDir, getLibiHome } from "@/lib/libi-home";
import { isShellEnvLoaded } from "@/lib/runtime/shell-env-state";
import { serverLogger as logger } from "@/lib/logger";
import { trackServerEvent } from "@/lib/analytics/server";
import type { AnalyticsProviderAgent } from "@/lib/analytics/events";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import {
  AGENT_SKILL_TARGETS,
  displayHomePath,
  displayUserSkillsDir,
  skillTargetFor,
  type AgentSkillTarget,
} from "@/lib/agents/skill-targets";
import {
  INSTALL_FOLDER_MESSAGES,
  LINKED_TO_LIBI_MESSAGE,
  USER_LEVEL_INSTALLED_MESSAGE,
  type AddSkillInstallInput,
  type InstallFolderError,
  type SkillInstallErrorCode,
  type SkillInstallScope,
  type SkillInstallSource,
  type SkillInstallView,
  type SkillInstallsResponse,
} from "@/lib/agents/skill-installs-types";
import { loadEnabledSkills } from "./loader";
import type { Skill } from "./types";
import {
  SKILL_DIALECTS,
  managedSkillNames,
  removeSkillsFromRoot,
  sanitizeErrForLog,
  writeSkillsToRoot,
  writeSkillsToWorkspace,
} from "./writer";

export type {
  AddSkillInstallInput,
  InstallFolderError,
  SkillInstallErrorCode,
  SkillInstallScope,
  SkillInstallSource,
  SkillInstallStatus,
  SkillInstallView,
  SkillInstallsResponse,
} from "@/lib/agents/skill-installs-types";

/*
 * Every place libi installed its skills for the user's OWN Claude Code / Codex:
 * a project folder (that agent's dialect under it) or the agent's user-level
 * dir. Rows are the memory that makes the copies updatable; the files are
 * written through `writeSkillsToRoot` with `external: true`, so a skill the
 * user already has by that name is never overwritten.
 *
 * A user-level install and folder installs are exclusive per agent: both agents
 * list a skill name found at two levels twice, and Codex then injects neither
 * on an explicit mention. The same holds for libi's own agent dir, whose chat
 * and terminal run with the user's HOME / CLAUDE_CONFIG_DIR — it stops writing
 * an agent's dialect while that agent has a user-level install.
 */

export class SkillInstallError extends Error {
  constructor(
    readonly code: SkillInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillInstallError";
  }
}

/** `folder_path` of a user-scope row (the unique index needs a non-NULL value); `null` everywhere else. */
const USER_SCOPE_KEY = "";

const EVENT_AGENT: Record<SetupAgentId, AnalyticsProviderAgent> = { "claude-code": "claude", codex: "codex" };
const SCOPES: readonly SkillInstallScope[] = ["user", "folder"];
const SOURCES: readonly SkillInstallSource[] = ["ui", "cli"];

/**
 * The on-disk path: symlinks resolved AND, on a case-insensitive disk, the
 * stored letter case (the JS `realpathSync` keeps whatever case was typed, so
 * `/USERS/me` would pass for a folder other than home and duplicate a row).
 * The native call has known failures on some Windows drives; the JS one backs it.
 */
function realpathOnDisk(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return fs.realpathSync(p);
  }
}

function realpathBestEffort(p: string): string {
  try {
    return realpathOnDisk(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Whether a user-level root, resolved, is libi's own agent dir or somewhere inside it —
 * `~/.agents/skills` linked into libi's own dialect root. Adding such an install would succeed,
 * then libi's own-dir refresh (which writes a linked-to-user-level dialect back as external, see
 * `ownAgentDirProtectedRoots`) writes the dialect straight back through the same link on the next
 * Remove, leaving the skills visible at user level while the card reads "Not installed". Checked
 * before an add stands, and again wherever a row is written, since the link can appear later.
 */
function linkedToLibiAgentDir(root: string): boolean {
  return isInside(realpathBestEffort(root), realpathBestEffort(getLibiAgentDir()));
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A linked skills folder, whether libi is about to write through it (somewhere the user never
 * chose) or remove through it (deleting libi's skills at the link's target): sync's refusal, the
 * refused Remove (both the thrown 400 and the row's recorded error), and the add refusal all use
 * the same sentence.
 */
const LINKED_SKILLS_FOLDER_MESSAGE = "libi won't write or remove skills through a linked skills folder.";

/**
 * Whether this agent's skills dir under `folder`, or its parent inside `folder` (`.claude`, then
 * `.claude/skills`), exists as a symlink or junction. Only this agent's dialect: a linked `.claude`
 * says nothing about where Codex's `.agents/skills` goes. Checked when a folder install is added
 * and before every write, since a real folder can be swapped for a link later.
 */
function hasLinkedSkillsDir(folder: string, target: AgentSkillTarget): boolean {
  const segments = target.projectDialect.split("/");
  for (let i = 1; i <= segments.length; i++) {
    try {
      if (fs.lstatSync(path.join(folder, ...segments.slice(0, i))).isSymbolicLink()) return true;
    } catch {
      // Absent here means absent below.
      return false;
    }
  }
  return false;
}

/**
 * Whether a folder install's skills would be reached through a link: this agent's skills dir or its
 * parent (`hasLinkedSkillsDir`), or the recorded folder itself, swapped for a link since it was added
 * (its path was stored resolved). Neither a write nor a removal goes through one.
 */
function folderInstallLinked(row: SkillInstallRow): boolean {
  if (row.scope !== "folder") return false;
  try {
    if (fs.lstatSync(row.folderPath).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  return hasLinkedSkillsDir(row.folderPath, skillTargetFor(row.agentId));
}

/** The write probe's file name: dot-prefixed and random, so it is never a folder libi or the user already has. */
const WRITE_PROBE_PREFIX = ".libi-write-probe-";
/** Exactly the name a probe gets: the prefix and 16 hex characters. */
const WRITE_PROBE_NAME = /^\.libi-write-probe-[0-9a-f]{16}$/;

/**
 * Remove probe files an earlier probe of `dir` could not delete (Windows can allow creating a file and
 * deny deleting it). Only regular files named exactly like a probe, checked with lstat, so a link or a
 * folder by that name is never followed or removed. Best effort: a failure changes nothing about the
 * probe that follows. Another process's probe in flight may go too; its own delete then finds nothing,
 * which it already accepts.
 */
function clearLeftoverProbes(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!WRITE_PROBE_NAME.test(name)) continue;
    const leftover = path.join(dir, name);
    try {
      if (fs.lstatSync(leftover).isFile()) fs.unlinkSync(leftover);
    } catch {
      // still there, or already gone: either way nothing to report
    }
  }
}

/**
 * Whether libi can create, and delete, a file directly inside `dir` — tried for real, since a
 * permission check alone can pass for a folder a write is refused in: on Windows `access(W_OK)`
 * reads only the read-only attribute, never the folder's ACL. The probe is a new file (exclusive
 * create, so an entry already there, a link included, is never opened or followed) put straight
 * inside `dir`, which the caller has already resolved; it is removed however the probe ends.
 * A folder gone meanwhile reads as not found; any other failure means libi can't write there.
 * Probe files an earlier probe of `dir` left behind are cleared first (`clearLeftoverProbes`).
 */
function probeWritable(dir: string): "writable" | InstallFolderError {
  const verdict = (err: unknown): InstallFolderError => {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "not_found" : "not_writable";
  };
  clearLeftoverProbes(dir);
  const probe = path.join(dir, WRITE_PROBE_PREFIX + crypto.randomBytes(8).toString("hex"));
  let fd: number;
  try {
    fd = fs.openSync(probe, "wx");
  } catch (err) {
    // Nothing was created: an entry that happened to carry this name is not libi's to delete.
    return verdict(err);
  }
  let failure: unknown = null;
  try {
    fs.closeSync(fd);
  } catch (err) {
    failure = err;
  }
  try {
    fs.unlinkSync(probe);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // Deleting is part of what libi does to a folder it installs into (orphaned skills go).
    if (code !== "ENOENT") failure ??= err;
  }
  return failure === null ? "writable" : verdict(failure);
}

export function validateInstallFolder(
  p: string,
  ctx: { homedir: string; libiHome: string },
): { ok: true; realPath: string } | { ok: false; code: InstallFolderError; message: string } {
  const fail = (code: InstallFolderError) => ({ ok: false as const, code, message: INSTALL_FOLDER_MESSAGES[code] });
  const trimmed = p.trim();
  const expanded =
    trimmed === "~" ? ctx.homedir : /^~[\\/]/.test(trimmed) ? path.join(ctx.homedir, trimmed.slice(2)) : trimmed;
  if (!path.isAbsolute(expanded)) return fail("not_absolute");
  let real: string;
  try {
    real = realpathOnDisk(expanded);
  } catch {
    return fail("not_found");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return fail("not_found");
  }
  if (!stat.isDirectory()) return fail("not_directory");
  if (path.dirname(real) === real) return fail("refused_root");
  if (real === realpathBestEffort(ctx.homedir)) return fail("refused_home");
  if (isInside(real, realpathBestEffort(ctx.libiHome))) return fail("refused_libi_home");
  const writable = probeWritable(real);
  if (writable !== "writable") return fail(writable);
  return { ok: true, realPath: real };
}

function targetOrThrow(agentId: SetupAgentId): AgentSkillTarget {
  try {
    return skillTargetFor(agentId);
  } catch {
    throw new SkillInstallError("unknown_agent", "Unknown agent.");
  }
}

/**
 * The input as the types promise it, checked at runtime too: every value here
 * ends up in a row and an analytics param, so a caller that skipped its own
 * validation still cannot widen either. Scope and source have no code of their
 * own; like an agent id, they are identifiers the caller got wrong.
 */
function checkedTarget(input: AddSkillInstallInput): AgentSkillTarget {
  const target = targetOrThrow(input.agentId);
  if (!SCOPES.includes(input.scope)) {
    throw new SkillInstallError("unknown_agent", "Choose Every folder or a specific folder.");
  }
  if (!SOURCES.includes(input.source)) throw new SkillInstallError("unknown_agent", "Unknown install source.");
  return target;
}

/**
 * The skills root a row stands for. The user-level dir is resolved from the environment
 * now, which can differ between writers (the CLI's shell, the desktop app before its
 * login-shell env arrives, the MCP child) or change later; `last_root` records where the
 * last write went, so a copy left at a previous root is found again. Only a process whose
 * environment can be trusted acts on a resolved root that differs (`mayMoveUserRoot`).
 */
function rootFor(row: SkillInstallRow): string {
  const target = skillTargetFor(row.agentId);
  return row.scope === "user"
    ? target.userSkillsDir(process.env, os.homedir())
    : path.join(row.folderPath, target.projectDialect);
}

/** An MCP server's own entry file (`mcp/index`, `mcp/http/index`; source or compiled)… */
const MCP_ENTRY_FILE = /(^|[\\/])mcp[\\/](http[\\/])?index\.[cm]?[jt]s$/;
/** …or the CLI command that serves one (`libi serve-mcp`, `libi serve-mcp-http`). */
const MCP_SERVE_COMMANDS: ReadonlySet<string> = new Set(["serve-mcp", "serve-mcp-http"]);

/**
 * Whether this process may move a user-level root: its environment is the user's, and current.
 *
 * Writers see different environments. The MCP child holds a snapshot taken when it was spawned;
 * the desktop app's server runs before its login-shell environment arrives (`LIBI_SHELL_ENV`
 * pending, or failed for this launch). A supervised MCP child is recognised by the marker its
 * supervisor sets (`MCP_SUPERVISED_ENV`, read at call time, never deleted), an MCP server started
 * by hand by its entry file or CLI command. A root resolved there can differ from the one the server
 * or `libi connect` resolves, and moving libi's copy on each disagreement bounced it between
 * roots, deleting it at one every sync. So such a process writes where the last write went and
 * moves nothing; only the server with its environment loaded (or inherited from a shell) and the
 * CLI run in the user's shell move a root.
 */
function mayMoveUserRoot(): boolean {
  if (process.env[MCP_SUPERVISED_ENV] === "1") return false;
  const [, script = "", command = ""] = process.argv;
  if (MCP_ENTRY_FILE.test(script) || MCP_SERVE_COMMANDS.has(command)) return false;
  return isShellEnvLoaded(process.env);
}

/** A user-level row in a process that may not move its root stays at the root its last write recorded. */
function staysAtRecordedRoot(row: SkillInstallRow): boolean {
  return row.scope === "user" && row.lastRoot !== null && !mayMoveUserRoot();
}

/**
 * The root a row's copy lives at, as this process acts on it: the recorded root while it may not move a
 * user-level root, the resolved one otherwise. What a sync writes and what the list shows are the same root.
 */
function effectiveRoot(row: SkillInstallRow): string {
  return staysAtRecordedRoot(row) ? row.lastRoot! : rootFor(row);
}

/** A folder row whose folder is gone is never written: writing would recreate the folder. */
function folderExists(row: SkillInstallRow): boolean {
  return row.scope === "user" || isDirectory(row.folderPath);
}

function parseSkipped(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function viewOf(row: SkillInstallRow): SkillInstallView {
  const root = effectiveRoot(row);
  const missing = !folderExists(row);
  return {
    id: row.id,
    agentId: row.agentId,
    scope: row.scope,
    path: root,
    folderPath: row.scope === "user" ? null : row.folderPath,
    source: row.source,
    status: missing ? "folder-not-found" : row.lastError ? "error" : "up-to-date",
    error: missing ? null : row.lastError,
    skippedNames: parseSkipped(row.skippedNames),
    installedCount: missing ? 0 : managedSkillNames(root).length,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  };
}

/** A write failure as a row shows it: "permission denied", "disk full", … or the message's first line. */
export function shortInstallError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "ENOSPC") return "disk full";
  if (code === "EROFS") return "read-only file system";
  const message = err instanceof Error ? err.message : String(err);
  return message.split(/\r?\n/)[0].slice(0, 120);
}

/** Ensure a reason string ends with exactly one period, question mark, or exclamation point. */
function ensureReasonEndsWithPunctuation(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.endsWith(".") || trimmed.endsWith("!") || trimmed.endsWith("?")) {
    return trimmed;
  }
  return `${trimmed}.`;
}

/** Oldest first; rowid breaks ties inside the second `created_at` resolves to. */
function allRows(): SkillInstallRow[] {
  return getDb().select().from(skillInstalls).orderBy(asc(skillInstalls.createdAt), sql`rowid`).all();
}

function rowsFor(agentId: SetupAgentId, scope: "user" | "folder"): SkillInstallRow[] {
  return getDb()
    .select()
    .from(skillInstalls)
    .where(and(eq(skillInstalls.agentId, agentId), eq(skillInstalls.scope, scope)))
    .orderBy(asc(skillInstalls.createdAt), sql`rowid`)
    .all();
}

function hasUserLevel(agentId: SetupAgentId): boolean {
  return rowsFor(agentId, "user").length > 0;
}

/** Record an install, or find the one already recorded there. `created` says which. */
function recordRow(
  agentId: SetupAgentId,
  scope: SkillInstallScope,
  folderKey: string,
  source: SkillInstallSource,
): { row: SkillInstallRow; created: boolean } {
  const db = getDb();
  const inserted = db
    .insert(skillInstalls)
    .values({ agentId, scope, folderPath: folderKey, source })
    .onConflictDoNothing()
    .run();
  const row = db
    .select()
    .from(skillInstalls)
    .where(and(eq(skillInstalls.agentId, agentId), eq(skillInstalls.scope, scope), eq(skillInstalls.folderPath, folderKey)))
    .get();
  if (!row) throw new Error("skill install row missing after insert");
  return { row, created: inserted.changes > 0 };
}

function deleteRow(id: string): void {
  getDb().delete(skillInstalls).where(eq(skillInstalls.id, id)).run();
}

function rowById(id: string): SkillInstallRow | undefined {
  return getDb().select().from(skillInstalls).where(eq(skillInstalls.id, id)).get();
}

/** `root-gone`: a user-level row that stays at its recorded root found that root's folder gone, and did not recreate it. */
type WriteOutcome = "written" | "failed" | "folder-not-found" | "root-gone";

/**
 * How a user-level root is removed from: through a link at the root itself, since a user who linked
 * their agent's skills dir (a dotfiles setup) has the agent read skills through it. A folder install's
 * root is never removed through a link; that would delete somewhere the user never chose for libi.
 */
const USER_ROOT_REMOVAL = { external: true, rootMayBeLink: true } as const;

/** The same directory however it is spelled: reaching it through a link is not a move. */
function sameRoot(a: string, b: string): boolean {
  return a === b || realpathBestEffort(a) === realpathBestEffort(b);
}

/**
 * Write one row's root; the outcome lands on the row. Synchronous, so callers read the row and write it with no await between.
 *
 * `last_root` names the one root where this row's copy may live. When the freshly resolved
 * user-level root differs, libi's skills leave the recorded root first (manifest-listed only). If
 * that removal throws, nothing is written to the new root — a copy at a root no row records could
 * never be updated or removed again — the recorded root stays, and the error lands on the row for
 * the next sync to retry. Past that point the new root is recorded whether or not the write
 * completes, since a partial write there is now the only copy.
 *
 * A process that may not move a user-level root (`mayMoveUserRoot`) writes the recorded root
 * instead, when there is one, and never recreates it once its parent folder is gone.
 */
function writeRow(row: SkillInstallRow, skills: Skill[]): WriteOutcome {
  if (!folderExists(row)) return "folder-not-found";
  const db = getDb();
  if (folderInstallLinked(row)) {
    db.update(skillInstalls).set({ lastError: LINKED_SKILLS_FOLDER_MESSAGE }).where(eq(skillInstalls.id, row.id)).run();
    return "failed";
  }
  if (staysAtRecordedRoot(row) && !isDirectory(path.dirname(row.lastRoot!))) {
    const lastError = `libi's skills folder ${displayHomePath(row.lastRoot!, os.homedir())} is gone.`;
    db.update(skillInstalls).set({ lastError }).where(eq(skillInstalls.id, row.id)).run();
    return "root-gone";
  }
  const root = effectiveRoot(row);
  if (row.scope === "user" && linkedToLibiAgentDir(root)) {
    // Found in this state at sync time (the link can appear after the row was recorded): the
    // same refusal `addUserInstall` gives up front, recorded on the row instead of thrown — and
    // nothing is written through it.
    db.update(skillInstalls).set({ lastError: LINKED_TO_LIBI_MESSAGE }).where(eq(skillInstalls.id, row.id)).run();
    return "failed";
  }
  // Only a user-level root is resolved from the environment; a folder install's root is fixed by its folder.
  if (row.scope === "user" && row.lastRoot && !sameRoot(row.lastRoot, root)) {
    try {
      const { removed } = removeSkillsFromRoot(row.lastRoot, USER_ROOT_REMOVAL);
      logger.info({ tag: "skills", op: "user_root_moved", agentId: row.agentId, scope: row.scope, removed }, "skills.user_root_moved");
    } catch (err) {
      logger.warn(
        { err: sanitizeErrForLog(err), tag: "skills", op: "user_root_move_failed", agentId: row.agentId, scope: row.scope },
        "skills.user_root_move_failed",
      );
      // Named, because the view's path already shows the new root, not the one that failed.
      const lastError = `Couldn't clean up libi's skills in ${displayHomePath(row.lastRoot, os.homedir())}: ${shortInstallError(err)}`;
      db.update(skillInstalls).set({ lastError }).where(eq(skillInstalls.id, row.id)).run();
      return "failed";
    }
  }
  try {
    const result = writeSkillsToRoot(root, skills, { external: true });
    db.update(skillInstalls)
      .set({ lastSyncedAt: new Date(), lastError: null, skippedNames: JSON.stringify(result.skipped), lastRoot: root })
      .where(eq(skillInstalls.id, row.id))
      .run();
    return "written";
  } catch (err) {
    db.update(skillInstalls).set({ lastError: shortInstallError(err), lastRoot: root }).where(eq(skillInstalls.id, row.id)).run();
    return "failed";
  }
}

/** The dialects libi's own agent dir writes: all of them, minus the dialect of every agent with a user-level install. */
export function ownAgentDirDialects(): readonly string[] {
  const dropped = new Set(
    AGENT_SKILL_TARGETS.filter((t) => rowsFor(t.agentId, "user").length > 0).map((t) => t.projectDialect),
  );
  return SKILL_DIALECTS.filter((d) => !dropped.has(d));
}

/**
 * Every agent's user-level skills dir: as this process resolves it, and wherever a user-level install
 * last wrote (a process that may not move a root keeps writing there). libi's own agent dir never
 * removes from one of these, even through a link, and writes one only as an external root — see
 * `writeSkillsToWorkspace`.
 *
 * Both sides are compared resolved, so the reverse link — a user-level skills dir linked to one of
 * libi's own dialect roots — is covered too: adding the user-level install no longer has its copy
 * removed by the own dir's drop. What stays is how that link has always behaved, and is not harm to
 * any file of the user's: the two copies are one set of files, so removing the user-level install
 * removes them and the own dir, taking the dialect back, writes them straight back where the agent
 * still reads them for every folder. libi's own agent dir is not meant to be linked to an agent's
 * user-level skills dir in either direction.
 */
function ownAgentDirProtectedRoots(): string[] {
  const roots = AGENT_SKILL_TARGETS.map((t) => t.userSkillsDir(process.env, os.homedir()));
  for (const row of allRows()) {
    if (row.scope === "user" && row.lastRoot && !roots.includes(row.lastRoot)) roots.push(row.lastRoot);
  }
  return roots;
}

/** How libi's own agent dir is written: the dialects it carries, and the user-level skills dirs it never removes from. */
export function ownAgentDirWriteOptions(): { dialects: readonly string[]; protectedRoots: string[] } {
  return { dialects: ownAgentDirDialects(), protectedRoots: ownAgentDirProtectedRoots() };
}

export async function syncOwnAgentDir(skills?: Skill[]): Promise<void> {
  await writeSkillsToWorkspace(getLibiAgentDir(), skills ?? (await loadEnabledSkills()), ownAgentDirWriteOptions());
}

/** After a user-level install changes, libi's own agent dir follows in the same operation. The install itself already stands, so a failure here is logged, not thrown. */
async function refreshOwnAgentDir(skills?: Skill[]): Promise<void> {
  try {
    await syncOwnAgentDir(skills);
  } catch (err) {
    logger.warn({ err: sanitizeErrForLog(err), tag: "skills", op: "own_agent_dir_failed" }, "skills.own_agent_dir_failed");
  }
}

function userLevelInstalled(): SkillInstallError {
  return new SkillInstallError("user_level_installed", USER_LEVEL_INSTALLED_MESSAGE);
}

function linkedToLibi(): SkillInstallError {
  return new SkillInstallError("linked_to_libi", LINKED_TO_LIBI_MESSAGE);
}

/** A user-level add's own row vanished under it (a concurrent add of the same level backed out). Reuses `not_writable`: closest existing code for "could not stand". */
const USER_LEVEL_INSTALL_LOST_MESSAGE = "libi's skills weren't installed for every folder. Try again.";

/** A folder add's own row was deleted while it loaded skills, by something other than a user-level add (the DELETE route). Same code, same reason. */
const FOLDER_INSTALL_LOST_MESSAGE = "That install was removed while libi was installing it.";

function trackAdded(agentId: SetupAgentId, scope: SkillInstallScope, source: SkillInstallSource, created: boolean): void {
  if (created) trackServerEvent("skills_install_added", { agent: EVENT_AGENT[agentId], scope, source });
  logger.info({ tag: "skills", op: "install_added", agentId, scope, source, created }, "skills.install_added");
}

/**
 * Validate, record (or find the existing record), and write now. Throws `SkillInstallError` for a refusal,
 * and for a user-level add that could not stand — in which case the agent is left at the level it was at.
 * `skills_install_added` fires once per install, and only when its first write landed.
 */
export async function addSkillInstall(input: AddSkillInstallInput): Promise<SkillInstallView> {
  const target = checkedTarget(input);
  return input.scope === "folder"
    ? addFolderInstall(target.agentId, input.folderPath, input.source)
    : addUserInstall(target, input.source);
}

async function addFolderInstall(agentId: SetupAgentId, folderPath: string, source: SkillInstallSource): Promise<SkillInstallView> {
  const verdict = validateInstallFolder(folderPath, { homedir: os.homedir(), libiHome: getLibiHome() });
  if (!verdict.ok) throw new SkillInstallError(verdict.code, verdict.message);
  if (hasLinkedSkillsDir(verdict.realPath, skillTargetFor(agentId))) {
    throw new SkillInstallError("not_writable", LINKED_SKILLS_FOLDER_MESSAGE);
  }
  if (hasUserLevel(agentId)) throw userLevelInstalled();
  const { row, created } = recordRow(agentId, "folder", verdict.realPath, source);
  // Checked again once this row stands, so exclusivity never rests on nothing
  // running between the check and the insert: a user-level install recorded
  // in that gap wins, and this one backs out before writing anything.
  if (hasUserLevel(agentId)) {
    if (created) deleteRow(row.id);
    throw userLevelInstalled();
  }

  const skills = await loadEnabledSkills();
  // Re-read after the await: an install removed meanwhile is not written back.
  const current = rowById(row.id);
  if (!current) {
    // A user-level install that landed meanwhile took this folder with it.
    if (hasUserLevel(agentId)) throw userLevelInstalled();
    // Removed outright: a view of that row would report an install that no longer exists.
    throw new SkillInstallError("not_writable", FOLDER_INSTALL_LOST_MESSAGE);
  }
  const outcome = writeRow(current, skills);
  trackAdded(agentId, "folder", source, created && outcome === "written");
  return viewOf(rowById(row.id) ?? row);
}

async function addUserInstall(target: AgentSkillTarget, source: SkillInstallSource): Promise<SkillInstallView> {
  const agentId = target.agentId;
  if (linkedToLibiAgentDir(target.userSkillsDir(process.env, os.homedir()))) throw linkedToLibi();
  // The user-level row goes in first, so a folder add from here on is refused;
  // the folder installs go only once the user-level copy is known to stand.
  const { row, created } = recordRow(agentId, "user", USER_SCOPE_KEY, source);
  const skills = await loadEnabledSkills();
  const current = rowById(row.id);
  if (!current) {
    // The row this call shared went while it was loading skills — either a
    // concurrent add for the same agent backed out, or the row was removed
    // outright through the DELETE route: nothing stands to write or take
    // away, and a view of that row would misreport as up to date for an
    // install that no longer exists.
    throw new SkillInstallError("not_writable", USER_LEVEL_INSTALL_LOST_MESSAGE);
  }

  // An accepted race. While this add awaits the skills load, a sync (this process's, or the server's
  // while this is `libi connect`) can write this same row and reconcile the agent's folder installs
  // away. If the write below then fails, the back-out removes the user level too, and the agent is
  // left with no level: no sync restores one, since neither row remains. It takes a write failing
  // right after another writer succeeded at the same root; the error thrown says only what failed
  // (`kept` is 0, so it never claims the folder installs stayed), and installing again restores the
  // level. Only libi's own copies are ever lost. A guard in this process could not see the other.
  if (writeRow(current, skills) !== "written") {
    const reason = rowById(row.id)?.lastError ?? "write failed";
    const kept = rowsFor(agentId, "folder").length;
    // Only what this call recorded is undone; a row that was already there keeps its error for the list.
    if (created) await backOutUserLevel(current, [], skills, "write_failed");
    throw new SkillInstallError(
      "not_writable",
      `libi can't write to ${displayUserSkillsDir(target, process.env, os.homedir())} (${reason}).` +
        (kept > 0 ? ` Your folder installs were kept.` : ""),
    );
  }

  // Every folder has them now, so this agent's folder installs go — files, then rows. Listed
  // after the insert and the write, so a folder add that slipped in before the insert goes too.
  const removed: SkillInstallRow[] = [];
  for (const folderRow of rowsFor(agentId, "folder")) {
    try {
      await removeSkillInstall(folderRow.id);
    } catch (err) {
      // Removal can throw after deleting only SOME of this folder's skill
      // dirs; its own row is never deleted on a throw (removeSkillInstall
      // deletes it only after removal returns), so write it back now through
      // the same path the back-out below uses — writeRow never recreates a
      // folder that is gone, so this is exactly as safe as leaving it alone
      // when nothing was actually removed.
      const partial = rowById(folderRow.id);
      if (partial) writeRow(partial, skills);
      // That folder keeps its copy, so the user level cannot stand beside it.
      await backOutUserLevel(current, removed, skills, "folder_remove_failed");
      throw new SkillInstallError(
        "not_writable",
        `libi couldn't remove its skills from ${rootFor(folderRow)}: ${ensureReasonEndsWithPunctuation(shortInstallError(err))} Nothing was installed for every folder.`,
      );
    }
    removed.push(folderRow);
  }
  await refreshOwnAgentDir(skills);
  trackAdded(agentId, "user", source, created);
  return viewOf(rowById(row.id) ?? row);
}

/**
 * Undo a user-level add that cannot stand: its files (only what the manifest names) and row go,
 * the folder installs it already took away come back, and libi's own agent dir picks the dialect up again.
 */
async function backOutUserLevel(
  userRow: SkillInstallRow,
  removedFolders: SkillInstallRow[],
  skills: Skill[],
  reason: "write_failed" | "folder_remove_failed",
): Promise<void> {
  // Where the row says this add wrote, as well as the root resolved now: a process that may not move
  // a user-level root wrote the recorded one, and a copy left there once the row goes is never found again.
  const recorded = rowById(userRow.id) ?? userRow;
  const roots = [rootFor(recorded)];
  if (recorded.lastRoot && !sameRoot(recorded.lastRoot, roots[0])) roots.push(recorded.lastRoot);
  for (const root of roots) {
    try {
      removeSkillsFromRoot(root, USER_ROOT_REMOVAL);
    } catch (err) {
      logger.warn(
        { err: sanitizeErrForLog(err), agentId: userRow.agentId, tag: "skills", op: "user_level_cleanup_failed" },
        "skills.user_level_cleanup_failed",
      );
    }
  }
  deleteRow(userRow.id);
  for (const folderRow of removedFolders) {
    getDb().insert(skillInstalls).values(folderRow).onConflictDoNothing().run();
    const restored = rowById(folderRow.id);
    if (restored) writeRow(restored, skills);
  }
  await refreshOwnAgentDir(skills);
  logger.warn(
    { tag: "skills", op: "user_level_backed_out", agentId: userRow.agentId, reason, restored: removedFolders.length },
    "skills.user_level_backed_out",
  );
}

/**
 * libi's files first (only what its manifest names), then the row. `null` for an unknown id.
 * A manifest at the current root that exists but cannot be read throws `removeSkillsFromRoot`'s
 * recovery-message error before anything is deleted, so the row stands and the folders are left
 * exactly as they were for a retry — never silently forgotten as if libi had never written there.
 * A user-level root the install moved away from is cleaned up best effort: failing there is logged
 * and does not keep the install. A folder install reached through a link removes nothing and throws
 * `SkillInstallError`; its row stays, with the reason a sync shows.
 */
export async function removeSkillInstall(id: string): Promise<{ removed: number } | null> {
  const row = rowById(id);
  if (!row) return null;
  const removed = removeInstallNow(row);
  if (row.scope === "user") await refreshOwnAgentDir();
  return { removed };
}

/** `removeSkillInstall`'s own steps, without libi's own agent dir following: files, then the row. Synchronous, so a sync run reconciles before its first await. */
function removeInstallNow(row: SkillInstallRow): number {
  let removed = 0;
  if (folderExists(row)) {
    if (folderInstallLinked(row)) {
      // The manifest read through the link would name libi's skills at its target, which another
      // install or the user's shared skills dir owns. Nothing is removed; the row stays, with why.
      getDb().update(skillInstalls).set({ lastError: LINKED_SKILLS_FOLDER_MESSAGE }).where(eq(skillInstalls.id, row.id)).run();
      // Only on the first refusal, or a different message than last time — otherwise a row stuck in
      // this state (the reconcile exists for exactly this) warns on every sync forever.
      if (row.lastError !== LINKED_SKILLS_FOLDER_MESSAGE) {
        logger.warn(
          { tag: "skills", op: "install_remove_refused", agentId: row.agentId, scope: row.scope, reason: "linked_skills_folder" },
          "skills.install_remove_refused",
        );
      }
      throw new SkillInstallError("not_writable", LINKED_SKILLS_FOLDER_MESSAGE);
    }
    const root = rootFor(row);
    // A root that moved since the last write still holds libi's copy at the recorded one.
    if (row.scope === "user" && row.lastRoot && !sameRoot(row.lastRoot, root)) {
      // Best effort: an old root libi can no longer read must not make the install unremovable.
      // Its folders stay (an unreadable manifest can't tell libi's from the user's).
      try {
        removed += removeSkillsFromRoot(row.lastRoot, USER_ROOT_REMOVAL).removed;
      } catch (err) {
        logger.warn(
          { err: sanitizeErrForLog(err), tag: "skills", op: "user_root_cleanup_failed", agentId: row.agentId, scope: row.scope },
          "skills.user_root_cleanup_failed",
        );
      }
    }
    removed += removeSkillsFromRoot(root, { external: true, rootMayBeLink: row.scope === "user" }).removed;
  }
  getDb().delete(skillInstalls).where(eq(skillInstalls.id, row.id)).run();
  logger.info(
    { tag: "skills", op: "install_removed", agentId: row.agentId, scope: row.scope, removed },
    "skills.install_removed",
  );
  return removed;
}

export async function listSkillInstalls(): Promise<SkillInstallView[]> {
  return allRows().map(viewOf);
}

/** Per agent, the resolved user-level skills dir as copy shows it. */
export function userSkillsDirs(): Record<SetupAgentId, string> {
  const out = {} as Record<SetupAgentId, string>;
  for (const target of AGENT_SKILL_TARGETS) {
    out[target.agentId] = displayUserSkillsDir(target, process.env, os.homedir());
  }
  return out;
}

export async function skillInstallsResponse(): Promise<SkillInstallsResponse> {
  return { installs: await listSkillInstalls(), userSkillsDirs: userSkillsDirs() };
}

/**
 * One level per agent, restored, for the agents whose user-level copy this sync just wrote. A
 * user-level add that died after recording its row — before its first write, or after it but
 * before removing the agent's folder installs — leaves both levels recorded, and every sync would
 * keep both up to date. Each such folder install goes the way that add removes it: libi's files
 * (manifest-listed only; an unreadable manifest throws before anything is deleted), then the row.
 * One whose removal throws keeps its row, with the error, for the next run to retry.
 *
 * Only an agent whose user level was written in this same run counts: one whose write failed
 * keeps its folder installs, so a failure never leaves the agent with no level at all.
 */
function reconcileFolderInstalls(userLevelWritten: ReadonlySet<SetupAgentId>): void {
  let agents = 0;
  let removed = 0;
  let failed = 0;
  for (const agentId of userLevelWritten) {
    const folderRows = rowsFor(agentId, "folder");
    if (folderRows.length === 0) continue;
    agents++;
    for (const folderRow of folderRows) {
      try {
        removeInstallNow(folderRow);
        removed++;
      } catch (err) {
        failed++;
        // A refusal has already put its reason on the row.
        if (!(err instanceof SkillInstallError)) {
          getDb().update(skillInstalls).set({ lastError: shortInstallError(err) }).where(eq(skillInstalls.id, folderRow.id)).run();
        }
      }
    }
  }
  if (agents > 0) {
    logger.info({ tag: "skills", op: "folder_installs_reconciled", agents, removed, failed }, "skills.folder_installs_reconciled");
  }
}

async function runSync(reason: string): Promise<void> {
  if (allRows().length === 0) return;
  const skills = await loadEnabledSkills();
  // Rows are read AFTER the load, and everything from here on runs with no await, so an install
  // removed while skills were loading is never written back and nothing runs between the steps:
  // user-level rows are written, then their agents' folder installs reconciled away, then the
  // remaining folder installs written.
  const rows = allRows();
  const counts = { written: 0, failed: 0, missingFolders: 0, missingRoots: 0, levelConflicts: 0 };
  const tally = (outcome: WriteOutcome): void => {
    if (outcome === "written") counts.written++;
    else if (outcome === "failed") counts.failed++;
    else if (outcome === "root-gone") counts.missingRoots++;
    else counts.missingFolders++;
  };
  const userLevelWritten = new Set<SetupAgentId>();
  for (const row of rows) {
    if (row.scope !== "user") continue;
    const outcome = writeRow(row, skills);
    tally(outcome);
    if (outcome === "written") userLevelWritten.add(row.agentId);
  }
  reconcileFolderInstalls(userLevelWritten);
  for (const row of rows) {
    if (row.scope !== "folder") continue;
    if (userLevelWritten.has(row.agentId)) {
      // Still recorded only when its removal failed; it is not written beside its agent's user level.
      if (rowById(row.id)) counts.levelConflicts++;
      continue;
    }
    tally(writeRow(row, skills));
  }
  logger.info({ tag: "skills", op: "installs_sync", reason, rows: rows.length, ...counts }, "skills.installs_sync");
}

let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;

function startSync(reason: string): Promise<void> {
  const run: Promise<void> = runSync(reason)
    .catch((err) => {
      logger.error(
        { err: sanitizeErrForLog(err), tag: "skills", op: "installs_sync_failed", reason },
        "skills.installs_sync_failed",
      );
    })
    .finally(() => {
      if (running === run) running = null;
    });
  running = run;
  return run;
}

/**
 * Rewrite every recorded install from the current skill set. One run at a
 * time; every request made during a run shares exactly one follow-up run, and
 * resolves when that follow-up — the run that saw its change — is done.
 * Never rejects.
 */
export function syncSkillInstalls(reason: string): Promise<void> {
  if (queued) return queued;
  if (!running) return startSync(reason);
  const next: Promise<void> = running.then(() => {
    if (queued === next) queued = null;
    return startSync(reason);
  });
  queued = next;
  return next;
}
