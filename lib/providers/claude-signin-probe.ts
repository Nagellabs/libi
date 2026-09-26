/**
 * Whether Claude Code has signed in to an MCP server the user signs in to with an account (catalog
 * `auth: "oauth"`), asked of Claude Code itself: `claude mcp get <entry>`.
 *
 * Claude keeps MCP OAuth tokens in its own secret store (the macOS keychain item "Claude Code-credentials",
 * `.credentials.json` elsewhere). libi never reads that, and `~/.claude.json` says nothing about a sign-in, so
 * the CLI's own answer is the only one. Measured on claude 2.1.282 against a scratch CLAUDE_CONFIG_DIR:
 *
 *   - a fresh ElevenLabs entry prints `Status: ! Needs authentication`, a signed-in one `Status: ✔ Connected`,
 *     a server that can't be reached `Status: ✘ Failed to connect` (plus an `Issue:` line); all exit 0. An
 *     unknown name prints `No MCP server named …` and exits 1;
 *   - it health-checks the server over the network (1.8 s wall for ElevenLabs here, ~4.8 s seen on the owner's
 *     machine), and writes `mcp-needs-auth-cache.json` into Claude's config folder. That file is Claude's own
 *     cache, not its config: the same class as the `mcp-oauth-locks/` codex makes during `codex mcp list`.
 *
 * THE HAZARD: never while that entry's `mcp login` may be running. Checked in the claude 2.1.282 binary and a
 * scratch config: `mcp get` writes a needs-auth entry to `mcp-needs-auth-cache.json` whenever the server answers
 * 401; `mcp login` removes it only at its end, once the tokens are saved; a later Connected `mcp get` does not
 * remove it; and while it is younger than 15 minutes every Claude Code chat — libi's and the user's own — SKIPS
 * that server ("Skipping connection (cached needs-auth)"). A probe whose 401 lands just after the login saved its
 * tokens therefore hides the provider from every new chat for 15 minutes, while the next probe says Connected.
 * So the setup scripts print a marker line when a Claude sign-in starts and when it ends, success or not
 * (`./sign-in-markers.ts`, read from the setup terminal's output in `lib/terminal/instance.ts`). Between the two
 * nothing asks about that entry, and after the end it is asked exactly once, on its next lookup. A terminal that
 * goes away ends any sign-in it was running. A start never followed by an end stops counting after
 * `CLAUDE_LOGIN_MAX_MS`. A probe already running when a start marker arrives is stopped (its whole process group,
 * as on a timeout) and its answer dropped; a probe queued behind another checks for a running sign-in again right
 * before it would start. A write that already landed came before the login's own clear, so it is harmless; a kill
 * mid-write leaves at worst an unreadable cache file, which Claude reads as empty.
 *
 * Otherwise it is never run in a poll loop. A lookup answers from a memo per (entry, url): a signed-in or
 * needs-sign-in answer stands `CLAUDE_SIGNIN_MEMO_MS`, one that could not be read `CLAUDE_SIGNIN_UNKNOWN_MEMO_MS`.
 * With no answer yet it starts ONE probe and says `pending`, and the caller asks again later. An answer due to be
 * asked again — expired, a setup terminal went away (`__clearClaudeSignInMemo`, from `__clearProviderMemo`), or
 * its sign-in ended — is SERVED while the probe runs, never replaced by `pending`: a row that read signed in must
 * not read "sign in" for the seconds a probe takes. When the user looks (the Providers tab opens or comes back
 * into view) or presses Retry, an answer that is not "signed in" and older than
 * `CLAUDE_SIGNIN_REVALIDATE_AFTER_MS` is asked again (`revalidate`): they may have signed in through their own
 * Claude Code.
 *
 * Only the `Status:` line is read, defensively: Connected → signed in; Needs authentication → not signed in;
 * anything else, a `URL:` line naming a different server, a non-zero exit or a timeout → unknown, which the tab
 * shows as it always has. The probe runs the claude `resolveAgentCli` resolved, the way it ran that binary's
 * `--version`, in libi's agent folder (where a local- or project-scope entry resolves, as in the setup terminal),
 * with the server's environment minus a host Claude Code session's markers — so a CLAUDE_CONFIG_DIR the user set
 * is honoured exactly as the setup terminal's `mcp add` honoured it. It is bounded at `CLAUDE_SIGNIN_PROBE_TIMEOUT_MS`,
 * and off Windows its whole process group is killed on timeout (`lib/agents/cli/process-group.ts`).
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { serverLogger as logger } from "@/lib/logger";
import { getLibiAgentDir } from "@/lib/libi-home";
import { stripHostSessionEnv } from "@/lib/agents/child-env";
import { isUsableCli, resolveAgentCli } from "@/lib/agents/cli/resolve";
import { spawnViaNodeIfScript } from "@/lib/agents/cli/spawn-shape";
import { endGroup, killGroup, releaseStdout, watchExit } from "@/lib/agents/cli/process-group";

/** How long an answer stands, unless a setup terminal goes away or a sign-in for its entry ends first. */
export const CLAUDE_SIGNIN_MEMO_MS = 10 * 60_000;
/** A probe that failed, timed out or printed something unreadable is tried again this soon. */
export const CLAUDE_SIGNIN_UNKNOWN_MEMO_MS = 60_000;
/** On a look or Retry (`revalidate`), an answer that is not "signed in" and at least this old is asked again. */
export const CLAUDE_SIGNIN_REVALIDATE_AFTER_MS = 30_000;
/** A login announced as started but never as ended (its terminal still open) stops holding probes back after this. */
export const CLAUDE_LOGIN_MAX_MS = 15 * 60_000;
/** One `claude mcp get`, whatever the server it health-checks does. */
export const CLAUDE_SIGNIN_PROBE_TIMEOUT_MS = 10_000;
/** After `exit`, how long stdout may take to close before what was printed is read anyway. */
const EXIT_TO_CLOSE_MS = 500;
/** `mcp get` prints a few lines; anything past this is not read. */
const STDOUT_CAP = 64 * 1024;

export type ClaudeSignIn = "signed-in" | "needs-sign-in" | "unknown";
export type ClaudeSignInLookup = ClaudeSignIn | "pending";

export interface ClaudeSignInEntry {
  name: string;
  url: string;
}

/** Runs `claude mcp get -- <name>` and answers its exit status and stdout. Injected in tests. */
export type ClaudeMcpGet = (name: string, signal: AbortSignal) => Promise<{ ok: boolean; stdout: string }>;

/**
 * Reads `claude mcp get`'s output. Pure. The status marks (✔ ! ✘) and any other leading symbols are ignored, and
 * the words are compared case-insensitively; a `URL:` line that names another server is no answer for this entry.
 */
export function parseClaudeMcpGet(stdout: string, url: string): ClaudeSignIn {
  const urlLine = /^[ \t]*URL:[ \t]*(\S+)[ \t]*$/m.exec(stdout);
  if (urlLine && urlLine[1] !== url) return "unknown";
  const statusLine = /^[ \t]*Status:[ \t]*(.+?)[ \t]*$/m.exec(stdout);
  if (!statusLine) return "unknown";
  const words = statusLine[1].replace(/^[^\p{L}]+/u, "").toLowerCase();
  if (words === "connected") return "signed-in";
  if (words.startsWith("needs authentication")) return "needs-sign-in";
  return "unknown";
}

interface Probe {
  /** The invalidation count when it started: an answer from before a later invalidation of its entry is dropped. */
  seq: number;
  done: Promise<void>;
  /** Stops its `claude mcp get` (process group and all), or keeps a queued one from ever starting. */
  abort: AbortController;
  name: string;
}

interface State {
  /** Bumped by every invalidation; a probe and an answer carry the value it had when the probe started. */
  counter: number;
  /** Everything from before this count is stale (a setup terminal went away). */
  allEpoch: number;
  /** Per entry name: what is from before this count is stale (a sign-in for it ended). */
  nameEpoch: Map<string, number>;
  memo: Map<string, { at: number; value: ClaudeSignIn; seq: number; name: string }>;
  running: Map<string, Probe>;
  /** Every probe not yet ended, including one a newer probe for its entry has replaced in `running`. */
  live: Set<Probe>;
  /** Entry name → the setup terminal whose `mcp login` for it may be running, and since when. */
  logins: Map<string, { terminalId: string; since: number }>;
}

const g = globalThis as unknown as { __libiClaudeSignInProbe?: State };

function state(): State {
  g.__libiClaudeSignInProbe ??= { counter: 0, allEpoch: 0, nameEpoch: new Map(), memo: new Map(), running: new Map(), live: new Set(), logins: new Map() };
  return g.__libiClaudeSignInProbe;
}

const keyOf = (entry: ClaudeSignInEntry) => `${entry.name}\n${entry.url}`;

function current(s: State, seq: number, name: string): boolean {
  return seq >= s.allEpoch && seq >= (s.nameEpoch.get(name) ?? 0);
}

function invalidateName(s: State, name: string): void {
  s.counter++;
  s.nameEpoch.set(name, s.counter);
}

/**
 * A setup terminal went away: whatever ran in it may have changed a sign-in, so every answer is asked again on its
 * next lookup — and served meanwhile, never dropped: a row that read signed in must not read "sign in" again for
 * the seconds a probe takes. A probe still running finishes, and its answer is not kept.
 */
export function __clearClaudeSignInMemo(): void {
  const s = state();
  s.counter++;
  s.allEpoch = s.counter;
}

/** Forget the answers for entries that are no longer in Claude Code's config (removed, or renamed). */
export function retainClaudeSignIn(entries: readonly ClaudeSignInEntry[]): void {
  const s = state();
  const keep = new Set(entries.map(keyOf));
  for (const key of s.memo.keys()) if (!keep.has(key)) s.memo.delete(key);
}

/**
 * A setup script announced that Claude Code's `mcp login` for `name` is about to run in terminal `terminalId`
 * (`./sign-in-markers.ts`). Until it ends, nothing asks Claude Code about that entry: see the header.
 */
export function noteClaudeLoginStarted(name: string, terminalId: string, now: () => number = Date.now): void {
  const s = state();
  s.logins.set(name, { terminalId, since: now() });
  // A probe already under way for the entry read the token store before this sign-in: its 401 could land after
  // the login cleared Claude's needs-auth entry. Stop it, and drop whatever it would have answered.
  invalidateName(s, name);
  for (const probe of s.live) {
    if (probe.name === name) probe.abort.abort();
  }
}

/** That `mcp login` ended, however it ended: the entry is asked about exactly once more, on its next lookup. */
export function noteClaudeLoginEnded(name: string): void {
  const s = state();
  s.logins.delete(name);
  invalidateName(s, name);
}

/** Terminal `terminalId` went away: any `mcp login` it was running has ended with it. */
export function endClaudeLoginsOf(terminalId: string): void {
  const s = state();
  for (const [name, login] of [...s.logins]) {
    if (login.terminalId !== terminalId) continue;
    s.logins.delete(name);
    invalidateName(s, name);
  }
}

function loginRunning(s: State, name: string, now: number): boolean {
  const login = s.logins.get(name);
  if (!login) return false;
  if (now - login.since < CLAUDE_LOGIN_MAX_MS) return true;
  s.logins.delete(name);
  invalidateName(s, name);
  return false;
}

/** Tests only. */
export function __resetClaudeSignInProbe(): void {
  g.__libiClaudeSignInProbe = undefined;
}

export interface LookupOpts {
  /**
   * The user just looked (the Providers tab opened or came back into view) or pressed Retry: an answer that is
   * not "signed in" and is older than `CLAUDE_SIGNIN_REVALIDATE_AFTER_MS` is asked again, and served meanwhile.
   * They may have signed in through their own Claude Code.
   */
  revalidate?: boolean;
  now?: () => number;
  /** Injected in tests. Default: `claude mcp get` through the resolved claude. */
  mcpGet?: ClaudeMcpGet;
}

/**
 * The last answer for an entry — even one being asked again — or `pending` while the first probe for an entry
 * never answered runs. Never waits on a probe, never runs two for one entry (a probe asked for while an older one
 * still runs starts when that one ends), and never runs one while the entry's `mcp login` may be running: then the
 * last answer stands, or `unknown` when there is none.
 */
export function lookupClaudeSignIn(entry: ClaudeSignInEntry, opts: LookupOpts = {}): ClaudeSignInLookup {
  const s = state();
  const now = opts.now ?? Date.now;
  const at = now();
  const key = keyOf(entry);
  const known = s.memo.get(key);
  if (loginRunning(s, entry.name, at)) return known?.value ?? "unknown";
  const age = known ? at - known.at : Infinity;
  const ttl = known?.value === "unknown" ? CLAUDE_SIGNIN_UNKNOWN_MEMO_MS : CLAUDE_SIGNIN_MEMO_MS;
  const ask =
    !known ||
    !current(s, known.seq, entry.name) ||
    age >= ttl ||
    (opts.revalidate === true && known.value !== "signed-in" && age >= CLAUDE_SIGNIN_REVALIDATE_AFTER_MS);
  if (ask) {
    const running = s.running.get(key);
    if (!running || !current(s, running.seq, entry.name)) startProbe(s, entry, key, running, opts.mcpGet ?? defaultMcpGet, now);
  }
  return known?.value ?? "pending";
}

function startProbe(
  s: State,
  entry: ClaudeSignInEntry,
  key: string,
  before: Probe | undefined,
  mcpGet: ClaudeMcpGet,
  now: () => number,
): void {
  const seq = s.counter;
  const startedAt = now();
  const abort = new AbortController();
  const call = (): Promise<{ ok: boolean; stdout: string }> => {
    // Queued behind an older probe: the entry's sign-in may have started while it waited.
    if (abort.signal.aborted || loginRunning(s, entry.name, now())) return Promise.resolve({ ok: false, stdout: "" });
    try {
      return mcpGet(entry.name, abort.signal);
    } catch (err) {
      return Promise.reject(err);
    }
  };
  // Spawned now when nothing runs for the entry; otherwise once the earlier probe has ended.
  const done = (before ? before.done.then(call) : call())
    .catch(() => ({ ok: false, stdout: "" }))
    .then((res) => {
      if (abort.signal.aborted) return;
      const value: ClaudeSignIn = res.ok ? parseClaudeMcpGet(res.stdout, entry.url) : "unknown";
      logger.info(
        { tag: "providers", op: "claude_signin_probe", entry: entry.name, result: value, exitOk: res.ok, ms: now() - startedAt },
        "asked Claude Code whether an MCP server is signed in",
      );
      if (state() === s && current(s, seq, entry.name)) s.memo.set(key, { at: now(), value, seq, name: entry.name });
    })
    .finally(() => {
      s.live.delete(probe);
      if (s.running.get(key) === probe) s.running.delete(key);
    });
  const probe: Probe = { seq, done, abort, name: entry.name };
  s.running.set(key, probe);
  s.live.add(probe);
}

const defaultMcpGet: ClaudeMcpGet = async (name, signal) => {
  const cli = await resolveAgentCli("claude-code");
  if (!isUsableCli(cli) || signal.aborted) return { ok: false, stdout: "" };
  const shape = spawnViaNodeIfScript(cli.execPath);
  return runClaudeMcpGet({ command: shape.command, args: [...shape.args, "mcp", "get", "--", name] }, { signal });
};

export interface RunDeps {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  cwd?: string;
  timeoutMs?: number;
  /** Aborting it answers "no answer" at once and ends the CLI's process group, as a timeout does. */
  signal?: AbortSignal;
}

/**
 * One bounded `claude mcp get`. The caller has an answer no later than the timeout after the spawn; off Windows
 * the CLI leads its own process group, so the kill reaches whatever it started too. Never throws.
 */
export function runClaudeMcpGet(cmd: { command: string; args: string[] }, deps: RunDeps = {}): Promise<{ ok: boolean; stdout: string }> {
  const spawn = deps.spawn ?? nodeSpawn;
  const platform = deps.platform ?? process.platform;
  const timeoutMs = deps.timeoutMs ?? CLAUDE_SIGNIN_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (deps.signal?.aborted) {
      resolve({ ok: false, stdout: "" });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(cmd.command, cmd.args, {
        cwd: deps.cwd ?? getLibiAgentDir(),
        env: stripHostSessionEnv({ ...process.env }),
        stdio: ["ignore", "pipe", "ignore"],
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, stdout: "" });
      return;
    }
    const watch = watchExit(child);
    let stdout = "";
    let settled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      resolve({ ok, stdout });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settle(false);
      releaseStdout(child);
      void killGroup(child, watch, platform).then((exitedInTime) => {
        logger.warn(
          { tag: "providers", op: "claude_signin_probe_timeout", timeoutMs, notExitedAfterKill: exitedInTime ? 0 : 1 },
          "claude mcp get timed out; its process group was killed",
        );
      });
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < STDOUT_CAP) stdout += chunk.toString("utf8");
    });
    child.on("close", (code: number | null) => settle(code === 0));
    // Something the CLI started may hold stdout open after it exits: read what it printed, then end the group.
    child.on("exit", (code: number | null) => {
      closeTimer = setTimeout(() => {
        if (settled) return;
        settle(code === 0);
        releaseStdout(child);
        void endGroup(child, watch, 0, platform);
      }, EXIT_TO_CLOSE_MS);
      closeTimer.unref();
    });
    child.on("error", () => settle(false));
    deps.signal?.addEventListener(
      "abort",
      () => {
        if (settled) return;
        settle(false);
        releaseStdout(child);
        void killGroup(child, watch, platform).then((exitedInTime) => {
          logger.info(
            { tag: "providers", op: "claude_signin_probe_stopped", notExitedAfterKill: exitedInTime ? 0 : 1 },
            "a sign-in started, so the claude mcp get already running for it was stopped",
          );
        });
      },
      { once: true },
    );
  });
}
