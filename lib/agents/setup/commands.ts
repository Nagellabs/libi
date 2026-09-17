/**
 * Every command libi PRINTS for the user to submit on the Agents page: install,
 * sign-in, connecting libi's tools, and adding / replacing / removing / signing
 * in to a provider. Pure: inputs are the agent, the shell flavor, the resolved CLI
 * realpath, the endpoint URL, a catalog def and the setup scripts folder. libi
 * runs none of these — they are typed into a setup terminal and the user
 * presses Enter.
 *
 * EVERY emitted argument goes through `quoteForShell` for the flavor, not only
 * the CLI path. On zsh a bare `http://…/mcp?agent=codex` is a glob and fails
 * with `no matches found`, so quoting the path alone is not enough.
 *
 * A provider command is one short call to a script libi ships in
 * `lib/agents/setup/scripts/`. The script reads the key at a hidden prompt in
 * its own process, so the key is never in the typed line, never in scrollback,
 * never in history, and never left set in the user's shell.
 *
 * An agent id or shell flavor outside the known two throws instead of falling
 * through to the Codex or posix branch.
 */
import { quoteForShell, type ShellFlavor } from "@/lib/terminal/shell-quote";
import { KEY_PLACEHOLDER, type ProviderDef } from "@/lib/providers/catalog";

export type SetupAgentId = "claude-code" | "codex";
export type LibiScope = "user" | "local";
/** The config scopes a Claude MCP entry can be detected in. */
export type ClaudeMcpScope = "user" | "local" | "project";
export interface SetupCli {
  agentId: SetupAgentId;
  /** The resolved absolute path of the user's CLI — never a bare name. */
  realPath: string;
}

/**
 * A provider entry as detection found it. A Claude entry carries the scope it
 * was read from — `claude mcp remove` refuses a name that lives in another
 * scope — so the type makes the caller pass it; there is no default. Codex has
 * no scopes.
 */
export type DetectedProviderEntry =
  | { agentId: "claude-code"; name: string; scope: ClaudeMcpScope }
  | { agentId: "codex"; name: string };

const LIBI_ENTRY = "libi";
const CLAUDE_MCP_SCOPES: readonly string[] = ["user", "local", "project"];
/** A PTY line editor acts on these (`\x15` kills the line, `\r` submits it). */
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

function isClaude(agentId: SetupAgentId): boolean {
  if (agentId === "claude-code") return true;
  if (agentId === "codex") return false;
  throw new Error(`unknown agent id: ${JSON.stringify(agentId)}`);
}

function isPowerShell(flavor: ShellFlavor): boolean {
  if (flavor === "powershell") return true;
  if (flavor === "posix") return false;
  throw new Error(`unknown shell flavor: ${JSON.stringify(flavor)}`);
}

export function libiEndpointUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** The quoted CLI path, plus PowerShell's call operator so a quoted path runs as a command. */
export function cliInvocation(realPath: string, flavor: ShellFlavor): string {
  const powershell = isPowerShell(flavor);
  const quoted = quoteForShell(realPath, flavor);
  return powershell ? `& ${quoted}` : quoted;
}

function q(arg: string, flavor: ShellFlavor): string {
  return quoteForShell(arg, flavor);
}

/** `<cli> <args…>` with every arg quoted for the flavor. */
function invoke(cli: SetupCli, flavor: ShellFlavor, args: string[]): string {
  return [cliInvocation(cli.realPath, flavor), ...args.map((a) => q(a, flavor))].join(" ");
}

/**
 * Run ALL of `second` only when `first` succeeded. On posix `&&` binds tighter
 * than `;`, so a bare `first && a; b; c` would gate only `a`. The braces group
 * every `;`-separated part of `second`.
 */
export function chainCommands(flavor: ShellFlavor, first: string, second: string): string {
  return isPowerShell(flavor) ? `${first}; if ($?) { ${second} }` : `${first} && { ${second}; }`;
}

export function installCommand(agentId: SetupAgentId, flavor: ShellFlavor): string {
  const claude = isClaude(agentId);
  const powershell = isPowerShell(flavor);
  if (claude) {
    return powershell ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";
  }
  return powershell
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
    : "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
}

/**
 * Below the minimum version: Claude's own updater when that subcommand is known
 * to exist, else the installer. Codex always updates by re-running its installer.
 */
export function updateCommand(cli: SetupCli, flavor: ShellFlavor, opts: { claudeUpdateExists: boolean }): string {
  if (isClaude(cli.agentId) && opts.claudeUpdateExists) return invoke(cli, flavor, ["update"]);
  return installCommand(cli.agentId, flavor);
}

export function signInCommand(cli: SetupCli, flavor: ShellFlavor): string {
  return isClaude(cli.agentId) ? invoke(cli, flavor, []) : invoke(cli, flavor, ["login"]);
}

export function connectLibiCommand(cli: SetupCli, flavor: ShellFlavor, endpointUrl: string): string {
  return isClaude(cli.agentId)
    ? invoke(cli, flavor, ["mcp", "add", "--scope", "user", "--transport", "http", LIBI_ENTRY, endpointUrl])
    : invoke(cli, flavor, ["mcp", "add", LIBI_ENTRY, "--url", `${endpointUrl}?agent=codex`]);
}

/**
 * Claude: the scope the entry was DETECTED in — a fixed `--scope user` would
 * miss an entry registered locally. Codex has no scopes; its entries are user-wide.
 */
export function disconnectLibiCommand(cli: SetupCli, flavor: ShellFlavor, scope: LibiScope): string {
  return isClaude(cli.agentId)
    ? invoke(cli, flavor, ["mcp", "remove", "--scope", scope, LIBI_ENTRY])
    : invoke(cli, flavor, ["mcp", "remove", LIBI_ENTRY]);
}

export function reconnectLibiCommand(cli: SetupCli, flavor: ShellFlavor, endpointUrl: string, scope: LibiScope): string {
  return chainCommands(flavor, disconnectLibiCommand(cli, flavor, scope), connectLibiCommand(cli, flavor, endpointUrl));
}

/** The provider actions, each run by one script libi ships. */
export type ProviderScriptAction = "provider-add" | "provider-remove" | "provider-replace" | "provider-sign-in";

const PROVIDER_SCRIPT: Record<ProviderScriptAction, string> = {
  "provider-add": "add-provider",
  "provider-remove": "remove-provider",
  "provider-replace": "replace-provider",
  "provider-sign-in": "signin-provider",
};

/**
 * Every script file a provider command can run, POSIX and PowerShell. It is also
 * the exact allowlist `GET /api/agents/setup-scripts/[name]` serves.
 */
export const SETUP_SCRIPT_NAMES: readonly string[] = Object.values(PROVIDER_SCRIPT).flatMap((base) => [
  `${base}.sh`,
  `${base}.ps1`,
]);

function scriptFileName(action: ProviderScriptAction, flavor: ShellFlavor): string {
  return `${PROVIDER_SCRIPT[action]}.${isPowerShell(flavor) ? "ps1" : "sh"}`;
}

/** The script files an action's command runs, in order: a replace's script runs the add script after its remove. */
export function providerScriptNames(action: ProviderScriptAction, flavor: ShellFlavor): string[] {
  const names = [scriptFileName(action, flavor)];
  if (action === "provider-replace") names.push(scriptFileName("provider-add", flavor));
  return names;
}

/** Where the Agents page opens a setup script's text for the user to read. */
export function setupScriptUrl(name: string): string {
  return `/api/agents/setup-scripts/${encodeURIComponent(name)}`;
}

/** The scripts folder the server reported, without a trailing separator. Anything but a plain absolute path throws. */
function scriptsFolder(scriptsDir: string, flavor: ShellFlavor): string {
  const absolute = isPowerShell(flavor) ? /^(?:[A-Za-z]:[\\/]|\\\\)/ : /^\//;
  if (!absolute.test(scriptsDir) || CONTROL_CHARACTER.test(scriptsDir)) {
    throw new Error(`refusing to build a command for a setup scripts folder that is not a plain absolute path: ${JSON.stringify(scriptsDir)}`);
  }
  return scriptsDir.replace(/[\\/]+$/, "");
}

/**
 * The characters PowerShell reads specially inside a double-quoted string: the
 * backtick escape, `$`, and every double quote its tokenizer knows (ASCII `"`
 * and the typographic U+201C, U+201D, U+201E).
 */
const POWERSHELL_DOUBLE_QUOTED_SPECIAL = /[`$"\u201C\u201D\u201E]/g;

/**
 * posix: `sh <script> <args…>`. The script runs in its own non-interactive
 * `sh`, where the user's aliases, shell functions and zsh global aliases never
 * apply. A command that reads or writes login profiles passes the shell's own
 * ZDOTDIR in front: zsh keeps a ZDOTDIR set without `export` to itself, and the
 * script would look in the wrong folder. `${ZDOTDIR-}`, so a shell running with
 * `nounset` still runs the line.
 *
 * PowerShell runs the script's TEXT, not the file, in a child `powershell`:
 *
 *   powershell -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('<script>'))) '<arg>' …"
 *
 * An execution policy governs script files only, and one set by Group Policy
 * outranks `-ExecutionPolicy Bypass`, so a managed machine refuses `-File`. The
 * child process keeps the script's `exit` from closing the setup terminal and
 * its variables out of it, has the console for the hidden key prompt, and exits
 * with the code the script passes to `exit`. A scriptblock has no folder of its
 * own, so the replace script is told where add-provider.ps1 is (`-ScriptsDir`).
 *
 * Two parsers read that line. The setup terminal's PowerShell reads the
 * `-Command` argument as a double-quoted string, so a backtick, `$` and any
 * double quote in it get a backtick. The child reads the result, where every
 * argument is single-quoted. The argument must hold no ASCII double quote at
 * all: Windows PowerShell 5.1 hands one to a native program unescaped, which
 * splits the argument. A word containing one is refused.
 */
function scriptCommand(
  flavor: ShellFlavor,
  scriptsDir: string,
  action: ProviderScriptAction,
  args: string[],
  opts: { passZdotdir: boolean },
): string {
  const powershell = isPowerShell(flavor);
  const folder = scriptsFolder(scriptsDir, flavor);
  const script = `${folder}${powershell ? "\\" : "/"}${scriptFileName(action, flavor)}`;
  if (!powershell) {
    const words = [script, ...args].map((a) => q(a, flavor)).join(" ");
    return opts.passZdotdir ? `ZDOTDIR="\${ZDOTDIR-}" sh ${words}` : `sh ${words}`;
  }
  const doubleQuoted = [script, ...args].find((word) => word.includes('"'));
  if (doubleQuoted !== undefined) {
    throw new Error(`refusing to build a PowerShell command for an argument containing a double quote: ${JSON.stringify(doubleQuoted)}`);
  }
  const words = args.map((a) => q(a, flavor));
  if (action === "provider-replace") words.push("-ScriptsDir", q(folder, flavor));
  const payload = `& ([scriptblock]::Create([IO.File]::ReadAllText(${q(script, flavor)}))) ${words.join(" ")}`;
  return `powershell -NoProfile -Command "${payload.replace(POWERSHELL_DOUBLE_QUOTED_SPECIAL, (c) => `\`${c}`)}"`;
}

/** How the scripts name an agent. */
function scriptAgent(agentId: SetupAgentId): "claude" | "codex" {
  return isClaude(agentId) ? "claude" : "codex";
}

function catalogCommandFor(cli: SetupCli, def: ProviderDef): string | undefined {
  return def.commands?.[isClaude(cli.agentId) ? "claude" : "codex"];
}

/**
 * Codex reads this provider's key from its environment (`codexKeyEnv`), so on
 * posix its add, replace and remove read or write the user's login profiles.
 */
function readsLoginProfiles(cli: SetupCli, flavor: ShellFlavor, def: ProviderDef): boolean {
  return !isPowerShell(flavor) && !isClaude(cli.agentId) && Boolean(def.codexKeyEnv);
}

/**
 * `add-provider <provider> <agent> <cli>`. The script asks for the key at a
 * hidden prompt and runs the agent's own `mcp add` with it. For a Codex provider
 * with `codexKeyEnv` it first saves the key under that name: in the login profile
 * the user's shell reads on posix, in the Windows user environment on
 * PowerShell. `null` for a provider the catalog lists with a docs link only.
 */
export function providerAddCommand(cli: SetupCli, flavor: ShellFlavor, def: ProviderDef, scriptsDir: string): string | null {
  isPowerShell(flavor);
  if (!catalogCommandFor(cli, def)) return null;
  return scriptCommand(flavor, scriptsDir, "provider-add", [def.id, scriptAgent(cli.agentId), cli.realPath], {
    passZdotdir: readsLoginProfiles(cli, flavor, def),
  });
}

/**
 * The detected entry's name, and for Claude the scope it was detected in, after validating the entry against the CLI.
 * A name that starts with `-` is passed as it is: every script hands it to the agent's CLI after `--`, which both
 * CLIs honour for `mcp remove`, `mcp logout` and `mcp login` (claude 2.1.245, codex 0.153.4), and which they
 * need — without it, claude reads `-x` as an unknown option and codex as an unexpected argument.
 */
function entryArgs(cli: SetupCli, entry: DetectedProviderEntry): string[] {
  isClaude(cli.agentId);
  if (entry.agentId !== cli.agentId) {
    throw new Error(`provider entry detected for ${JSON.stringify(entry.agentId)} does not match the ${cli.agentId} CLI`);
  }
  if (CONTROL_CHARACTER.test(entry.name)) {
    throw new Error(`refusing to build a command for an MCP server name containing a control character: ${JSON.stringify(entry.name)}`);
  }
  if (entry.agentId === "codex") return [entry.name];
  if (!CLAUDE_MCP_SCOPES.includes(entry.scope)) {
    throw new Error(`a Claude provider entry needs the scope it was detected in, got ${JSON.stringify(entry.scope)}`);
  }
  return [entry.name, entry.scope];
}

/**
 * `remove-provider <provider> <agent> <cli> <entry> [<scope>]`. Claude: the scope
 * the entry was detected in. Codex: no scope; for a provider whose key libi saved
 * to the environment (`codexKeyEnv`) the script also removes that saved key, after
 * the remove succeeds. For a provider the user signs in to with an account
 * (`auth: "oauth"`) the script first runs the agent's own `mcp logout` for the
 * entry, so the sign-in the agent stored is not left behind. It runs BEFORE the
 * remove because both agents look that sign-in up through the entry, and exit 1
 * with "No MCP server named …" once it is gone; with nothing stored it exits 0,
 * and a failed sign-out never stops the remove. `null` for a docs-only provider — the scripts know only
 * providers with commands — once the entry itself has been validated.
 */
export function providerRemoveCommand(
  cli: SetupCli,
  flavor: ShellFlavor,
  entry: DetectedProviderEntry,
  def: ProviderDef,
  scriptsDir: string,
): string | null {
  isPowerShell(flavor);
  const target = entryArgs(cli, entry);
  if (!catalogCommandFor(cli, def)) return null;
  return scriptCommand(flavor, scriptsDir, "provider-remove", [def.id, scriptAgent(cli.agentId), cli.realPath, ...target], {
    passZdotdir: readsLoginProfiles(cli, flavor, def),
  });
}

/**
 * `replace-provider <provider> <agent> <cli> <entry> [<scope>]`: the script
 * removes the detected entry and, only if that succeeded, runs the add script.
 * Its remove keeps a key libi saved for Codex, which the add then replaces. One
 * script call rather than two chained ones keeps the typed line short.
 */
export function providerReplaceCommand(
  cli: SetupCli,
  flavor: ShellFlavor,
  def: ProviderDef,
  entry: DetectedProviderEntry,
  scriptsDir: string,
): string | null {
  isPowerShell(flavor);
  const target = entryArgs(cli, entry);
  if (!catalogCommandFor(cli, def)) return null;
  return scriptCommand(flavor, scriptsDir, "provider-replace", [def.id, scriptAgent(cli.agentId), cli.realPath, ...target], {
    passZdotdir: readsLoginProfiles(cli, flavor, def),
  });
}

/**
 * `signin-provider <provider> <agent> <cli> <entry>`: the agent's own `mcp login`
 * for the detected entry, which opens the user's browser and waits until they
 * have signed in. Only for a provider the user signs in to with an account
 * (`auth: "oauth"`); `null` for any other, once the entry has been validated.
 * No scope: `mcp login` takes only a name, and the setup terminal runs in libi's
 * agent folder, where a local- or project-scope Claude entry resolves.
 */
export function providerSignInCommand(
  cli: SetupCli,
  flavor: ShellFlavor,
  entry: DetectedProviderEntry,
  def: ProviderDef,
  scriptsDir: string,
): string | null {
  isPowerShell(flavor);
  const [name] = entryArgs(cli, entry);
  const agent = scriptAgent(cli.agentId);
  if (def.auth !== "oauth" || !def.signInCommands?.[agent]) return null;
  return scriptCommand(flavor, scriptsDir, "provider-sign-in", [def.id, agent, cli.realPath, name], { passZdotdir: false });
}

/**
 * A last check before printing that detects exactly two things: the literal
 * `<your key>` placeholder left unreplaced, and `Bearer` followed by a literal
 * token of 8+ `[A-Za-z0-9._-]` characters rather than a `$libi_key` reference.
 * It looks nowhere else — a literal key in an env pair such as `NAME=value`
 * passes — so it guards this builder's output, where no key ever appears: a
 * provider command only names a script, and the script reads the key itself.
 */
export function commandCarriesNoKeyMaterial(command: string): boolean {
  return !command.includes(KEY_PLACEHOLDER) && !/Bearer\s+(?!\$\{?libi_key\b)[A-Za-z0-9._-]{8,}/.test(command);
}
