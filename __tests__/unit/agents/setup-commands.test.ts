import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chainCommands, cliInvocation, commandCarriesNoKeyMaterial, connectLibiCommand, disconnectLibiCommand,
  installCommand, libiEndpointUrl, providerAddCommand, providerRemoveCommand, providerReplaceCommand,
  providerScriptNames, providerSignInCommand, reconnectLibiCommand, SETUP_SCRIPT_NAMES, setupScriptUrl, signInCommand, updateCommand,
  type DetectedProviderEntry, type SetupAgentId,
} from "@/lib/agents/setup/commands";
import { setupScriptsDir } from "@/lib/agents/setup/scripts-dir";
import { PROVIDER_CATALOG, KEY_PLACEHOLDER, findProvider } from "@/lib/providers/catalog";
import type { ShellFlavor } from "@/lib/terminal/shell-quote";

const claude = { agentId: "claude-code" as const, realPath: "/Users/me/.local/bin/claude" };
const codex = { agentId: "codex" as const, realPath: "/Users/me/.local/bin/codex" };
const claudeSpace = { agentId: "claude-code" as const, realPath: "/Users/me/My Tools/claude" };
const claudeWin = { agentId: "claude-code" as const, realPath: "C:\\Users\\me\\.local\\bin\\claude.exe" };
const codexWin = { agentId: "codex" as const, realPath: "C:\\Users\\me\\.local\\bin\\codex.exe" };
const ENDPOINT = libiEndpointUrl(3457); // not `URL` — that would shadow the global
const claudeFalUser = { agentId: "claude-code", name: "fal-ai", scope: "user" } as const;
const fal = findProvider("fal");
const elevenlabs = findProvider("elevenlabs");
const higgsfield = findProvider("higgsfield");
/** Where a builder test says the scripts are; the tests that RUN scripts use the real folder. */
const SCRIPTS = "/opt/libi/lib/agents/setup/scripts";
const SCRIPTS_WIN = "C:\\Program Files\\libi\\lib\\agents\\setup\\scripts";
/** The real scripts folder of this checkout, resolved the way the server resolves it. */
const SCRIPTS_DIR = setupScriptsDir();
const scriptPath = (name: string) => path.join(SCRIPTS_DIR, name);
const scriptText = (name: string) => readFileSync(scriptPath(name), "utf8");
const POSIX_SCRIPTS = SETUP_SCRIPT_NAMES.filter((name) => name.endsWith(".sh"));
/** The catalog providers the Providers tab can add: the ones with commands. */
const WITH_COMMANDS = PROVIDER_CATALOG.filter((def) => def.commands);
/** The providers the user signs in to with an account: the ones signin-provider knows. */
const OAUTH = PROVIDER_CATALOG.filter((def) => def.auth === "oauth");
/** A provider the catalog could list with a docs link only: no commands of any kind. */
const DOCS_ONLY = { ...findProvider("higgsfield"), commands: undefined, signInCommands: undefined };
/** Every POSIX sh these scripts must run under: the system `sh`, and dash (`sh` on Debian and Ubuntu) where it exists. */
const SCRIPT_SHELLS = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));

/**
 * An external tool in command position that is not behind `command`, with or without an environment prefix such as
 * `LC_ALL=C`. An exported shell function or alias of that name must never run in its place (`alias cat="cat -n"`
 * numbers every line).
 */
const BARE_EXTERNAL_TOOL = /(?:^|[;&|({]|\$\(|\bif|\bthen|\bdo|\belse|\belif)\s*(?:\w+=[^\s$()]*\s+)*(?:cat|sed|grep|tail|wc|tr|touch|rm|mv|cp|od|head|awk|ls|stty|printenv|uname)\b/;
/**
 * `sed`/`grep`/`tail`/`wc`/`tr` scan the profile or its temp copy, which can hold bytes that
 * are not valid UTF-8 — under a UTF-8 locale BSD `sed` refuses such a file outright. Every one
 * of those five must run as `LC_ALL=C command <tool>`, not merely `command <tool>`.
 */
const SCANS_PROFILE_WITHOUT_BYTE_LOCALE = /(?<!LC_ALL=C )\bcommand (?:sed|grep|tail|wc|tr)\b/;

/** Splits a catalog command on spaces, honouring double and single quotes. */
function tokenizeCatalogCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " ") {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The code of a script, without comment lines. */
const codeLines = (text: string) => text.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("cliInvocation", () => {
  it("leaves a tame posix path bare, quotes one with a space", () => {
    expect(cliInvocation(claude.realPath, "posix")).toBe("/Users/me/.local/bin/claude");
    expect(cliInvocation(claudeSpace.realPath, "posix")).toBe("'/Users/me/My Tools/claude'");
  });
  it("always quotes and prefixes the call operator on powershell", () => {
    expect(cliInvocation(claudeWin.realPath, "powershell")).toBe("& 'C:\\Users\\me\\.local\\bin\\claude.exe'");
  });
  it("a typographic apostrophe in a Windows path cannot close PowerShell's single-quoted string", () => {
    expect(cliInvocation("C:\\Users\\O’Neil\\.local\\bin\\codex.exe", "powershell")).toBe(
      "& 'C:\\Users\\O’’Neil\\.local\\bin\\codex.exe'",
    );
  });
});

describe("install / update / sign in", () => {
  it("install commands are the official one-liners", () => {
    expect(installCommand("claude-code", "posix")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(installCommand("claude-code", "powershell")).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(installCommand("codex", "posix")).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
    expect(installCommand("codex", "powershell")).toBe(
      'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    );
  });
  it("update: Claude uses `claude update` only when that subcommand exists, else the installer; Codex always the installer", () => {
    expect(updateCommand(claude, "posix", { claudeUpdateExists: true })).toBe("/Users/me/.local/bin/claude update");
    expect(updateCommand(claude, "posix", { claudeUpdateExists: false })).toBe(installCommand("claude-code", "posix"));
    expect(updateCommand(codex, "posix", { claudeUpdateExists: true })).toBe(installCommand("codex", "posix"));
  });
  it("sign in runs the CLI (Claude) or `login` (Codex), through the absolute path", () => {
    expect(signInCommand(claude, "posix")).toBe("/Users/me/.local/bin/claude");
    expect(signInCommand(codex, "posix")).toBe("/Users/me/.local/bin/codex login");
    // Every argument is quoted, and quoteForShell always quotes on PowerShell.
    expect(signInCommand(codexWin, "powershell")).toBe("& 'C:\\Users\\me\\.local\\bin\\codex.exe' 'login'");
  });
});

describe("unknown runtime values", () => {
  const gemini = { agentId: "gemini" as SetupAgentId, realPath: "/Users/me/bin/gemini" };
  const cmdExe = "cmd" as ShellFlavor;
  it("throws on an agent id that is neither Claude Code nor Codex, instead of emitting Codex commands", () => {
    expect(() => installCommand("gemini" as SetupAgentId, "posix")).toThrow(/unknown agent id/);
    expect(() => updateCommand(gemini, "posix", { claudeUpdateExists: true })).toThrow(/unknown agent id/);
    expect(() => signInCommand(gemini, "posix")).toThrow(/unknown agent id/);
    expect(() => connectLibiCommand(gemini, "posix", ENDPOINT)).toThrow(/unknown agent id/);
    expect(() => disconnectLibiCommand(gemini, "posix", "user")).toThrow(/unknown agent id/);
    expect(() => providerAddCommand(gemini, "posix", fal, SCRIPTS)).toThrow(/unknown agent id/);
    expect(() => providerRemoveCommand(gemini, "posix", { agentId: "codex", name: "fal-ai" }, fal, SCRIPTS)).toThrow(/unknown agent id/);
    expect(() => providerReplaceCommand(gemini, "posix", fal, { agentId: "codex", name: "fal-ai" }, SCRIPTS)).toThrow(/unknown agent id/);
  });
  it("throws on a shell flavor that is neither posix nor powershell, instead of emitting posix commands", () => {
    expect(() => cliInvocation(claude.realPath, cmdExe)).toThrow(/unknown shell flavor/);
    expect(() => installCommand("claude-code", cmdExe)).toThrow(/unknown shell flavor/);
    expect(() => signInCommand(codex, cmdExe)).toThrow(/unknown shell flavor/);
    expect(() => chainCommands(cmdExe, "a", "b")).toThrow(/unknown shell flavor/);
    expect(() => providerAddCommand(claude, cmdExe, fal, SCRIPTS)).toThrow(/unknown shell flavor/);
    expect(() => providerRemoveCommand(claude, cmdExe, claudeFalUser, fal, SCRIPTS)).toThrow(/unknown shell flavor/);
    expect(() => providerScriptNames("provider-add", cmdExe)).toThrow(/unknown shell flavor/);
  });
});

describe("libi connect / disconnect / reconnect", () => {
  it("Claude connect names the user scope and the http transport", () => {
    expect(connectLibiCommand(claude, "posix", ENDPOINT)).toBe(
      "/Users/me/.local/bin/claude mcp add --scope user --transport http libi http://127.0.0.1:3457/mcp",
    );
  });
  it("Codex connect single-quotes the ?agent=codex URL on BOTH flavors (zsh rejects a bare `?` as a glob)", () => {
    expect(connectLibiCommand(codex, "posix", ENDPOINT)).toBe(
      "/Users/me/.local/bin/codex mcp add libi --url 'http://127.0.0.1:3457/mcp?agent=codex'",
    );
    expect(connectLibiCommand(codexWin, "powershell", ENDPOINT)).toBe(
      "& 'C:\\Users\\me\\.local\\bin\\codex.exe' 'mcp' 'add' 'libi' '--url' 'http://127.0.0.1:3457/mcp?agent=codex'",
    );
  });
  it("Claude disconnect uses the DETECTED scope, never a fixed --scope user", () => {
    expect(disconnectLibiCommand(claude, "posix", "local")).toBe("/Users/me/.local/bin/claude mcp remove --scope local libi");
    expect(disconnectLibiCommand(claude, "posix", "user")).toBe("/Users/me/.local/bin/claude mcp remove --scope user libi");
    expect(disconnectLibiCommand(codex, "posix", "user")).toBe("/Users/me/.local/bin/codex mcp remove libi");
  });
  it("reconnect runs the add only after the remove succeeded: `&& { }` on posix, `; if ($?) { }` on powershell", () => {
    expect(reconnectLibiCommand(claude, "posix", ENDPOINT, "user")).toBe(
      `${disconnectLibiCommand(claude, "posix", "user")} && { ${connectLibiCommand(claude, "posix", ENDPOINT)}; }`,
    );
    expect(reconnectLibiCommand(codexWin, "powershell", ENDPOINT, "user")).toBe(
      `${disconnectLibiCommand(codexWin, "powershell", "user")}; if ($?) { ${connectLibiCommand(codexWin, "powershell", ENDPOINT)} }`,
    );
  });
  it("quotes every argument that needs it: ?, &, $, *, spaces, and an embedded '", () => {
    // Claude's URL has no `?agent=codex` suffix, so each iteration is quoted because of `bad` alone.
    for (const bad of ["a?b", "a&b", "a$b", "a*b", "a b"]) {
      expect(connectLibiCommand(claude, "posix", `http://127.0.0.1:3457/${bad}`)).toBe(
        `/Users/me/.local/bin/claude mcp add --scope user --transport http libi 'http://127.0.0.1:3457/${bad}'`,
      );
    }
    expect(cliInvocation("/Users/o'neil/bin/claude", "posix")).toBe("'/Users/o'\\''neil/bin/claude'");
    expect(cliInvocation("C:\\Users\\o'neil\\claude.exe", "powershell")).toBe("& 'C:\\Users\\o''neil\\claude.exe'");
  });
});

describe("provider add / replace / remove: one short call to a setup script", () => {
  it("fal on Claude, posix: add-provider.sh with the provider, the agent and the CLI's path", () => {
    expect(providerAddCommand(claude, "posix", fal, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/add-provider.sh fal claude /Users/me/.local/bin/claude",
    );
  });
  it("fal on Codex, posix: the script reads login profiles, so the shell's own ZDOTDIR goes with it", () => {
    expect(providerAddCommand(codex, "posix", fal, SCRIPTS)).toBe(
      'ZDOTDIR="${ZDOTDIR-}" sh /opt/libi/lib/agents/setup/scripts/add-provider.sh fal codex /Users/me/.local/bin/codex',
    );
  });
  it("ElevenLabs on Codex, posix: no saved key, so no ZDOTDIR", () => {
    expect(providerAddCommand(codex, "posix", elevenlabs, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/add-provider.sh elevenlabs codex /Users/me/.local/bin/codex",
    );
  });
  it("PowerShell: the script's text runs as a scriptblock in a child powershell (Group Policy can refuse a script file), every argument quoted", () => {
    expect(providerAddCommand(codexWin, "powershell", fal, SCRIPTS_WIN)).toBe(
      "powershell -NoProfile -Command \"& ([scriptblock]::Create([IO.File]::ReadAllText('C:\\Program Files\\libi\\lib\\agents\\setup\\scripts\\add-provider.ps1'))) 'fal' 'codex' 'C:\\Users\\me\\.local\\bin\\codex.exe'\"",
    );
    expect(providerAddCommand(claudeWin, "powershell", elevenlabs, SCRIPTS_WIN)).toBe(
      "powershell -NoProfile -Command \"& ([scriptblock]::Create([IO.File]::ReadAllText('C:\\Program Files\\libi\\lib\\agents\\setup\\scripts\\add-provider.ps1'))) 'elevenlabs' 'claude' 'C:\\Users\\me\\.local\\bin\\claude.exe'\"",
    );
  });
  it("a scripts folder or CLI path with a space or a quote stays one word, and a trailing separator is not doubled", () => {
    expect(providerAddCommand(claudeSpace, "posix", fal, "/Users/o'neil/My libi/scripts/")).toBe(
      "sh '/Users/o'\\''neil/My libi/scripts/add-provider.sh' fal claude '/Users/me/My Tools/claude'",
    );
    expect(providerAddCommand(claudeWin, "powershell", fal, "C:\\Users\\O’Neil\\libi\\scripts\\")).toBe(
      "powershell -NoProfile -Command \"& ([scriptblock]::Create([IO.File]::ReadAllText('C:\\Users\\O’’Neil\\libi\\scripts\\add-provider.ps1'))) 'fal' 'claude' 'C:\\Users\\me\\.local\\bin\\claude.exe'\"",
    );
  });
  it("refuses a scripts folder that is not a plain absolute path for the flavor", () => {
    for (const [dir, flavor, cli] of [
      ["lib/agents/setup/scripts", "posix", claude],
      ["/opt/libi\n/scripts", "posix", claude],
      ["/opt/libi/scripts", "powershell", claudeWin],
      ["scripts", "powershell", claudeWin],
    ] as const) {
      expect(() => providerAddCommand(cli, flavor, fal, dir)).toThrow(/not a plain absolute path/);
    }
    expect(providerAddCommand(claudeWin, "powershell", fal, "\\\\server\\share\\libi\\scripts")).toContain("'\\\\server\\share\\libi\\scripts\\add-provider.ps1'");
  });
  it("a docs-only provider builds nothing, and sign-in builds nothing for a keyed provider", () => {
    expect(providerAddCommand(claude, "posix", DOCS_ONLY, SCRIPTS)).toBeNull();
    expect(providerRemoveCommand(claude, "posix", claudeFalUser, DOCS_ONLY, SCRIPTS)).toBeNull();
    expect(providerReplaceCommand(claude, "posix", DOCS_ONLY, claudeFalUser, SCRIPTS)).toBeNull();
    expect(providerSignInCommand(claude, "posix", claudeFalUser, DOCS_ONLY, SCRIPTS)).toBeNull();
    expect(providerSignInCommand(codex, "posix", { agentId: "codex", name: "fal-ai" }, fal, SCRIPTS)).toBeNull();
    expect(providerSignInCommand(claude, "posix", { agentId: "claude-code", name: "elevenlabs", scope: "user" }, elevenlabs, SCRIPTS)).toBeNull();
  });
  it("Higgsfield: add, remove and replace name the provider like any other, and never pass ZDOTDIR — there is no key to save", () => {
    expect(providerAddCommand(claude, "posix", higgsfield, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/add-provider.sh higgsfield claude /Users/me/.local/bin/claude",
    );
    expect(providerAddCommand(codex, "posix", higgsfield, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/add-provider.sh higgsfield codex /Users/me/.local/bin/codex",
    );
    expect(providerRemoveCommand(codex, "posix", { agentId: "codex", name: "higgsfield" }, higgsfield, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/remove-provider.sh higgsfield codex /Users/me/.local/bin/codex higgsfield",
    );
    expect(providerReplaceCommand(claude, "posix", higgsfield, { agentId: "claude-code", name: "higgsfield", scope: "user" }, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/replace-provider.sh higgsfield claude /Users/me/.local/bin/claude higgsfield user",
    );
  });
  it("sign-in is one call to signin-provider with the provider, the agent, the CLI's path and the detected name — no scope, since `mcp login` takes only a name", () => {
    expect(providerSignInCommand(codex, "posix", { agentId: "codex", name: "higgsfield" }, higgsfield, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/signin-provider.sh higgsfield codex /Users/me/.local/bin/codex higgsfield",
    );
    expect(providerSignInCommand(claude, "posix", { agentId: "claude-code", name: "my-hf", scope: "local" }, higgsfield, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/signin-provider.sh higgsfield claude /Users/me/.local/bin/claude my-hf",
    );
    expect(providerSignInCommand(codexWin, "powershell", { agentId: "codex", name: "higgsfield" }, higgsfield, SCRIPTS_WIN)).toBe(
      "powershell -NoProfile -Command \"& ([scriptblock]::Create([IO.File]::ReadAllText('C:\\Program Files\\libi\\lib\\agents\\setup\\scripts\\signin-provider.ps1'))) 'higgsfield' 'codex' 'C:\\Users\\me\\.local\\bin\\codex.exe' 'higgsfield'\"",
    );
    expect(() => providerSignInCommand(claude, "posix", { agentId: "codex", name: "higgsfield" }, higgsfield, SCRIPTS)).toThrow(/does not match/);
  });
  it("remove passes the detected name, and for Claude the detected scope; Codex has none", () => {
    expect(providerRemoveCommand(claude, "posix", { agentId: "claude-code", name: "fal-ai", scope: "local" }, fal, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/remove-provider.sh fal claude /Users/me/.local/bin/claude fal-ai local",
    );
    expect(providerRemoveCommand(claude, "posix", { agentId: "claude-code", name: "fal-ai", scope: "project" }, fal, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/remove-provider.sh fal claude /Users/me/.local/bin/claude fal-ai project",
    );
    expect(providerRemoveCommand(codex, "posix", { agentId: "codex", name: "fal-ai" }, fal, SCRIPTS)).toBe(
      'ZDOTDIR="${ZDOTDIR-}" sh /opt/libi/lib/agents/setup/scripts/remove-provider.sh fal codex /Users/me/.local/bin/codex fal-ai',
    );
    expect(providerRemoveCommand(codex, "posix", { agentId: "codex", name: "elevenlabs" }, elevenlabs, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/remove-provider.sh elevenlabs codex /Users/me/.local/bin/codex elevenlabs",
    );
    expect(providerRemoveCommand(codexWin, "powershell", { agentId: "codex", name: "fal-ai" }, fal, SCRIPTS_WIN)).toBe(
      "powershell -NoProfile -Command \"& ([scriptblock]::Create([IO.File]::ReadAllText('C:\\Program Files\\libi\\lib\\agents\\setup\\scripts\\remove-provider.ps1'))) 'fal' 'codex' 'C:\\Users\\me\\.local\\bin\\codex.exe' 'fal-ai'\"",
    );
  });
  it("replace is ONE script call with the remove's arguments: the script runs the add only after its remove succeeded", () => {
    expect(providerReplaceCommand(claude, "posix", fal, claudeFalUser, SCRIPTS)).toBe(
      "sh /opt/libi/lib/agents/setup/scripts/replace-provider.sh fal claude /Users/me/.local/bin/claude fal-ai user",
    );
    expect(providerReplaceCommand(codex, "posix", fal, { agentId: "codex", name: "fal-ai" }, SCRIPTS)).toBe(
      'ZDOTDIR="${ZDOTDIR-}" sh /opt/libi/lib/agents/setup/scripts/replace-provider.sh fal codex /Users/me/.local/bin/codex fal-ai',
    );
    expect(providerReplaceCommand(claudeWin, "powershell", elevenlabs, { agentId: "claude-code", name: "elevenlabs", scope: "project" }, SCRIPTS_WIN)).toBe(
      "powershell -NoProfile -Command \"& ([scriptblock]::Create([IO.File]::ReadAllText('C:\\Program Files\\libi\\lib\\agents\\setup\\scripts\\replace-provider.ps1'))) 'elevenlabs' 'claude' 'C:\\Users\\me\\.local\\bin\\claude.exe' 'elevenlabs' 'project' -ScriptsDir 'C:\\Program Files\\libi\\lib\\agents\\setup\\scripts'\"",
    );
  });
  it("a Claude entry without its detected scope is a type error, and throws if it gets through anyway", () => {
    // @ts-expect-error a Claude entry must carry the scope it was detected in
    expect(() => providerRemoveCommand(claude, "posix", { agentId: "claude-code", name: "fal-ai" }, fal, SCRIPTS)).toThrow(/scope/);
  });
  it("an entry detected for the other agent throws", () => {
    expect(() => providerRemoveCommand(claude, "posix", { agentId: "codex", name: "fal-ai" }, fal, SCRIPTS)).toThrow(/does not match/);
    expect(() => providerRemoveCommand(codex, "posix", claudeFalUser, fal, SCRIPTS)).toThrow(/does not match/);
  });
  it("a typographic quote in a detected name stays inside PowerShell's single-quoted string", () => {
    expect(providerRemoveCommand(codexWin, "powershell", { agentId: "codex", name: "x’; Write-Output PWNED; ’" }, elevenlabs, SCRIPTS_WIN)).toMatch(
      / 'x’’; Write-Output PWNED; ’’'"$/,
    );
  });
  it("refuses a detected name carrying a control character before building anything", () => {
    for (const c of ["\x00", "\t", "\n", "\r", "\x15", "\x1b", "\x7f"]) {
      const name = `fal${c}ai`;
      expect(() => providerRemoveCommand(claude, "posix", { agentId: "claude-code", name, scope: "user" }, fal, SCRIPTS)).toThrow(/control character/);
      expect(() => providerRemoveCommand(codexWin, "powershell", { agentId: "codex", name }, fal, SCRIPTS_WIN)).toThrow(/control character/);
      expect(() => providerReplaceCommand(claude, "posix", fal, { agentId: "claude-code", name, scope: "user" }, SCRIPTS)).toThrow(/control character/);
      expect(() => providerSignInCommand(claude, "posix", { agentId: "claude-code", name, scope: "user" }, higgsfield, SCRIPTS)).toThrow(/control character/);
      // Even when the provider is docs-only, or keyed for a sign-in, and no command would be built.
      expect(() => providerReplaceCommand(claude, "posix", DOCS_ONLY, { agentId: "claude-code", name, scope: "user" }, SCRIPTS)).toThrow(/control character/);
      expect(() => providerRemoveCommand(claude, "posix", { agentId: "claude-code", name, scope: "user" }, DOCS_ONLY, SCRIPTS)).toThrow(/control character/);
      expect(() => providerSignInCommand(codex, "posix", { agentId: "codex", name }, fal, SCRIPTS)).toThrow(/control character/);
    }
  });
  it("hands a detected name that starts with `-` to the script as a plain argument — the script puts it after `--` for the CLI", () => {
    expect(providerRemoveCommand(codex, "posix", { agentId: "codex", name: "--help" }, higgsfield, SCRIPTS)).toMatch(
      /^sh \/opt\/libi\/lib\/agents\/setup\/scripts\/remove-provider\.sh higgsfield codex \/Users\/me\/\.local\/bin\/codex '?--help'?$/,
    );
    expect(providerSignInCommand(claude, "posix", { agentId: "claude-code", name: "-x", scope: "user" }, higgsfield, SCRIPTS)).toMatch(
      / higgsfield claude \/Users\/me\/\.local\/bin\/claude '?-x'?$/,
    );
    // PowerShell: a single-quoted value in the child, never a parameter name.
    expect(providerReplaceCommand(codexWin, "powershell", fal, { agentId: "codex", name: "-x" }, SCRIPTS_WIN)).toContain(" 'fal' 'codex' 'C:\\Users\\me\\.local\\bin\\codex.exe' '-x' -ScriptsDir ");
  });
  it("NO provider command carries a key, a key variable, the placeholder or a control character — the script reads the key itself", () => {
    let checked = 0;
    for (const def of PROVIDER_CATALOG) {
      for (const [cli, flavor, dir] of [[claude, "posix", SCRIPTS], [codex, "posix", SCRIPTS], [claudeWin, "powershell", SCRIPTS_WIN], [codexWin, "powershell", SCRIPTS_WIN]] as const) {
        const entry: DetectedProviderEntry =
          cli.agentId === "codex" ? { agentId: "codex", name: def.id } : { agentId: "claude-code", name: def.id, scope: "user" };
        for (const cmd of [
          providerAddCommand(cli, flavor, def, dir),
          providerReplaceCommand(cli, flavor, def, entry, dir),
          providerRemoveCommand(cli, flavor, entry, def, dir),
          providerSignInCommand(cli, flavor, entry, def, dir),
        ]) {
          if (cmd === null) continue;
          checked++;
          // A control character would reach the PTY's line editor: a newline submits half a command.
          expect(cmd).not.toMatch(/[\x00-\x1f\x7f]/);
          expect(cmd).not.toContain(KEY_PLACEHOLDER);
          expect(cmd).not.toMatch(/libi_key|\$key|read |Read-Host|Bearer|_API_KEY|FAL_KEY/);
          expect(commandCarriesNoKeyMaterial(cmd)).toBe(true);
          expect(cmd).toMatch(flavor === "posix" ? /^(?:ZDOTDIR="\$\{ZDOTDIR-\}" )?sh / : /^powershell -NoProfile -Command "& \(\[scriptblock\]::Create\(\[IO\.File\]::ReadAllText\('/);
        }
      }
    }
    expect(checked).toBe(WITH_COMMANDS.length * 4 * 3 + OAUTH.length * 4);
  });
});

/** Every character PowerShell's tokenizer reads as a single quote, and as a double quote. */
const PS_SINGLE_QUOTES = "'\u2018\u2019\u201A\u201B";
const PS_DOUBLE_QUOTES = '"\u201C\u201D\u201E';
/** The backtick escapes that stand for another character inside a PowerShell double-quoted string. */
const PS_ESCAPES: Record<string, string> = { "0": "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/**
 * The setup terminal's PowerShell reading a typed provider command: the one double-quoted `-Command` argument, with
 * its backtick escapes undone. An unescaped `$` would expand in that shell, so it fails here.
 */
function readTypedPowerShell(line: string): string {
  const head = 'powershell -NoProfile -Command "';
  expect(line.startsWith(head), line).toBe(true);
  let value = "";
  for (let i = head.length; i < line.length; i++) {
    const c = line[i];
    if (c === "`") {
      i++;
      if (line[i] === "u" && line[i + 1] === "{") throw new Error(`a unicode escape at ${i}: ${line}`);
      value += PS_ESCAPES[line[i]] ?? line[i];
    } else if (c === "$") {
      throw new Error(`an unescaped $ at ${i} would expand in the setup terminal's shell: ${line}`);
    } else if (PS_DOUBLE_QUOTES.includes(c)) {
      expect(i, `the -Command string ends before the line does: ${line}`).toBe(line.length - 1);
      return value;
    } else {
      value += c;
    }
  }
  throw new Error(`the -Command string is never closed: ${line}`);
}

/** The child `powershell` reading that argument: the script file whose text it runs, and each argument's value. */
function readChildCommand(payload: string): { script: string; args: string[] } {
  const head = "& ([scriptblock]::Create([IO.File]::ReadAllText(";
  expect(payload.startsWith(head), payload).toBe(true);
  let i = head.length;
  const isSingleQuote = (at: number) => at < payload.length && PS_SINGLE_QUOTES.includes(payload[at]);
  const quoted = (): string => {
    expect(isSingleQuote(i), `a single-quoted string at ${i}: ${payload}`).toBe(true);
    let value = "";
    for (i++; i < payload.length; i++) {
      if (!isSingleQuote(i)) {
        value += payload[i];
      } else if (isSingleQuote(i + 1)) {
        // Two quotes in a row are one literal quote: the second one.
        i++;
        value += payload[i];
      } else {
        i++;
        return value;
      }
    }
    throw new Error(`a single-quoted string is never closed: ${payload}`);
  };
  const script = quoted();
  expect(payload.slice(i, i + 3)).toBe(")))");
  i += 3;
  const args: string[] = [];
  while (i < payload.length) {
    expect(payload[i], payload).toBe(" ");
    i++;
    if (payload.startsWith("-ScriptsDir ", i)) {
      args.push("-ScriptsDir");
      i += "-ScriptsDir".length;
    } else {
      args.push(quoted());
    }
  }
  return { script, args };
}

describe("the typed PowerShell command, read back the way PowerShell reads it", () => {
  const HEAD = "powershell -NoProfile -Command \"& ([scriptblock]::Create([IO.File]::ReadAllText(";
  const PATHS = [
    {
      label: "a normal path",
      dir: "C:\\Users\\me\\AppData\\Local\\Programs\\libi\\resources\\scripts",
      cli: "C:\\Users\\me\\.local\\bin\\codex.exe",
      typed: `${HEAD}'C:\\Users\\me\\AppData\\Local\\Programs\\libi\\resources\\scripts\\add-provider.ps1'))) 'fal' 'codex' 'C:\\Users\\me\\.local\\bin\\codex.exe'"`,
    },
    {
      label: "a path with spaces",
      dir: "C:\\Program Files\\libi\\setup  scripts",
      cli: "C:\\Users\\Jane Doe\\bin\\codex.exe",
      typed: `${HEAD}'C:\\Program Files\\libi\\setup  scripts\\add-provider.ps1'))) 'fal' 'codex' 'C:\\Users\\Jane Doe\\bin\\codex.exe'"`,
    },
    {
      label: "a path with '",
      dir: "C:\\Users\\O'Neil\\libi\\scripts",
      cli: "C:\\Users\\O'Neil\\bin\\codex.exe",
      typed: `${HEAD}'C:\\Users\\O''Neil\\libi\\scripts\\add-provider.ps1'))) 'fal' 'codex' 'C:\\Users\\O''Neil\\bin\\codex.exe'"`,
    },
    {
      label: "a path with $ and a backtick",
      dir: "C:\\Users\\$env:USERNAME\\li`nbi\\scripts",
      cli: "C:\\tools\\$(calc)\\`$x\\codex.exe",
      typed: `${HEAD}'C:\\Users\\\`$env:USERNAME\\li\`\`nbi\\scripts\\add-provider.ps1'))) 'fal' 'codex' 'C:\\tools\\\`$(calc)\\\`\`\`$x\\codex.exe'"`,
    },
  ];
  const codexAt = (realPath: string) => ({ agentId: "codex" as const, realPath });
  const claudeAt = (realPath: string) => ({ agentId: "claude-code" as const, realPath });

  it.each(PATHS)("Codex fal add with $label: the exact line, no double quote inside -Command, and every value read back unchanged", ({ dir, cli, typed }) => {
    expect(providerAddCommand(codexAt(cli), "powershell", fal, dir)).toBe(typed);
    const payload = readTypedPowerShell(typed);
    expect(payload).not.toContain('"');
    expect(payload).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(readChildCommand(payload)).toEqual({ script: `${dir}\\add-provider.ps1`, args: ["fal", "codex", cli] });
  });

  it.each(PATHS)("remove, replace and sign-in with $label read back unchanged; replace also names the scripts folder as -ScriptsDir", ({ dir, cli }) => {
    const entry = { agentId: "claude-code", name: "fal-ai", scope: "local" } as const;
    const removed = readChildCommand(readTypedPowerShell(providerRemoveCommand(claudeAt(cli), "powershell", entry, fal, dir)!));
    expect(removed).toEqual({ script: `${dir}\\remove-provider.ps1`, args: ["fal", "claude", cli, "fal-ai", "local"] });
    const replaced = readChildCommand(readTypedPowerShell(providerReplaceCommand(claudeAt(cli), "powershell", fal, entry, dir)!));
    expect(replaced).toEqual({ script: `${dir}\\replace-provider.ps1`, args: ["fal", "claude", cli, "fal-ai", "local", "-ScriptsDir", dir] });
    const signedIn = readChildCommand(
      readTypedPowerShell(providerSignInCommand(claudeAt(cli), "powershell", { ...entry, name: "higgsfield" }, higgsfield, dir)!),
    );
    expect(signedIn).toEqual({ script: `${dir}\\signin-provider.ps1`, args: ["higgsfield", "claude", cli, "higgsfield"] });
  });

  it("a detected name with typographic quotes of both kinds, $ and a backtick stays one value in both shells", () => {
    const name = "x\u201C$(Write-Output PWNED)\u201D\u2019; `n \u201E'";
    const line = providerRemoveCommand(codexWin, "powershell", { agentId: "codex", name }, fal, SCRIPTS_WIN)!;
    const payload = readTypedPowerShell(line);
    expect(payload).not.toContain('"');
    expect(readChildCommand(payload).args).toEqual(["fal", "codex", codexWin.realPath, name]);
  });

  it("an ASCII double quote in any argument is refused on PowerShell, where 5.1 would split -Command at it; posix still quotes it", () => {
    expect(() => providerRemoveCommand(codexWin, "powershell", { agentId: "codex", name: 'fal"ai' }, fal, SCRIPTS_WIN)).toThrow(/double quote/);
    expect(() => providerReplaceCommand(claudeWin, "powershell", fal, { agentId: "claude-code", name: 'fal"ai', scope: "user" }, SCRIPTS_WIN)).toThrow(/double quote/);
    expect(() => providerAddCommand({ agentId: "codex", realPath: 'C:\\a"b\\codex.exe' }, "powershell", fal, SCRIPTS_WIN)).toThrow(/double quote/);
    expect(providerRemoveCommand(codex, "posix", { agentId: "codex", name: 'fal"ai' }, fal, SCRIPTS)).toMatch(/ 'fal"ai'$/);
  });

  it("every PowerShell provider command, for every path above, holds exactly the two quotes around -Command and reads back to its script and arguments", () => {
    let checked = 0;
    for (const { dir, cli } of PATHS) {
      for (const def of WITH_COMMANDS) {
        for (const at of [claudeAt, codexAt]) {
          const agentCli = at(cli);
          const agent = agentCli.agentId === "codex" ? "codex" : "claude";
          const entry: DetectedProviderEntry =
            agentCli.agentId === "codex" ? { agentId: "codex", name: def.id } : { agentId: "claude-code", name: def.id, scope: "project" };
          const target = agentCli.agentId === "codex" ? [def.id] : [def.id, "project"];
          const lines: Array<readonly [string | null, string, readonly string[]]> = [
            [providerAddCommand(agentCli, "powershell", def, dir), "add-provider.ps1", [def.id, agent, cli]],
            [providerRemoveCommand(agentCli, "powershell", entry, def, dir), "remove-provider.ps1", [def.id, agent, cli, ...target]],
            [providerReplaceCommand(agentCli, "powershell", def, entry, dir), "replace-provider.ps1", [def.id, agent, cli, ...target, "-ScriptsDir", dir]],
            [providerSignInCommand(agentCli, "powershell", entry, def, dir), "signin-provider.ps1", [def.id, agent, cli, def.id]],
          ];
          for (const [line, script, args] of lines) {
            if (line === null) {
              expect(script).toBe("signin-provider.ps1");
              expect(def.auth).toBeUndefined();
              continue;
            }
            checked++;
            expect(line.split('"')).toHaveLength(3);
            const payload = readTypedPowerShell(line);
            expect(payload).not.toContain('"');
            expect(readChildCommand(payload)).toEqual({ script: `${dir}\\${script}`, args });
          }
        }
      }
    }
    expect(checked).toBe(PATHS.length * (WITH_COMMANDS.length * 2 * 3 + OAUTH.length * 2));
  });
});

describe("the setup script names and links", () => {
  it("each action names the scripts it runs, in order: a replace runs its own script, then the add script", () => {
    expect(providerScriptNames("provider-add", "posix")).toEqual(["add-provider.sh"]);
    expect(providerScriptNames("provider-remove", "posix")).toEqual(["remove-provider.sh"]);
    expect(providerScriptNames("provider-replace", "posix")).toEqual(["replace-provider.sh", "add-provider.sh"]);
    expect(providerScriptNames("provider-add", "powershell")).toEqual(["add-provider.ps1"]);
    expect(providerScriptNames("provider-replace", "powershell")).toEqual(["replace-provider.ps1", "add-provider.ps1"]);
    expect(providerScriptNames("provider-sign-in", "posix")).toEqual(["signin-provider.sh"]);
    expect(providerScriptNames("provider-sign-in", "powershell")).toEqual(["signin-provider.ps1"]);
  });
  it("the allowlist is exactly the files in the scripts folder, and each link points at the script route", () => {
    expect([...SETUP_SCRIPT_NAMES].sort()).toEqual(readdirSync(SCRIPTS_DIR).sort());
    expect(setupScriptUrl("add-provider.sh")).toBe("/api/agents/setup-scripts/add-provider.sh");
    expect(setupScriptUrl("a b/../c")).toBe("/api/agents/setup-scripts/a%20b%2F..%2Fc");
  });
});

describe("the setup scripts, as text", () => {
  it("every script opens with a plain-language header saying what it does", () => {
    for (const name of SETUP_SCRIPT_NAMES) {
      const lines = scriptText(name).split("\n");
      const header = name.endsWith(".sh") ? lines.slice(1) : lines;
      if (name.endsWith(".sh")) expect(lines[0]).toBe("#!/bin/sh");
      expect(header[0]).toMatch(new RegExp(`^# ${escapeRegExp(name)}: [a-z].+`));
      expect(scriptText(name)).toContain("# What it does:");
    }
  });
  it("every script is plain ASCII: Windows PowerShell reads a file without a byte-order mark in the system code page", () => {
    for (const name of SETUP_SCRIPT_NAMES) expect(scriptText(name)).not.toMatch(/[^\x09\x0a\x20-\x7e]/);
  });
  it.each(SCRIPT_SHELLS)("every POSIX script parses under %s", (shell) => {
    for (const name of POSIX_SCRIPTS) {
      const result = spawnSync(shell, ["-n", scriptPath(name)], { encoding: "utf8" });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });
  it("the POSIX scripts stay POSIX: no `read -s` (dash has none), every external tool behind `command`, every profile scan in a byte locale", () => {
    for (const name of POSIX_SCRIPTS) {
      for (const line of codeLines(scriptText(name))) {
        expect(line).not.toMatch(/\bread -\w*s/);
        expect(line, `${name}: ${line}`).not.toMatch(BARE_EXTERNAL_TOOL);
        expect(line, `${name}: ${line}`).not.toMatch(SCANS_PROFILE_WITHOUT_BYTE_LOCALE);
        // macOS `sed -i` refuses a symlinked profile, and the bare marker text also matches mid-line.
        expect(line).not.toContain("sed -i");
        expect(line).not.toContain("grep -qF");
      }
    }
    // The profile is written once, from the finished copy: never an append that could fail after the old line was dropped.
    expect(scriptText("add-provider.sh")).not.toContain('>> "$profile"');
    // Remove never creates a profile, and never reads a key.
    expect(codeLines(scriptText("remove-provider.sh")).join("\n")).not.toMatch(/touch|read -r/);
  });
  it("the shape checks catch what they claim to: a tool behind only an env prefix", () => {
    expect("x; LC_ALL=C sed d f").toMatch(BARE_EXTERNAL_TOOL);
    expect("elif cat f").toMatch(BARE_EXTERNAL_TOOL);
    expect("x; LC_ALL=C command sed d f").not.toMatch(BARE_EXTERNAL_TOOL);
    // An assignment from a command substitution is not an environment prefix.
    expect("  state=$(command stty -g) || state=''").not.toMatch(BARE_EXTERNAL_TOOL);
    expect("x; command sed d f").toMatch(SCANS_PROFILE_WITHOUT_BYTE_LOCALE);
  });
  it("the profile code add-provider.sh and remove-provider.sh share is byte-for-byte the same in both", () => {
    const shared = (name: string) => {
      const match = /# ---- same in add-provider\.sh and remove-provider\.sh: begin ----\n[\s\S]*?# ---- same in add-provider\.sh and remove-provider\.sh: end ----\n/.exec(scriptText(name));
      expect(match, name).not.toBeNull();
      return match![0];
    };
    expect(shared("add-provider.sh")).toBe(shared("remove-provider.sh"));
  });
  it("the scripts list exactly the catalog's providers that have commands", () => {
    const expected = WITH_COMMANDS.map((def) => def.id).sort();
    const idsIn = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]).sort();
    expect(idsIn(scriptText("add-provider.sh"), /^ {2}([a-z][\w-]*)\) +name=/gm)).toEqual(expected);
    expect(idsIn(scriptText("remove-provider.sh"), /^ {2}([a-z][\w-]*)\) +name=/gm)).toEqual(expected);
    const replaceList = /case \$provider in\n {2}([^)]+)\) ;;/.exec(scriptText("replace-provider.sh"))![1];
    expect(replaceList.split("|").map((id) => id.trim()).sort()).toEqual(expected);
    expect(idsIn(scriptText("add-provider.ps1"), /^ {2}'([a-z][\w-]*)' +\{ \$name = /gm)).toEqual(expected);
    expect(idsIn(scriptText("remove-provider.ps1"), /^ {2}'([a-z][\w-]*)' +\{ \$name = /gm)).toEqual(expected);
    const replacePs = /\$Provider -cnotin @\(([^)]*)\)/.exec(scriptText("replace-provider.ps1"))![1];
    expect(replacePs.split(",").map((id) => id.trim().replace(/'/g, "")).sort()).toEqual(expected);
    // signin-provider knows exactly the providers signed in to with an account.
    const oauth = OAUTH.map((def) => def.id).sort();
    expect(oauth.length).toBeGreaterThan(0);
    expect(idsIn(scriptText("signin-provider.sh"), /^ {2}([a-z][\w-]*)\) +name=/gm)).toEqual(oauth);
    expect(idsIn(scriptText("signin-provider.ps1"), /^ {2}'([a-z][\w-]*)' +\{ \$name = /gm)).toEqual(oauth);
  });
  it("the POSIX provider tables hold each provider's name, whether it takes a key or an account sign-in, and its saved Codex key", () => {
    for (const def of WITH_COMMANDS) {
      expect(scriptText("add-provider.sh")).toMatch(
        new RegExp(`^ {2}${def.id}\\) +name='${escapeRegExp(def.name)}'; +auth='${def.auth ?? "key"}'; +codex_key_env='${def.codexKeyEnv ?? ""}' ;;$`, "m"),
      );
      expect(scriptText("remove-provider.sh")).toMatch(
        new RegExp(`^ {2}${def.id}\\) +name='${escapeRegExp(def.name)}'; +auth='${def.auth ?? "key"}'; +codex_key_env='${def.codexKeyEnv ?? ""}' ;;$`, "m"),
      );
    }
    for (const def of OAUTH) {
      expect(scriptText("signin-provider.sh")).toMatch(new RegExp(`^ {2}${def.id}\\) name='${escapeRegExp(def.name)}' ;;$`, "m"));
      expect(scriptText("signin-provider.ps1")).toMatch(new RegExp(`^ {2}'${def.id}' +\\{ \\$name = '${escapeRegExp(def.name)}' \\}$`, "m"));
    }
  });
});

/**
 * No PowerShell runs on the machines this suite runs on (macOS and Linux CI), so the .ps1 scripts are checked as
 * text: the provider table and every `mcp add` argument list against the catalog, and each call the behaviour
 * depends on. The POSIX scripts, which share that behaviour, are RUN below.
 */
describe("the PowerShell scripts, as text", () => {
  const add = () => scriptText("add-provider.ps1");
  const remove = () => scriptText("remove-provider.ps1");
  const replace = () => scriptText("replace-provider.ps1");
  /** A catalog token as a PowerShell literal: single-quoted, or double-quoted with `$key` where the placeholder is. */
  const psLiteral = (token: string) => {
    // A literal part holding a quote, `$` or a backtick would need escaping this check doesn't model.
    expect(token.split(KEY_PLACEHOLDER).join("")).not.toMatch(/['"$`]/);
    return token.includes(KEY_PLACEHOLDER) ? `"${token.split(KEY_PLACEHOLDER).join("$key")}"` : `'${token}'`;
  };

  it("take their arguments as plain positional strings, and refuse an unknown provider or agent with exit 2", () => {
    expect(add()).toContain("param([string]$Provider, [string]$Agent, [string]$Cli)");
    expect(remove()).toContain("param([string]$Provider, [string]$Agent, [string]$Cli, [string]$Entry, [string]$Scope)");
    expect(replace()).toContain("param([string]$Provider, [string]$Agent, [string]$Cli, [string]$Entry, [string]$Scope, [string]$ScriptsDir)");
    expect(scriptText("signin-provider.ps1")).toContain("param([string]$Provider, [string]$Agent, [string]$Cli, [string]$Entry)");
    for (const text of [remove(), replace()]) {
      expect(text).toMatch(/default +\{ \[Console\]::Error\.WriteLine\("[a-z-]+\.ps1: unknown agent '\$Agent'"\); exit 2 \}/);
    }
    expect(add()).toMatch(/default +\{ \[Console\]::Error\.WriteLine\("add-provider\.ps1: unknown provider '\$Provider'"\); exit 2 \}/);
    expect(scriptText("signin-provider.ps1")).toMatch(/default +\{ \[Console\]::Error\.WriteLine\("signin-provider\.ps1: unknown provider '\$Provider'"\); exit 2 \}/);
    for (const text of [add(), remove(), replace(), scriptText("signin-provider.ps1")]) expect(text).not.toMatch(/Mandatory/);
  });
  it("add-provider.ps1 holds the catalog's provider table and its exact `mcp add` argument list for every provider and agent", () => {
    for (const def of WITH_COMMANDS) {
      expect(add()).toMatch(
        new RegExp(
          `^ {2}'${def.id}' +\\{ \\$name = '${escapeRegExp(def.name)}'; \\$auth = '${def.auth ?? "key"}'; \\$codexKeyEnv = '${def.codexKeyEnv ?? ""}' \\}$`,
          "m",
        ),
      );
      expect(remove()).toMatch(
        new RegExp(
          `^ {2}'${def.id}' +\\{ \\$name = '${escapeRegExp(def.name)}'; \\$auth = '${def.auth ?? "key"}'; \\$codexKeyEnv = '${def.codexKeyEnv ?? ""}' \\}$`,
          "m",
        ),
      );
      for (const agent of ["claude", "codex"] as const) {
        const [head, ...args] = tokenizeCatalogCommand(def.commands![agent]);
        expect(head).toBe(agent);
        const list = args.map(psLiteral).join(", ");
        expect(add()).toMatch(new RegExp(`^ {2}'${def.id}/${agent}' +\\{ \\$addArgs = @\\(${escapeRegExp(list)}\\) \\}$`, "m"));
      }
    }
    expect(add()).toContain("& $Cli @addArgs");
  });
  it("add-provider.ps1 reads the key as a SecureString, saves a Codex key for the Windows user only when one was entered, and never prints it", () => {
    const text = add();
    expect(text).toContain(`$key = [Net.NetworkCredential]::new('', (Read-Host "$name key" -AsSecureString)).Password`);
    expect(text).toContain("if ($Agent -ceq 'codex' -and $codexKeyEnv) {");
    expect(text).toContain("Write-Host 'Nothing saved: no key entered.'");
    expect(text).toContain("[Environment]::SetEnvironmentVariable($codexKeyEnv, $key, 'User')");
    expect(text).toContain('Write-Host "Saved $codexKeyEnv for your Windows user. Restart libi and Codex so they read it."');
    // Saved before the add, and nothing is saved or added without a key.
    expect(text.indexOf("if (-not $key)")).toBeLessThan(text.indexOf("SetEnvironmentVariable"));
    expect(text.indexOf("SetEnvironmentVariable")).toBeLessThan(text.indexOf("& $Cli @addArgs"));
    // `$key` appears in the read, the empty check, the save and the argument lists — nowhere it could be printed.
    const keyLines = codeLines(text).filter((line) => /\$key\b/.test(line));
    const keyedCommands = WITH_COMMANDS.flatMap((def) => [def.commands!.claude, def.commands!.codex]).filter((c) => c.includes(KEY_PLACEHOLDER));
    expect(keyLines).toHaveLength(1 + 1 + 1 + keyedCommands.length);
    for (const line of keyLines) expect(line).not.toMatch(/Write-|Out-|echo|\$Host/);
    // The agent's own exit code comes back out.
    expect(text).toMatch(
      /& \$Cli @addArgs\nif \(\$\?\) \{\n {2}if \(\$auth -ceq 'oauth' -and \$Agent -ceq 'claude'\) \{\n {4}Write-Host "[^"\n]+"\n {2}\}\n {2}exit 0\n\}\nif \(\$LASTEXITCODE\) \{ exit \$LASTEXITCODE \}\nexit 1\n$/,
    );
  });
  it("add-provider.ps1 asks nothing for a provider signed in to with an account, and says what the sign-in does in the same words as add-provider.sh", () => {
    const text = add();
    expect(text).toContain("if ($auth -ceq 'key') {\n  $key = [Net.NetworkCredential]::new('', (Read-Host \"$name key\" -AsSecureString)).Password\n}");
    // The same two messages as the POSIX script, with PowerShell's variables in place of sh's.
    const shMessages = [...scriptText("add-provider.sh").matchAll(/^ +echo "((?:Codex adds|Added\. Now sign in)[^"]*)"$/gm)].map((m) => m[1]);
    expect(shMessages).toHaveLength(2);
    for (const message of shMessages) expect(text).toContain(`Write-Host "${message.replace("$provider", "$Provider")}"`);
    // Codex's message comes before the add, which starts the sign-in; Claude's only after the add worked.
    expect(text.indexOf('Write-Host "Codex adds')).toBeLessThan(text.indexOf("& $Cli @addArgs"));
    expect(text.indexOf('Write-Host "Added. Now sign in')).toBeGreaterThan(text.indexOf("if ($?) {"));
  });
  it("signin-provider.ps1 runs the agent's own `mcp login` for the detected name, says a browser opens, and exits with the CLI's code", () => {
    const text = scriptText("signin-provider.ps1");
    for (const def of OAUTH) {
      for (const agent of ["claude", "codex"] as const) {
        const [head, ...args] = tokenizeCatalogCommand(def.signInCommands![agent]);
        expect(head).toBe(agent);
        // The catalog's own command, with the detected entry where the catalog names the entry.
        expect(args).toEqual(["mcp", "login", def.id]);
      }
    }
    const sh = /^echo "(Opening your browser[^"]*)"$/m.exec(scriptText("signin-provider.sh"))![1];
    expect(text).toMatch(
      new RegExp(
        `Write-Host "${escapeRegExp(sh)}"\\n\\$loginArgs = @\\('mcp', 'login', '--', \\$Entry\\)\\n& \\$Cli @loginArgs\\nif \\(\\$\\?\\) \\{ exit 0 \\}\\nif \\(\\$LASTEXITCODE\\) \\{ exit \\$LASTEXITCODE \\}\\nexit 1\\n$`,
      ),
    );
  });
  it("remove-provider.ps1 runs the agent's remove with the detected scope, and clears a Codex key only after it succeeded and only when set", () => {
    const text = remove();
    expect(text).toContain("'claude' { $removeArgs = @('mcp', 'remove', '--scope', $Scope, '--', $Entry) }");
    expect(text).toContain("'codex'  { $removeArgs = @('mcp', 'remove', '--', $Entry) }");
    expect(text).toMatch(/& \$Cli @removeArgs\nif \(-not \$\?\) \{\n {2}if \(\$LASTEXITCODE\) \{ exit \$LASTEXITCODE \}\n {2}exit 1\n\}/);
    expect(text).toContain("$null -ne [Environment]::GetEnvironmentVariable($codexKeyEnv, 'User')");
    expect(text).toContain("[Environment]::SetEnvironmentVariable($codexKeyEnv, $null, 'User')");
    expect(text).toContain('Write-Host "Removed $codexKeyEnv from your Windows user environment. Restart libi and Codex so they stop using it."');
    expect(text.indexOf("& $Cli @removeArgs")).toBeLessThan(text.indexOf("SetEnvironmentVariable"));
  });
  it("remove-provider.ps1 signs out of a provider signed in to with an account before the remove, in the same words as remove-provider.sh, and a failed sign-out never stops the remove", () => {
    const code = codeLines(remove()).join("\n");
    const sh = [...scriptText("remove-provider.sh").matchAll(/"((?:Signing out of|Couldn't sign out of) \$name[^"]*)"/g)].map((m) => m[1]);
    expect(sh).toHaveLength(2);
    expect(code).toContain(
      `if ($auth -ceq 'oauth') {\n  Write-Host "${sh[0]}"\n  $logoutArgs = @('mcp', 'logout', '--', $Entry)\n  & $Cli @logoutArgs\n  if (-not $?) { Write-Host "${sh[1]}" }\n}`,
    );
    expect(code.indexOf("& $Cli @logoutArgs")).toBeLessThan(code.indexOf("& $Cli @removeArgs"));
  });

  it("remove-provider.ps1 resets $LASTEXITCODE right before the remove, so a remove that never started exits 1 and one that ran exits with its own code, never the sign-out's", () => {
    const code = codeLines(remove()).join("\n");
    // Global: a native command sets the global one, and a plain assignment would make a script-scope copy that the
    // check after the remove would read instead.
    expect(code).toMatch(
      /\n\$global:LASTEXITCODE = 0\n& \$Cli @removeArgs\nif \(-not \$\?\) \{\n {2}if \(\$LASTEXITCODE\) \{ exit \$LASTEXITCODE \}\n {2}exit 1\n\}/,
    );
    expect(code.indexOf("$global:LASTEXITCODE = 0")).toBeGreaterThan(code.indexOf("& $Cli @logoutArgs"));
    expect(code.match(/LASTEXITCODE = /g)).toHaveLength(1);
  });

  it("every .ps1 hands the agent's CLI a detected entry name after `--`, so a name that starts with `-` is never read as an option", () => {
    for (const name of ["remove-provider.ps1", "replace-provider.ps1", "signin-provider.ps1"]) {
      const lists = [...codeLines(scriptText(name)).join("\n").matchAll(/@\(([^)]*\$Entry[^)]*)\)/g)].map((m) => m[1]);
      expect(lists.length, name).toBeGreaterThan(0);
      for (const list of lists) expect(list, name).toMatch(/'--', \$Entry$/);
    }
  });

  it("replace-provider.ps1 finds add-provider.ps1 before removing, runs the add's text only if the remove worked, and never reports an add that stopped as success", () => {
    const text = replace();
    const code = codeLines(text).join("\n");
    expect(code).toContain("'claude' { $removeArgs = @('mcp', 'remove', '--scope', $Scope, '--', $Entry) }");
    expect(code).toContain("'codex'  { $removeArgs = @('mcp', 'remove', '--', $Entry) }");
    // A scriptblock has no folder: -ScriptsDir names it, and run as a file the script's own folder stands in.
    expect(code).toContain("if (-not $ScriptsDir) { $ScriptsDir = $PSScriptRoot }");
    expect(code).toContain("$addScript = if ($ScriptsDir) { [IO.Path]::Combine($ScriptsDir, 'add-provider.ps1') } else { '' }");
    expect(code.indexOf("Test-Path -LiteralPath $addScript -PathType Leaf")).toBeGreaterThan(-1);
    expect(code.indexOf("Test-Path -LiteralPath $addScript -PathType Leaf")).toBeLessThan(code.indexOf("& $Cli @removeArgs"));
    expect(code.indexOf("if (-not $?)")).toBeLessThan(code.indexOf("[scriptblock]::Create"));
    // The add's own `exit` ends the replace with its code; a terminating error, or getting past it at all, exits 1.
    expect(code).toMatch(
      /\ntry \{\n {2}& \(\[scriptblock\]::Create\(\[IO\.File\]::ReadAllText\(\$addScript\)\)\) \$Provider \$Agent \$Cli\n\} catch \{\n {2}\[Console\]::Error\.WriteLine\("replace-provider\.ps1: add-provider\.ps1 stopped: \$\(\$_\.Exception\.Message\)"\)\n {2}exit 1\n\}\nexit 1$/,
    );
    // The saved key is replaced by the add, never cleared by the remove.
    expect(text).not.toContain("SetEnvironmentVariable");
  });

  it("remove-provider.ps1 and replace-provider.ps1 accept only the user, local or project scope, with exit 2 before running anything", () => {
    for (const [name, text] of [["remove-provider.ps1", remove()], ["replace-provider.ps1", replace()]] as const) {
      const code = codeLines(text).join("\n");
      expect(code).toContain(
        `if ($Scope -and $Scope -cnotin @('user', 'local', 'project')) {\n  [Console]::Error.WriteLine("${name}: unknown scope '$Scope' (user, local or project)")\n  exit 2\n}`,
      );
      expect(code.indexOf("-cnotin @('user', 'local', 'project')")).toBeLessThan(code.indexOf("& $Cli @removeArgs"));
    }
  });

  it("each .ps1 header shows the exact command libi types for it, with placeholders, and no script runs another as a file", () => {
    const folder = "C:\\folder";
    const cli = { agentId: "claude-code" as const, realPath: "<cli>" };
    const entry = { agentId: "claude-code", name: "<entry>", scope: "user" } as const;
    const withPlaceholders = (line: string) =>
      line.replaceAll(folder, "<folder>").replace("'fal' 'claude' '<cli>'", "'<provider>' '<agent>' '<cli>'").replace(" 'user'", " ['<scope>']");
    const usage: Record<string, string> = {
      "add-provider.ps1": withPlaceholders(providerAddCommand(cli, "powershell", fal, folder)!),
      "remove-provider.ps1": withPlaceholders(providerRemoveCommand(cli, "powershell", entry, fal, folder)!),
      "replace-provider.ps1": withPlaceholders(providerReplaceCommand(cli, "powershell", fal, entry, folder)!),
      "signin-provider.ps1": withPlaceholders(providerSignInCommand(cli, "powershell", entry, higgsfield, folder)!).replace(
        "'higgsfield' 'claude' '<cli>'",
        "'<provider>' '<agent>' '<cli>'",
      ),
    };
    expect(usage["replace-provider.ps1"]).toMatch(/ '<entry>' \['<scope>'\] -ScriptsDir '<folder>'"$/);
    for (const [name, line] of Object.entries(usage)) {
      expect(scriptText(name).split("\n"), name).toContain(`#   ${line}`);
      expect(scriptText(name)).not.toMatch(/-File\b|ExecutionPolicy/);
      expect(codeLines(scriptText(name)).join("\n")).not.toMatch(/Join-Path|& \$addScript|\.ps1'\)? *\$Provider/);
    }
  });
});

/** A fake agent CLI that records each call's arguments, one per line, and exits with $FAKE_EXIT — or, for an `mcp logout`, with $FAKE_LOGOUT_EXIT when that is set. */
const RECORDING_CLI = `#!/bin/sh\n{ printf '%s\\n' "$@"; echo '--end--'; } >> "$0.argv"\n[ "$2" != logout ] || exit "\${FAKE_LOGOUT_EXIT:-\${FAKE_EXIT:-0}}"\nexit "\${FAKE_EXIT:-0}"\n`;
/** Every character a shell acts on, so a key that were ever re-parsed would come out changed. */
const TRICKY_KEY = 'sk-Q$1"b`c!d\\e*f;g';

// Each test spawns the real scripts once per provider and agent — about a second alone, and past the
// default 5 s under a loaded full run (seen once), so the suite gets a budget that matches the work.
describe.each(SCRIPT_SHELLS)("the provider scripts, run by %s, do exactly what the catalog says", { timeout: 30_000 }, (scriptShell) => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "libi-provider-scripts-"));
    home = path.join(root, "home");
    for (const dir of [home, path.join(root, "bin"), path.join(root, "sh-bin")]) mkdirSync(dir);
    for (const name of ["claude", "codex"]) {
      writeFileSync(path.join(root, "bin", name), RECORDING_CLI);
      chmodSync(path.join(root, "bin", name), 0o755);
    }
    // replace-provider.sh runs add-provider.sh with the `sh` on PATH: this one.
    symlinkSync(scriptShell, path.join(root, "sh-bin", "sh"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cliPath = (agent: string) => path.join(root, "bin", agent);
  const runScript = (name: string, args: string[], input = "", env: Record<string, string> = {}) => {
    const result = spawnSync(scriptShell, [scriptPath(name), ...args], {
      env: { HOME: home, SHELL: "/bin/bash", PATH: `${path.join(root, "sh-bin")}:/usr/bin:/bin`, NODE_ENV: "test", ...env },
      input,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(TRICKY_KEY);
    return result;
  };
  /** Each recorded call to the fake `agent`, as its argument list; cleared after reading. */
  const takeCalls = (agent: string) => {
    const file = `${cliPath(agent)}.argv`;
    if (!existsSync(file)) return [];
    const calls = readFileSync(file, "utf8").split("--end--\n").slice(0, -1).map((call) => call.split("\n").slice(0, -1));
    rmSync(file);
    return calls;
  };
  const addArgs = (def: (typeof WITH_COMMANDS)[number], agent: "claude" | "codex") => {
    const [head, ...args] = tokenizeCatalogCommand(def.commands![agent]);
    expect(head).toBe(agent);
    return args.map((token) => token.split(KEY_PLACEHOLDER).join(TRICKY_KEY));
  };
  const removeArgs = (agent: "claude" | "codex") =>
    agent === "claude" ? ["mcp", "remove", "--scope", "project", "--", "my-entry"] : ["mcp", "remove", "--", "my-entry"];
  const logoutArgs = ["mcp", "logout", "--", "my-entry"];
  const signOutLine = (def: (typeof WITH_COMMANDS)[number]) => `Signing out of ${def.name} first, so the sign-in isn't left stored.\n`;
  const signOutFailedLine = (def: (typeof WITH_COMMANDS)[number]) => `Couldn't sign out of ${def.name}; removing it anyway.\n`;
  const entryArgs = (agent: "claude" | "codex") => (agent === "claude" ? ["my-entry", "project"] : ["my-entry"]);
  const savedLine = (def: (typeof WITH_COMMANDS)[number]) => `export ${def.codexKeyEnv}='${TRICKY_KEY}' # ${def.name} key for Codex, added by libi\n`;

  it("add-provider runs the catalog's exact add command for every provider and agent, with the key read at the prompt where the placeholder is", () => {
    for (const def of WITH_COMMANDS) {
      for (const agent of ["claude", "codex"] as const) {
        rmSync(path.join(home, ".profile"), { force: true });
        const result = runScript("add-provider.sh", [def.id, agent, cliPath(agent)], `${TRICKY_KEY}\n`);
        expect(result.status, result.stderr).toBe(0);
        expect(takeCalls(agent)).toEqual([addArgs(def, agent)]);
        if (def.auth === "oauth") {
          // No key prompt: Codex's add starts the browser sign-in; Claude Code is told how to sign in after.
          expect(result.stdout).toBe(
            agent === "codex"
              ? `Codex adds ${def.name}, then opens your browser to sign in with your ${def.name} account. This waits here until you finish signing in.\n`
              : `Added. Now sign in with your ${def.name} account: click Sign in on libi's Providers tab, or open Claude Code, run /mcp, choose ${def.id}, then Authenticate.\n`,
          );
          expect(existsSync(path.join(home, ".profile"))).toBe(false);
        } else if (agent === "codex" && def.codexKeyEnv) {
          expect(result.stdout).toBe(`${def.name} key: \nSaved ${def.codexKeyEnv} in ${path.join(home, ".profile")}. Restart libi and Codex so they read it.\n`);
          expect(readFileSync(path.join(home, ".profile"), "utf8")).toBe(savedLine(def));
        } else {
          expect(result.stdout).toBe(`${def.name} key: \n`);
          expect(existsSync(path.join(home, ".profile"))).toBe(false);
        }
      }
    }
  });

  it("remove-provider signs out of a provider signed in to with an account first, then runs the agent's own remove with the detected name and Claude's detected scope, then a Codex key's cleanup", () => {
    for (const def of WITH_COMMANDS) {
      for (const agent of ["claude", "codex"] as const) {
        const result = runScript("remove-provider.sh", [def.id, agent, cliPath(agent), ...entryArgs(agent)]);
        expect(result.status, result.stderr).toBe(0);
        if (def.auth === "oauth") {
          // The sign-out comes BEFORE the remove: both agents look the stored sign-in up through the entry,
          // and answer "No MCP server named …" (exit 1) once it is gone.
          expect(takeCalls(agent)).toEqual([logoutArgs, removeArgs(agent)]);
          expect(result.stdout).toBe(signOutLine(def));
        } else {
          expect(takeCalls(agent)).toEqual([removeArgs(agent)]);
          expect(result.stdout).toBe(agent === "codex" && def.codexKeyEnv ? `No ${def.codexKeyEnv} line from libi was found.\n` : "");
        }
      }
    }
  });

  it("a sign-out that fails never turns a remove that worked into a failure", () => {
    for (const def of OAUTH) {
      for (const agent of ["claude", "codex"] as const) {
        const result = runScript("remove-provider.sh", [def.id, agent, cliPath(agent), ...entryArgs(agent)], "", { FAKE_LOGOUT_EXIT: "1" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`${signOutLine(def)}${signOutFailedLine(def)}`);
        expect(takeCalls(agent)).toEqual([logoutArgs, removeArgs(agent)]);
      }
    }
  });

  it("a remove that cannot start after a failed sign-out exits with the shell's own status for it, never the sign-out's code", () => {
    for (const def of OAUTH) {
      for (const agent of ["claude", "codex"] as const) {
        // The CLI is gone by the time the remove runs: the sign-out deletes it, then fails with its own code.
        const vanishing = path.join(root, "bin", `vanishing-${agent}`);
        writeFileSync(vanishing, '#!/bin/sh\nrm -f "$0"\nexit 5\n');
        chmodSync(vanishing, 0o755);
        const result = runScript("remove-provider.sh", [def.id, agent, vanishing, ...entryArgs(agent)]);
        expect(existsSync(vanishing)).toBe(false);
        expect(result.stdout).toBe(`${signOutLine(def)}${signOutFailedLine(def)}`);
        expect(result.status).toBe(127);
        expect(result.stderr).toMatch(/not found|No such file/i);
      }
    }
  });

  it("replace-provider removes the detected entry and then runs the catalog's add, keeping a saved Codex key for the add to replace", () => {
    for (const def of WITH_COMMANDS) {
      for (const agent of ["claude", "codex"] as const) {
        const result = runScript("replace-provider.sh", [def.id, agent, cliPath(agent), ...entryArgs(agent)], `${TRICKY_KEY}\n`);
        expect(result.status, result.stderr).toBe(0);
        expect(takeCalls(agent)).toEqual([removeArgs(agent), addArgs(def, agent)]);
        expect(result.stdout).not.toContain("Removed");
      }
    }
  });

  it("signin-provider runs the catalog's sign-in command with the detected name, says a browser opens, and exits with the CLI's status", () => {
    for (const def of OAUTH) {
      for (const agent of ["claude", "codex"] as const) {
        const [head, ...args] = tokenizeCatalogCommand(def.signInCommands![agent]);
        expect(head).toBe(agent);
        const result = runScript("signin-provider.sh", [def.id, agent, cliPath(agent), def.id]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`Opening your browser to sign in with your ${def.name} account. This waits here until you finish.\n`);
        // The catalog's sign-in command, with the detected name after `--`.
        expect(takeCalls(agent)).toEqual([[...args.slice(0, -1), "--", def.id]]);
        const renamed = runScript("signin-provider.sh", [def.id, agent, cliPath(agent), "my entry"], "", { FAKE_EXIT: "5" });
        expect(renamed.status).toBe(5);
        expect(takeCalls(agent)).toEqual([["mcp", "login", "--", "my entry"]]);
      }
    }
  });

  it("each script exits with the agent CLI's own status, and a failed remove stops before the prompt, the cleanup and the add", () => {
    for (const def of WITH_COMMANDS) {
      for (const agent of ["claude", "codex"] as const) {
        const removed = runScript("remove-provider.sh", [def.id, agent, cliPath(agent), ...entryArgs(agent)], "", { FAKE_EXIT: "3" });
        expect(removed.status).toBe(3);
        if (def.auth === "oauth") {
          expect(removed.stdout).toBe(`${signOutLine(def)}${signOutFailedLine(def)}`);
          expect(takeCalls(agent)).toEqual([logoutArgs, removeArgs(agent)]);
        } else {
          expect(removed.stdout).toBe("");
          expect(takeCalls(agent)).toEqual([removeArgs(agent)]);
        }

        const replaced = runScript("replace-provider.sh", [def.id, agent, cliPath(agent), ...entryArgs(agent)], `${TRICKY_KEY}\n`, { FAKE_EXIT: "3" });
        expect(replaced.status).toBe(3);
        expect(replaced.stdout).toBe("");
        expect(takeCalls(agent)).toEqual([removeArgs(agent)]);

        const added = runScript("add-provider.sh", [def.id, agent, cliPath(agent)], `${TRICKY_KEY}\n`, { FAKE_EXIT: "4" });
        expect(added.status).toBe(4);
        expect(takeCalls(agent)).toEqual([addArgs(def, agent)]);
      }
    }
  });

  it("every script refuses a provider it doesn't know, an unknown agent, or a missing argument with exit 2, before running anything", () => {
    for (const name of POSIX_SCRIPTS) {
      const signIn = name === "signin-provider.sh";
      // signin-provider knows only providers signed in to with an account; a keyed one is refused like an unknown one.
      const known = signIn ? "higgsfield" : "fal";
      const unknown = signIn ? ["nope", "fal", "elevenlabs", "Higgsfield"] : ["nope", "Fal", "higgsfield-x", "ace-step"];
      const cases: Array<[string[], RegExp]> = [
        ...unknown.map((id): [string[], RegExp] => [[id, "claude", cliPath("claude"), "x", "user"], /unknown provider/]),
        [[known, "gemini", cliPath("claude"), "x", "user"], /unknown agent/],
        [[known, "claude"], /usage/],
      ];
      if (signIn) cases.push([[known, "claude", cliPath("claude")], /usage/]);
      else if (name !== "add-provider.sh") cases.push([[known, "claude", cliPath("claude"), "fal-ai"], /usage/]);
      for (const [args, message] of cases) {
        const result = runScript(name, args, `${TRICKY_KEY}\n`);
        expect(result.status, `${name} ${args.join(" ")}`).toBe(2);
        expect(result.stderr).toMatch(message);
        expect(result.stdout).toBe("");
        expect(takeCalls("claude")).toEqual([]);
      }
    }
  });

  it("remove-provider and replace-provider accept only the user, local or project scope, with exit 2 before running anything", () => {
    for (const name of ["remove-provider.sh", "replace-provider.sh"]) {
      for (const [agent, scope] of [["claude", "global"], ["claude", "User"], ["claude", "user;x"], ["codex", "--all"]] as const) {
        const result = runScript(name, ["fal", agent, cliPath(agent), "fal-ai", scope], `${TRICKY_KEY}\n`);
        expect(result.status, `${name} ${agent} ${scope}`).toBe(2);
        expect(result.stderr).toBe(`${name}: unknown scope '${scope}' (user, local or project)\n`);
        expect(result.stdout).toBe("");
        expect(takeCalls(agent)).toEqual([]);
      }
      for (const scope of ["user", "local", "project"]) {
        const result = runScript(name, ["elevenlabs", "claude", cliPath("claude"), "elevenlabs", scope], `${TRICKY_KEY}\n`);
        expect(result.status, result.stderr).toBe(0);
        expect(takeCalls("claude")[0]).toEqual(["mcp", "remove", "--scope", scope, "--", "elevenlabs"]);
      }
    }
  });

  it("a detected name that starts with `-` reaches the agent's CLI after `--`, so it is never read as an option", () => {
    // Both CLIs refuse such a name without `--` (claude 2.1.245: "unknown option '-x'"; codex 0.153.4: "unexpected
    // argument '-x' found") and take it as the name after `--`, for remove, logout and login alike.
    for (const name of ["-x", "--help", "--scope"]) {
      for (const agent of ["claude", "codex"] as const) {
        const target = agent === "claude" ? [name, "user"] : [name];
        const removeCall = agent === "claude" ? ["mcp", "remove", "--scope", "user", "--", name] : ["mcp", "remove", "--", name];
        for (const def of WITH_COMMANDS) {
          const removed = runScript("remove-provider.sh", [def.id, agent, cliPath(agent), ...target]);
          expect(removed.status, removed.stderr).toBe(0);
          expect(takeCalls(agent)).toEqual(def.auth === "oauth" ? [["mcp", "logout", "--", name], removeCall] : [removeCall]);
          const replaced = runScript("replace-provider.sh", [def.id, agent, cliPath(agent), ...target], `${TRICKY_KEY}\n`);
          expect(replaced.status, replaced.stderr).toBe(0);
          expect(takeCalls(agent)[0]).toEqual(removeCall);
        }
        for (const def of OAUTH) {
          const signedIn = runScript("signin-provider.sh", [def.id, agent, cliPath(agent), name]);
          expect(signedIn.status, signedIn.stderr).toBe(0);
          expect(takeCalls(agent)).toEqual([["mcp", "login", "--", name]]);
        }
      }
    }
  });

  it("every script hands the agent's CLI no ZDOTDIR when libi passed an empty one, and the user's own when one was set", () => {
    const cli = path.join(root, "bin", "zdotdir-cli");
    writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "\${ZDOTDIR-(unset)}" >> "$0.log"\n`);
    chmodSync(cli, 0o755);
    const zdotdir = path.join(root, "zdot");
    mkdirSync(zdotdir);
    const seen = () => {
      const text = readFileSync(`${cli}.log`, "utf8");
      rmSync(`${cli}.log`);
      return text;
    };
    const cases: Array<[Record<string, string>, string]> = [[{ ZDOTDIR: "" }, "(unset)"], [{}, "(unset)"], [{ ZDOTDIR: zdotdir }, zdotdir]];
    for (const [env, expected] of cases) {
      for (const agent of ["claude", "codex"] as const) {
        const entry = agent === "claude" ? ["fal-ai", "user"] : ["fal-ai"];
        const added = runScript("add-provider.sh", ["fal", agent, cli], "sk-zdotdir\n", env);
        expect(added.status, added.stderr).toBe(0);
        expect(seen()).toBe(`${expected}\n`);
        const removed = runScript("remove-provider.sh", ["fal", agent, cli, ...entry], "", env);
        expect(removed.status, removed.stderr).toBe(0);
        expect(seen()).toBe(`${expected}\n`);
        const replaced = runScript("replace-provider.sh", ["fal", agent, cli, ...entry], "sk-zdotdir\n", env);
        expect(replaced.status, replaced.stderr).toBe(0);
        expect(seen()).toBe(`${expected}\n${expected}\n`);
        const signedIn = runScript("signin-provider.sh", ["higgsfield", agent, cli, "higgsfield"], "", env);
        expect(signedIn.status, signedIn.stderr).toBe(0);
        expect(seen()).toBe(`${expected}\n`);
      }
    }
  });
});

describe.each(SCRIPT_SHELLS)("the hidden key prompt, run by %s", (scriptShell) => {
  let root: string;
  const log = () => path.join(root, "stty.log");
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "libi-key-prompt-"));
    mkdirSync(path.join(root, "bin"));
    // A terminal's `stty`, where a test can see what was asked of it.
    writeFileSync(
      path.join(root, "bin", "stty"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(root, "stty.log")}'\n[ "$1" = -g ] && echo saved-state\nexit 0\n`,
    );
    writeFileSync(path.join(root, "bin", "codex"), RECORDING_CLI);
    writeFileSync(path.join(root, "bin", "claude"), RECORDING_CLI);
    for (const name of ["stty", "codex", "claude"]) chmodSync(path.join(root, "bin", name), 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  // `NODE_ENV` only satisfies the env type; shells ignore it.
  const env = (): NodeJS.ProcessEnv => ({ HOME: root, SHELL: "/bin/bash", PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, NODE_ENV: "test" });

  it("turns typing echo off for the key and back on right after it, before the add runs", () => {
    const result = spawnSync(scriptShell, [scriptPath("add-provider.sh"), "elevenlabs", "claude", path.join(root, "bin", "claude")], {
      env: env(),
      input: "sk-prompt-key\n",
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("ElevenLabs key: \n");
    expect(readFileSync(log(), "utf8")).toBe("-g\n-echo\nsaved-state\n");
    expect(readFileSync(path.join(root, "bin", "claude.argv"), "utf8")).toContain("\nELEVENLABS_API_KEY=sk-prompt-key\n");
  });

  it("Ctrl-C at the prompt ends the prompt's line, turns echo back on, exits 130, and saves and adds nothing", async () => {
    const child = spawn(scriptShell, [scriptPath("add-provider.sh"), "fal", "codex", path.join(root, "bin", "codex")], {
      env: env(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    await waitUntil(() => existsSync(log()) && readFileSync(log(), "utf8").includes("-echo\n"), 10_000);
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    // The newline, so the shell's next prompt is not drawn after `fal.ai key: `.
    expect(stdout).toBe("fal.ai key: \n");
    expect(readFileSync(log(), "utf8")).toBe("-g\n-echo\nsaved-state\n");
    expect(existsSync(path.join(root, "bin", "codex.argv"))).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
  }, 20_000);
});

/**
 * The saved-key scripts run for real, the way the product runs them: the TYPED command the builder makes is handed
 * to bash (and zsh where it exists) under a temp HOME, with a fake `codex`, both with `-c` and with `-ic`, and the
 * `sh` it calls is each POSIX sh on the machine. The setup terminal is an INTERACTIVE shell, which reads the user's
 * rc file — aliases and functions included — so `-ic` is the mode that matches the product. On macOS this exercises
 * BSD sed/grep, on CI GNU: the scripts must work with both. A key given on stdin never appears in anything printed.
 */
const SHELLS = ["/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell));
const MODES = ["-c", "-ic"] as const;
const VARIANTS = SHELLS.flatMap((shell) => MODES.flatMap((mode) => SCRIPT_SHELLS.map((scriptShell) => [shell, mode, scriptShell] as const)));
const MARKER = "# fal.ai key for Codex, added by libi";
const OTHER_LINES = 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -l"\n';
const libiLine = (key: string) => `export FAL_KEY='${key}' ${MARKER}\n`;
const NONE_FOUND = "No FAL_KEY line from libi was found.\n";
const removedFrom = (file: string) => `Removed FAL_KEY from ${file}. Restart libi and Codex so they stop using it.\n`;
const couldntRead = (file: string) => `Couldn't read ${file}; it may still hold a FAL_KEY line from libi.\n`;
/** Variables the typed commands once set in the user's shell, the scripts' own names, and ZDOTDIR, which the line passes. */
const COMMAND_VARIABLES = [
  "libi_key", "libi_marker", "libi_cr", "libi_shell", "libi_profile", "libi_tmp", "libi_saved", "libi_umask", "libi_found", "libi_failed",
  "K", "M", "P", "Q", "S", "U", "F",
  "provider", "agent", "cli", "entry", "scope", "name", "key", "codex_key_env", "marker", "cr", "profile", "tmp", "saved", "failed", "found",
  "candidate", "shell_name", "user_umask", "tty_state", "ZDOTDIR",
];
/**
 * zsh global aliases expand wherever the word stands, not only in command position. oh-my-zsh's common-aliases
 * defines `P` and `K` exactly so; every old variable name the commands used gets one too.
 */
const GLOBAL_ALIAS_RC = [
  "alias -g P='2>&1| pygmentize -l pytb'",
  "alias -g K='| less'",
  ...COMMAND_VARIABLES.filter((name) => /^(?:libi_|[A-Z]$)/.test(name) && name !== "P" && name !== "K").map((name) => `alias -g ${name}='| command cat -n'`),
].join("\n");
/** Files an interactive shell's own setup may leave in HOME; never something the commands made. */
const SHELL_SETUP_FILES = [".zshrc", ".bashrc", ".zsh_history", ".bash_history"];
/**
 * A user's rc that replaces every external tool the scripts use, each with an
 * alias or a function that would corrupt the profile or the output if it ran.
 */
const HIJACKING_RC = [
  'alias cat="cat -n"',
  'alias sed="sed -n"',
  'alias wc="wc -c"',
  'alias rm="echo hijacked rm"',
  "grep() { echo hijacked; }",
  "tail() { echo hijacked; }",
  "tr() { echo hijacked; }",
  "touch() { echo hijacked; }",
  "mv() { echo hijacked; }",
  "od() { echo hijacked; }",
].join("\n");

describe.each(VARIANTS)(
  "the saved-key profile line, typed into %s %s, scripts run by %s",
  (shell, mode, scriptShell) => {
    const zsh = shell.endsWith("zsh");
    let root: string;
    let home: string;
    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), "libi-saved-key-"));
      home = path.join(root, "home");
      mkdirSync(home);
      mkdirSync(path.join(root, "bin"));
      mkdirSync(path.join(root, "sh-bin"));
      symlinkSync(scriptShell, path.join(root, "sh-bin", "sh"));
      for (const [name, body] of [["codex", "exit 0"], ["codex-fail", "exit 1"], ["claude-args", `printf '%s\\n' "$@" > "$0.args"`]] as const) {
        writeFileSync(path.join(root, "bin", name), `#!/bin/sh\n${body}\n`);
        chmodSync(path.join(root, "bin", name), 0o755);
      }
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    /** The profile this shell reads when every candidate exists. */
    const profile = () => path.join(home, zsh ? ".zprofile" : ".bash_profile");
    const cli = (ok = true) => ({ agentId: "codex" as const, realPath: path.join(root, "bin", ok ? "codex" : "codex-fail") });
    const removeCmd = (ok = true) => providerRemoveCommand(cli(ok), "posix", { agentId: "codex", name: "fal-ai" }, fal, SCRIPTS_DIR)!;
    const replaceCmd = (ok = true) => providerReplaceCommand(cli(ok), "posix", fal, { agentId: "codex", name: "fal-ai" }, SCRIPTS_DIR)!;
    const addCmd = (ok = true) => providerAddCommand(cli(ok), "posix", fal, SCRIPTS_DIR)!;
    /**
     * A bare environment — nothing inherited from the test run (`NODE_ENV` only
     * satisfies the env type; shells ignore it). `rc` is the user's own shell
     * setup: under `-ic` their rc file (always written, so zsh never starts its
     * new-user setup), under `-c`, which reads no rc, the head of the command.
     * `pathPrefix` goes in front of PATH, whose `sh` is the one under test.
     */
    const run = (command: string, input = "", opts: { rc?: string; env?: Record<string, string>; pathPrefix?: string } = {}) => {
      if (mode === "-ic") {
        const rcDir = zsh ? (opts.env?.ZDOTDIR ?? home) : home;
        writeFileSync(path.join(rcDir, zsh ? ".zshrc" : ".bashrc"), `${opts.rc ?? ""}\n`);
      }
      const line = mode === "-c" && opts.rc ? `${opts.rc}\n${command}` : command;
      const PATH = [opts.pathPrefix, path.join(root, "sh-bin"), "/usr/bin:/bin"].filter(Boolean).join(":");
      const result = spawnSync(shell, [mode, line], {
        env: { HOME: home, SHELL: shell, PATH, NODE_ENV: "test", ...opts.env },
        input,
        encoding: "utf8",
        // A command the shell mis-parses can wait on its input forever; fail the test instead.
        timeout: 20_000,
      });
      const key = input.trim();
      if (key.length >= 6) expect(`${result.stdout}${result.stderr}`).not.toContain(key);
      return result;
    };
    /** Backdates `file` (through a link) and reports whether anything wrote it since. */
    const watchWrites = (file: string) => {
      const past = new Date("2020-01-01T00:00:00Z");
      utimesSync(file, past, past);
      return () => statSync(file).mtimeMs !== past.getTime();
    };
    const leftovers = (dir = home) => readdirSync(dir).filter((name) => name.includes("libi-"));
    const userFiles = () => readdirSync(home).filter((name) => !SHELL_SETUP_FILES.includes(name));
    const mode600 = (file: string) => (statSync(file).mode & 0o777).toString(8);
    /** A directory holding a stand-in for `tool`, to put in front of PATH. */
    const withTool = (tool: string, body: string) => {
      const dir = path.join(root, `tool-${tool}-${body.length}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, tool), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(dir, tool), 0o755);
      return dir;
    };

    it("removes only the libi line, says so, and leaves every other byte as it was", () => {
      writeFileSync(profile(), `${OTHER_LINES}${libiLine("fal-secret")}export EDITOR=vim\n`);
      const result = run(removeCmd());
      expect(result.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}export EDITOR=vim\n`);
      expect(result.stdout).toBe(removedFrom(profile()));
      expect(leftovers()).toEqual([]);
    });

    it("a profile saved with CRLF line endings: Add replaces libi's line instead of adding a second, Remove finds it, and every other line keeps its CRLF", () => {
      const crlf = (text: string) => text.replace(/\n/g, "\r\n");
      // A CR that is not the last byte before the newline does not end the line: that line is the user's, and stays.
      const crMidLine = `export X=1 ${MARKER}\rstill this line\r\n`;
      const before = `${crlf(OTHER_LINES)}${crlf(libiLine("fal-old"))}${crMidLine}export EDITOR=vim\r\n`;
      const others = `${crlf(OTHER_LINES)}${crMidLine}export EDITOR=vim\r\n`;
      const dotProfile = path.join(home, ".profile");
      writeFileSync(profile(), before);
      // An older CRLF libi line in another candidate is found by the add's walk as well.
      writeFileSync(dotProfile, `${crlf(OTHER_LINES)}${crlf(libiLine("fal-older"))}`);

      const added = run(addCmd(), "fal-new\n");
      expect(added.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${others}${libiLine("fal-new")}`);
      expect(readFileSync(dotProfile, "utf8")).toBe(crlf(OTHER_LINES));
      expect(added.stdout).toContain(`Removed an older FAL_KEY line from ${dotProfile}.\n`);

      writeFileSync(profile(), before);
      const removed = run(removeCmd());
      expect(removed.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(others);
      expect(removed.stdout).toBe(removedFrom(profile()));
      expect(run(removeCmd()).stdout).toBe(NONE_FOUND);
      expect(leftovers()).toEqual([]);
    });

    /**
     * A `uname` on PATH that names `system`, so the platform is pinned whatever machine runs the test. The command
     * starts with `unset SHELL`: bash fills a missing SHELL from the passwd entry at startup, while zsh — the setup
     * terminal on macOS — leaves it unset, which is the case these tests are about. (macOS's `sh` is bash too, and
     * fills it in again without exporting it: the script reads the one it was passed.)
     */
    const withUname = (system: string) => withTool("uname", `echo ${system}`);

    it("with SHELL unset on macOS, Add writes zsh's .zprofile — the setup terminal's shell there — and a uname function in the user's setup changes nothing", () => {
      const darwin = withUname("Darwin");
      writeFileSync(path.join(home, ".bash_profile"), OTHER_LINES);
      const result = run(`unset SHELL; ${addCmd()}`, "sk-mac-key\n", { pathPrefix: darwin, rc: "uname() { echo Linux; }" });
      expect(result.status).toBe(0);
      expect(readFileSync(path.join(home, ".zprofile"), "utf8")).toBe(libiLine("sk-mac-key"));
      expect(result.stdout).toContain(`Saved FAL_KEY in ${path.join(home, ".zprofile")}. `);
      expect(readFileSync(path.join(home, ".bash_profile"), "utf8")).toBe(OTHER_LINES);
      expect(existsSync(path.join(home, ".profile"))).toBe(false);

      const removed = run(`unset SHELL; ${removeCmd()}`, "", { pathPrefix: darwin });
      expect(removed.stdout).toBe(removedFrom(path.join(home, ".zprofile")));
    });

    it("with SHELL unset elsewhere, Add follows bash's own order — the setup terminal's shell there", () => {
      const linux = withUname("Linux");
      writeFileSync(path.join(home, ".bash_login"), OTHER_LINES);
      const result = run(`unset SHELL; ${addCmd()}`, "sk-linux-key\n", { pathPrefix: linux });
      expect(result.status).toBe(0);
      expect(readFileSync(path.join(home, ".bash_login"), "utf8")).toBe(`${OTHER_LINES}${libiLine("sk-linux-key")}`);
      expect(existsSync(path.join(home, ".zprofile"))).toBe(false);
      expect(existsSync(path.join(home, ".profile"))).toBe(false);
    });

    it("under a UTF-8 locale, an invalid UTF-8 byte elsewhere in the profile doesn't block Remove or Add — the scan runs in a byte locale", () => {
      // `printf 'export X=\xff\n'`: a lone 0xFF is not valid UTF-8 anywhere in that position.
      const invalidUtf8Line = Buffer.from("export X=\xff\n", "latin1");
      const utf8Env = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
      const before = Buffer.concat([Buffer.from(OTHER_LINES), invalidUtf8Line, Buffer.from(libiLine("fal-secret"))]);
      writeFileSync(profile(), before);

      const removed = run(removeCmd(), "", { env: utf8Env });
      expect(removed.status).toBe(0);
      expect(readFileSync(profile()).equals(Buffer.concat([Buffer.from(OTHER_LINES), invalidUtf8Line]))).toBe(true);
      expect(removed.stdout).toBe(removedFrom(profile()));

      writeFileSync(profile(), Buffer.concat([Buffer.from(OTHER_LINES), invalidUtf8Line, Buffer.from(libiLine("old-secret"))]));
      const added = run(addCmd(), "new-secret\n", { env: utf8Env });
      expect(added.status).toBe(0);
      expect(
        readFileSync(profile()).equals(Buffer.concat([Buffer.from(OTHER_LINES), invalidUtf8Line, Buffer.from(libiLine("new-secret"))])),
      ).toBe(true);
      expect(leftovers()).toEqual([]);
    });

    it("edits a symlinked profile through the link: the link stays, its target loses only the libi line", () => {
      mkdirSync(path.join(root, "dotfiles"));
      const target = path.join(root, "dotfiles", "profile");
      writeFileSync(target, `${OTHER_LINES}${libiLine("old")}`);
      symlinkSync(target, profile());

      const added = run(addCmd(), "new-key\n");
      expect(added.status).toBe(0);
      expect(lstatSync(profile()).isSymbolicLink()).toBe(true);
      expect(readlinkSync(profile())).toBe(target);
      expect(readFileSync(target, "utf8")).toBe(`${OTHER_LINES}${libiLine("new-key")}`);

      const removed = run(removeCmd());
      expect(removed.status).toBe(0);
      expect(removed.stdout).toBe(removedFrom(profile()));
      expect(lstatSync(profile()).isSymbolicLink()).toBe(true);
      expect(readlinkSync(profile())).toBe(target);
      expect(readFileSync(target, "utf8")).toBe(OTHER_LINES);
      expect(leftovers()).toEqual([]);
      expect(leftovers(path.join(root, "dotfiles"))).toEqual([]);
    });

    it("empties a profile that held only the libi line", () => {
      writeFileSync(profile(), libiLine("k"));
      const result = run(removeCmd());
      expect(result.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe("");
      expect(result.stdout).toBe(removedFrom(profile()));
    });

    it("marker text in the middle of a line: nothing removed or rewritten, and it says no line was found", () => {
      const content = `${OTHER_LINES}echo "${MARKER}" >> notes.txt\n`;
      writeFileSync(profile(), content);
      const written = watchWrites(profile());
      const removed = run(removeCmd());
      expect(removed.status).toBe(0);
      expect(removed.stdout).toBe(NONE_FOUND);
      expect(readFileSync(profile(), "utf8")).toBe(content);
      expect(written()).toBe(false);
    });

    it("a profile without a libi line is not rewritten, and Remove says no line was found", () => {
      writeFileSync(profile(), OTHER_LINES);
      const written = watchWrites(profile());
      const result = run(removeCmd());
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(NONE_FOUND);
      expect(readFileSync(profile(), "utf8")).toBe(OTHER_LINES);
      expect(written()).toBe(false);
    });

    it("no profile at all: nothing is created, and Remove says no line was found", () => {
      expect(run(removeCmd()).stdout).toBe(NONE_FOUND);
      expect(userFiles()).toEqual([]);
    });

    it("a failed `codex mcp remove` leaves the profile untouched and says nothing about the key", () => {
      writeFileSync(profile(), `${OTHER_LINES}${libiLine("k")}`);
      const written = watchWrites(profile());
      const result = run(removeCmd(false));
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(written()).toBe(false);
    });

    it("Replace keeps the saved line through its remove and saves the new key; a failed remove skips the prompt, the save and the add", () => {
      writeFileSync(profile(), `${OTHER_LINES}${libiLine("sk-old-replace")}`);
      const replaced = run(replaceCmd(), "sk-new-replace\n");
      expect(replaced.status).toBe(0);
      expect(replaced.stdout).toBe(`fal.ai key: \nSaved FAL_KEY in ${profile()}. Restart libi and Codex so they read it.\n`);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}${libiLine("sk-new-replace")}`);

      const written = watchWrites(profile());
      const failed = run(replaceCmd(false), "sk-never-read\n");
      expect(failed.status).not.toBe(0);
      expect(failed.stdout).toBe("");
      expect(written()).toBe(false);
      expect(leftovers()).toEqual([]);
    });

    it("adding twice leaves one libi line, holding the latest key", () => {
      writeFileSync(profile(), OTHER_LINES);
      expect(run(addCmd(), "first-key\n").status).toBe(0);
      expect(run(addCmd(), "second-key\n").status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}${libiLine("second-key")}`);
      expect(leftovers()).toEqual([]);
    });

    it("the add exits with the agent CLI's status once the key is saved", () => {
      writeFileSync(profile(), OTHER_LINES);
      const result = run(addCmd(false), "sk-exit-key\n");
      expect(result.status).toBe(1);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}${libiLine("sk-exit-key")}`);
    });

    it("an empty key, or one holding a quote, is refused: nothing saved, nothing added, exit 1", () => {
      writeFileSync(profile(), OTHER_LINES);
      const written = watchWrites(profile());
      for (const input of ["\n", "sk-it's-mine\n"]) {
        const result = run(addCmd(), input);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("fal.ai key: \nNothing saved: the key is empty or contains a quote.\n");
      }
      expect(written()).toBe(false);
    });

    it("adding to a profile whose last line has no newline ends that line first", () => {
      writeFileSync(profile(), `${OTHER_LINES}export LAST=1`);
      const result = run(addCmd(), "sk-last-key\n");
      expect(result.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}export LAST=1\n${libiLine("sk-last-key")}`);
    });

    it("replacing the libi line in a profile that then ends without a newline keeps the last line whole", () => {
      writeFileSync(profile(), `${OTHER_LINES}${libiLine("old")}export LAST=1`);
      const result = run(addCmd(), "sk-new-key\n");
      expect(result.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}export LAST=1\n${libiLine("sk-new-key")}`);
      expect(leftovers()).toEqual([]);
    });

    it("an empty profile gets the libi line with no blank line before it", () => {
      writeFileSync(profile(), "");
      expect(run(addCmd(), "sk-empty-key\n").status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(libiLine("sk-empty-key"));
    });

    it("with noclobber set, adding still creates a missing profile, and Remove still creates none", () => {
      const rc = zsh ? "setopt noclobber" : "set -o noclobber";
      // With no profile at all, bash's resolution falls through to `.profile`.
      const created = path.join(home, zsh ? ".zprofile" : ".profile");
      expect(run(removeCmd(), "", { rc }).stdout).toBe(NONE_FOUND);
      expect(userFiles()).toEqual([]);
      const result = run(addCmd(), "sk-noclobber\n", { rc });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Saved FAL_KEY in ${created}.`);
      expect(readFileSync(created, "utf8")).toBe(libiLine("sk-noclobber"));
    });

    it("the user's aliases and shell functions for cat, sed, grep, tail, wc, tr, rm and touch change nothing that is written or said", () => {
      const rc = HIJACKING_RC;
      writeFileSync(profile(), `${OTHER_LINES}${libiLine("old")}export LAST=1`);

      const added = run(addCmd(), "sk-hijack-new\n", { rc });
      expect(added.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}export LAST=1\n${libiLine("sk-hijack-new")}`);
      expect(added.stdout).toBe(`fal.ai key: \nSaved FAL_KEY in ${profile()}. Restart libi and Codex so they read it.\n`);
      expect(leftovers()).toEqual([]);

      const removed = run(removeCmd(), "", { rc });
      expect(removed.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}export LAST=1\n`);
      expect(removed.stdout).toBe(removedFrom(profile()));
      expect(leftovers()).toEqual([]);

      const written = watchWrites(profile());
      const again = run(removeCmd(), "", { rc });
      expect(again.stdout).toBe(NONE_FOUND);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}export LAST=1\n`);
      expect(written()).toBe(false);
      expect(`${added.stderr}${removed.stderr}${again.stderr}`).not.toContain("hijacked");
    });

    // Only an rc file sets one up: in zsh 5.9, an alias defined earlier in the same `-c` string did not apply to the command.
    it.skipIf(!zsh || mode === "-c")("zsh global aliases named like every variable the commands once used change nothing that is written or said", () => {
      const rc = GLOBAL_ALIAS_RC;
      const dotProfile = path.join(home, ".profile");
      writeFileSync(profile(), `${OTHER_LINES}${libiLine("old")}export LAST=1`);
      writeFileSync(dotProfile, `${OTHER_LINES}${libiLine("older")}`);

      const added = run(addCmd(), "sk-alias-new\n", { rc });
      expect(added.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}export LAST=1\n${libiLine("sk-alias-new")}`);
      expect(readFileSync(dotProfile, "utf8")).toBe(OTHER_LINES);
      expect(added.stdout).toBe(
        `fal.ai key: \nSaved FAL_KEY in ${profile()}. Restart libi and Codex so they read it.\nRemoved an older FAL_KEY line from ${dotProfile}.\n`,
      );
      expect(leftovers()).toEqual([]);

      const removed = run(removeCmd(), "", { rc });
      expect(removed.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}export LAST=1\n`);
      expect(removed.stdout).toBe(removedFrom(profile()));
      const again = run(removeCmd(), "", { rc });
      expect(again.status).toBe(0);
      expect(again.stdout).toBe(NONE_FOUND);
      expect(leftovers()).toEqual([]);

      // The hidden-prompt add reads its key the same way.
      const claudeArgs = { agentId: "claude-code" as const, realPath: path.join(root, "bin", "claude-args") };
      const viaClaude = run(providerAddCommand(claudeArgs, "posix", fal, SCRIPTS_DIR)!, "fal-secret\n", { rc });
      expect(viaClaude.status).toBe(0);
      expect(readFileSync(`${claudeArgs.realPath}.args`, "utf8")).toContain("\nAuthorization: Bearer fal-secret\n");
    });

    // zsh keeps a ZDOTDIR set without `export` to itself; the typed line hands it to the script.
    it.skipIf(!zsh)("a ZDOTDIR the user's zsh sets without export still decides where the key is saved and removed", () => {
      const zdotdir = path.join(root, "zdot");
      mkdirSync(zdotdir);
      const rc = `ZDOTDIR='${zdotdir}'`;
      const added = run(addCmd(), "sk-zdotdir-key\n", { rc });
      expect(added.status).toBe(0);
      expect(readFileSync(path.join(zdotdir, ".zprofile"), "utf8")).toBe(libiLine("sk-zdotdir-key"));
      expect(existsSync(path.join(home, ".zprofile"))).toBe(false);
      const removed = run(removeCmd(), "", { rc });
      expect(removed.stdout).toBe(removedFrom(path.join(zdotdir, ".zprofile")));
    });

    // chmod does not stop root, so an unreadable or unwritable profile cannot be staged there.
    it.skipIf(process.getuid?.() === 0)("Remove names a profile it can't read instead of saying no line was found, still cleans the rest, and exits 1", () => {
      const dotProfile = path.join(home, ".profile");
      writeFileSync(dotProfile, `${OTHER_LINES}${libiLine("fal-secret")}`);
      chmodSync(dotProfile, 0o000);
      try {
        const alone = run(removeCmd());
        expect(alone.status).toBe(1);
        expect(alone.stdout).toBe("");
        expect(alone.stderr).toContain(couldntRead(dotProfile));

        writeFileSync(profile(), `${OTHER_LINES}${libiLine("fal-secret")}`);
        const withAnother = run(removeCmd());
        expect(withAnother.status).toBe(1);
        expect(withAnother.stdout).toBe(removedFrom(profile()));
        expect(withAnother.stderr).toContain(couldntRead(dotProfile));
        expect(`${alone.stderr}${withAnother.stdout}${withAnother.stderr}`).not.toContain("fal-secret");
        expect(readFileSync(profile(), "utf8")).toBe(OTHER_LINES);
      } finally {
        chmodSync(dotProfile, 0o600);
      }
      expect(readFileSync(dotProfile, "utf8")).toBe(`${OTHER_LINES}${libiLine("fal-secret")}`);
      expect(leftovers()).toEqual([]);
    });

    it.skipIf(process.getuid?.() === 0)("Remove goes on past a profile it can't write: it cleans the rest, names the failure and its private kept copy, and exits 1", () => {
      const dotProfile = path.join(home, ".profile");
      const content = `${OTHER_LINES}${libiLine("fal-secret")}`;
      writeFileSync(profile(), content);
      chmodSync(profile(), 0o444);
      writeFileSync(dotProfile, content);
      const copy = `${profile()}.libi-tmp`;

      const result = run(removeCmd(), "", { rc: "umask 022" });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe(removedFrom(dotProfile));
      expect(result.stderr).toContain(`Could not write ${profile()}. The complete edited copy is in ${copy}.`);
      expect(`${result.stdout}${result.stderr}`).not.toContain("fal-secret");
      expect(readFileSync(profile(), "utf8")).toBe(content);
      expect(readFileSync(dotProfile, "utf8")).toBe(OTHER_LINES);
      expect(readFileSync(copy, "utf8")).toBe(OTHER_LINES);
      expect(mode600(copy)).toBe("600");
    });

    it.skipIf(process.getuid?.() === 0)("adding names another candidate it can't read, and stops before the add with the new line saved", () => {
      const dotProfile = path.join(home, ".profile");
      writeFileSync(profile(), OTHER_LINES);
      writeFileSync(dotProfile, `${OTHER_LINES}${libiLine("old")}`);
      chmodSync(dotProfile, 0o000);
      try {
        const result = run(addCmd(), "sk-candidate-new\n");
        // The fake codex exits 0, so 1 means the add never ran.
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(`Saved FAL_KEY in ${profile()}.`);
        expect(result.stderr).toContain(couldntRead(dotProfile));
        expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}${libiLine("sk-candidate-new")}`);
      } finally {
        chmodSync(dotProfile, 0o600);
      }
    });

    it("Remove drops the libi line from every login profile the shell could read, not only the one it reads now", () => {
      const zdotdir = path.join(root, "zdot");
      mkdirSync(zdotdir);
      const withLine = [path.join(zdotdir, ".zprofile"), path.join(home, ".zprofile"), path.join(home, ".bash_profile"), path.join(home, ".profile")];
      for (const file of withLine) writeFileSync(file, `${OTHER_LINES}${libiLine("k")}`);
      const bashLogin = path.join(home, ".bash_login");
      writeFileSync(bashLogin, OTHER_LINES);
      const bashLoginWritten = watchWrites(bashLogin);

      const result = run(removeCmd(), "", { env: { ZDOTDIR: zdotdir } });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(withLine.map(removedFrom).join(""));
      for (const file of withLine) expect(readFileSync(file, "utf8")).toBe(OTHER_LINES);
      expect(bashLoginWritten()).toBe(false);
      expect(leftovers()).toEqual([]);
      expect(leftovers(zdotdir)).toEqual([]);
    });

    it("Remove names a profile once when ZDOTDIR is HOME", () => {
      writeFileSync(path.join(home, ".zprofile"), `${OTHER_LINES}${libiLine("k")}`);
      const result = run(removeCmd(), "", { env: { ZDOTDIR: home } });
      expect(result.stdout).toBe(removedFrom(path.join(home, ".zprofile")));
    });

    it("adding after the shell's profile choice changed writes the profile it reads now and drops the older line everywhere else", () => {
      writeFileSync(profile(), OTHER_LINES);
      const others = [zsh ? ".bash_profile" : ".zprofile", ".bash_login", ".profile"].map((name) => path.join(home, name));
      for (const file of others) writeFileSync(file, `${OTHER_LINES}${libiLine("old")}`);

      const result = run(addCmd(), "sk-choice-new\n");
      expect(result.status).toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}${libiLine("sk-choice-new")}`);
      for (const file of others) expect(readFileSync(file, "utf8")).toBe(OTHER_LINES);
      // In candidate order; the profile the shell reads is never among them.
      expect(result.stdout).toContain(
        `Saved FAL_KEY in ${profile()}. Restart libi and Codex so they read it.\n` +
          others.map((file) => `Removed an older FAL_KEY line from ${file}.\n`).join(""),
      );
      expect(leftovers()).toEqual([]);
    });

    it("adding when the profile the shell reads is a link to another candidate keeps the new line", () => {
      const dotProfile = path.join(home, ".profile");
      writeFileSync(dotProfile, `${OTHER_LINES}${libiLine("old")}`);
      symlinkSync(dotProfile, profile());

      const result = run(addCmd(), "sk-link-new\n");
      expect(result.status).toBe(0);
      expect(lstatSync(profile()).isSymbolicLink()).toBe(true);
      expect(readFileSync(dotProfile, "utf8")).toBe(`${OTHER_LINES}${libiLine("sk-link-new")}`);
      expect(result.stdout).not.toContain("Removed");
    });

    it("when the working copy does not end with the new line, the profile keeps its old line and nothing is said to be saved", () => {
      // A `tail` that never reports the line just appended: the copy's check fails, as it would after a failed append.
      writeFileSync(profile(), `${OTHER_LINES}${libiLine("old")}`);
      const result = run(addCmd(), "sk-unverified\n", { pathPrefix: withTool("tail", "echo hijacked") });
      expect(result.status).not.toBe(0);
      expect(readFileSync(profile(), "utf8")).toBe(`${OTHER_LINES}${libiLine("old")}`);
      expect(result.stdout).not.toContain("Saved");
      expect(leftovers()).toEqual([]);
    });

    // chmod does not stop root, so the refused write cannot be staged there.
    it.skipIf(process.getuid?.() === 0)(
      "a write-back that fails leaves the profile as it was, says where the edited copy is, keeps that copy private, and never prints the key",
      () => {
        const content = `${OTHER_LINES}${libiLine("fal-old-secret")}`;
        writeFileSync(profile(), content);
        chmodSync(profile(), 0o444);
        const copy = `${profile()}.libi-tmp`;
        const copyAt = `Could not write ${profile()}. The complete edited copy is in ${copy}.`;
        // The user's own umask would make a readable copy, and so would a stale copy left readable.
        const rc = "umask 022";
        writeFileSync(copy, "stale\n");
        chmodSync(copy, 0o644);

        const added = run(addCmd(), "fal-new-secret\n", { rc });
        expect(added.status).not.toBe(0);
        expect(added.stderr).toContain(copyAt);
        expect(added.stdout).not.toContain("Saved");
        expect(`${added.stdout}${added.stderr}`).not.toMatch(/fal-(new|old)-secret/);
        expect(readFileSync(profile(), "utf8")).toBe(content);
        expect(readFileSync(copy, "utf8")).toBe(`${OTHER_LINES}${libiLine("fal-new-secret")}`);
        expect(mode600(copy)).toBe("600");

        chmodSync(copy, 0o644);
        const removed = run(removeCmd(), "", { rc });
        expect(removed.status).not.toBe(0);
        expect(removed.stderr).toContain(copyAt);
        expect(removed.stdout).toBe("");
        expect(`${removed.stdout}${removed.stderr}`).not.toMatch(/fal-(new|old)-secret/);
        expect(readFileSync(profile(), "utf8")).toBe(content);
        expect(readFileSync(copy, "utf8")).toBe(OTHER_LINES);
        expect(mode600(copy)).toBe("600");
      },
    );

    it("no command leaves a variable, LC_ALL, positional parameters, or its umask behind in the shell the user typed it into", () => {
      writeFileSync(profile(), `${OTHER_LINES}${libiLine("k")}`);
      // `$#`: the candidate walk's `set --` never reaches the user's shell either.
      const probe = `echo "${[...COMMAND_VARIABLES, "LC_ALL"].map((name) => `\${${name}-unset}`).join("|")}|$#|$(umask)"`;
      const lastLine = (stdout: string) => stdout.trim().split("\n").at(-1);
      // The shell's own setup may already set a name (macOS's /etc/zshrc sets `key` for zle), so compare with before.
      const before = lastLine(run(`umask 022; ${probe}`).stdout);
      expect(before).toMatch(/^unset\|(?:[^|]*\|)*0\|0?022$/);
      expect(before!.split("|").slice(0, 17)).toEqual(Array(17).fill("unset"));
      for (const [command, input] of [[addCmd(), "sk-probe-add\n"], [replaceCmd(), "sk-probe-replace\n"], [removeCmd(), ""]] as const) {
        expect(lastLine(run(`umask 022; ${command}; ${probe}`, input).stdout)).toBe(before);
      }
    });
  },
);

describe("commandCarriesNoKeyMaterial", () => {
  it("flags the unreplaced placeholder and a literal bearer token, and accepts the variable reference", () => {
    expect(commandCarriesNoKeyMaterial(`claude mcp add x --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`)).toBe(false);
    expect(commandCarriesNoKeyMaterial('claude mcp add x --header "Authorization: Bearer abcd1234efgh"')).toBe(false);
    expect(commandCarriesNoKeyMaterial('claude mcp add x --header "Authorization: Bearer $libi_key"')).toBe(true);
    expect(commandCarriesNoKeyMaterial('claude mcp add x --header "Authorization: Bearer ${libi_key}"')).toBe(true);
  });
  it("does not inspect other positions such as an env pair — the builder never writes a key anywhere", () => {
    expect(commandCarriesNoKeyMaterial('codex mcp add x --env "X_API_KEY=abcd1234efgh"')).toBe(true);
  });
});

describe("chainCommands", () => {
  it("posix groups the second command behind && and powershell gates it on $?", () => {
    expect(chainCommands("posix", "a", "b")).toBe("a && { b; }");
    expect(chainCommands("powershell", "a", "b")).toBe("a; if ($?) { b }");
  });
});

describe("generated line length", () => {
  /** A realistic long resolved CLI path of exactly 120 characters: a runtime-installed CLI under a long user name. */
  const longCli = (agentId: SetupAgentId, flavor: ShellFlavor) => {
    const [dir, sep, name] =
      flavor === "posix"
        ? ["/Users/alexandra.konstantinopoulou/Library/Application Support/libi/runtime/node_modules/", "/", agentId === "codex" ? "codex" : "claude"]
        : ["C:\\Users\\alexandra.konstantinopoulou\\AppData\\Local\\Programs\\libi\\runtime\\node_modules\\", "\\", agentId === "codex" ? "codex.exe" : "claude.exe"];
    return { agentId, realPath: `${dir}${"v".repeat(120 - dir.length - sep.length - name.length)}${sep}${name}` };
  };
  /** A long real scripts folder of exactly 140 characters: libi's own install under a long user name. */
  const longScriptsDir = (flavor: ShellFlavor) => {
    const [before, after] =
      flavor === "posix"
        ? ["/Users/alexandra.konstantinopoulou/Library/Application Support/libi/runtime/", "/node_modules/@nagellabs/libi/lib/agents/setup/scripts"]
        : ["C:\\Users\\alexandra.konstantinopoulou\\AppData\\Local\\Programs\\libi\\resources\\", "\\node_modules\\@nagellabs\\libi\\lib\\agents\\setup\\scripts"];
    return `${before}${"v".repeat(140 - before.length - after.length)}${after}`;
  };
  const measure = (build: (lines: Array<{ label: string; bytes: number }>) => void) => {
    const lines: Array<{ label: string; bytes: number }> = [];
    build(lines);
    return { count: lines.length, longest: lines.reduce((a, b) => (b.bytes > a.bytes ? b : a)) };
  };
  const bytes = (line: string) => Buffer.byteLength(line, "utf8");

  it("every provider command — both shells, both agents, add / replace / remove for every provider and sign-in for each one signed in to with an account, a 120-character CLI path and a 140-character scripts folder — stays under 600 bytes, well below a tty's 1024-byte line", () => {
    const { count, longest } = measure((lines) => {
      for (const agentId of ["claude-code", "codex"] as const) {
        for (const flavor of ["posix", "powershell"] as const) {
          const cli = longCli(agentId, flavor);
          const dir = longScriptsDir(flavor);
          expect(cli.realPath).toHaveLength(120);
          expect(dir).toHaveLength(140);
          for (const def of WITH_COMMANDS) {
            const entry: DetectedProviderEntry =
              agentId === "codex" ? { agentId: "codex", name: def.id } : { agentId: "claude-code", name: def.id, scope: "project" };
            const at = `${agentId} ${flavor} ${def.id}`;
            lines.push({ label: `${at} add`, bytes: bytes(providerAddCommand(cli, flavor, def, dir)!) });
            lines.push({ label: `${at} replace`, bytes: bytes(providerReplaceCommand(cli, flavor, def, entry, dir)!) });
            lines.push({ label: `${at} remove`, bytes: bytes(providerRemoveCommand(cli, flavor, entry, def, dir)!) });
            const signIn = providerSignInCommand(cli, flavor, entry, def, dir);
            if (signIn !== null) lines.push({ label: `${at} sign-in`, bytes: bytes(signIn) });
          }
        }
      }
    });
    expect(count).toBe(WITH_COMMANDS.length * 2 * 2 * 3 + OAUTH.length * 2 * 2);
    expect(longest.bytes, `longest provider command: ${longest.label}, ${longest.bytes} bytes`).toBeLessThan(600);
  });

  it("every setup command line — install, update, sign-in, connect, reconnect, disconnect, provider add / replace / remove / sign-in — stays within 4096 bytes", () => {
    const endpoint = libiEndpointUrl(65535);
    const { count, longest } = measure((lines) => {
      const add = (label: string, line: string | null) => {
        if (line !== null) lines.push({ label, bytes: bytes(line) });
      };
      for (const agentId of ["claude-code", "codex"] as const) {
        for (const flavor of ["posix", "powershell"] as const) {
          const cli = longCli(agentId, flavor);
          const dir = longScriptsDir(flavor);
          const at = `${agentId} ${flavor}`;
          add(`${at} install`, installCommand(agentId, flavor));
          add(`${at} update`, updateCommand(cli, flavor, { claudeUpdateExists: true }));
          add(`${at} sign-in`, signInCommand(cli, flavor));
          add(`${at} connect`, connectLibiCommand(cli, flavor, endpoint));
          for (const scope of ["user", "local"] as const) {
            add(`${at} disconnect --scope ${scope}`, disconnectLibiCommand(cli, flavor, scope));
            add(`${at} reconnect --scope ${scope}`, reconnectLibiCommand(cli, flavor, endpoint, scope));
          }
          for (const def of PROVIDER_CATALOG) {
            const entry: DetectedProviderEntry =
              agentId === "codex" ? { agentId: "codex", name: def.id } : { agentId: "claude-code", name: def.id, scope: "project" };
            add(`${at} ${def.id} add`, providerAddCommand(cli, flavor, def, dir));
            add(`${at} ${def.id} replace`, providerReplaceCommand(cli, flavor, def, entry, dir));
            add(`${at} ${def.id} remove`, providerRemoveCommand(cli, flavor, entry, def, dir));
            add(`${at} ${def.id} provider sign-in`, providerSignInCommand(cli, flavor, entry, def, dir));
          }
        }
      }
    });
    expect(count).toBeGreaterThan(30);
    expect(longest.bytes, `longest generated line: ${longest.label}, ${longest.bytes} bytes`).toBeLessThanOrEqual(4096);
  });
});
