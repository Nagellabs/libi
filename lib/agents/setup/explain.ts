import { KEY_PLACEHOLDER, type ProviderDef } from "@/lib/providers/catalog";
import type { installCommand, LibiScope, SetupAgentId } from "./commands";

type ShellFlavor = Parameters<typeof installCommand>[1];

/**
 * What a setup command is about to do, in words, for the line under the setup
 * terminal's prompt. The command itself is waiting unsubmitted in the terminal;
 * this is the sentence or two that tells the user what pressing Enter changes.
 * Built from the same context the command was built from — never from the
 * command text — and it never carries key material.
 */
export type SetupCommandContext =
  | { action: "install"; agentId: SetupAgentId; via: "installer" | "updater"; update?: boolean }
  | { action: "sign-in"; agentId: SetupAgentId }
  | { action: "connect-libi"; agentId: SetupAgentId; endpointUrl: string }
  | { action: "disconnect-libi"; agentId: SetupAgentId; scope: LibiScope }
  | { action: "reconnect-libi"; agentId: SetupAgentId; endpointUrl: string; scope: LibiScope }
  | { action: "provider-add" | "provider-replace"; agentId: SetupAgentId; provider: ProviderDef; flavor: ShellFlavor }
  | { action: "provider-remove"; agentId: SetupAgentId; provider: ProviderDef; flavor: ShellFlavor; scope?: string }
  | { action: "provider-sign-in"; agentId: SetupAgentId; provider: ProviderDef };

const NAME: Record<SetupAgentId, string> = { "claude-code": "Claude Code", codex: "Codex" };

function isPowerShellFlavor(flavor: ShellFlavor): boolean {
  return /power|pwsh/i.test(String(flavor));
}

/**
 * Provider add/remove/replace run as PowerShell text ([scriptblock]::Create),
 * which Constrained Language Mode (AppLocker/WDAC) blocks — with a .NET method
 * error, not a self-explanatory policy refusal. One clause pointing at the
 * "View script" link covers it.
 */
function constrainedLanguageModeNote(flavor: ShellFlavor): string {
  return isPowerShellFlavor(flavor)
    ? " If your organization locks down PowerShell (Constrained Language Mode), this can't run; use the View script link below to do the same steps by hand."
    : "";
}

/** Where the agent keeps an MCP entry. Codex has one config whatever the scope. */
function settingsFor(agentId: SetupAgentId, scope?: string): string {
  if (agentId === "codex") return "Codex's config (~/.codex/config.toml)";
  if (!scope || scope === "user") return "Claude Code's user settings (~/.claude.json)";
  return `Claude Code's ${scope}-scope settings`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * How a key gets into the hidden prompt: people paste it. On PowerShell each character shows as `*`; a POSIX
 * `read -rs` shows nothing at all, which reads as a paste that didn't work unless it is said.
 */
function pasteKeyHint(flavor: ShellFlavor): string {
  return isPowerShellFlavor(flavor)
    ? " When it asks for the key, paste it with Ctrl+V or a right-click, then press Enter."
    : " When it asks for the key, paste it (⌘V on a Mac, Ctrl+Shift+V on Linux) and press Enter; nothing shows as you paste.";
}

function providerAdd(agentId: SetupAgentId, provider: ProviderDef, flavor: ShellFlavor): string {
  const name = NAME[agentId];
  const raw = agentId === "codex" ? provider.commands?.codex : provider.commands?.claude;
  const uv = raw && /\buvx\b/.test(raw) ? " It runs through uv, which needs to be installed." : "";
  let text: string;
  if (provider.auth === "oauth") {
    // Credits: https://higgsfield.ai/mcp (the one account-signed provider today) says each generation costs
    // credits by model and resolution, and that the user's existing Higgsfield plan credits work through any
    // connected agent.
    const noKey = ` There is no key, and generations use your ${provider.name} credits.`;
    text =
      agentId === "codex"
        ? `Adds the ${provider.name} MCP server to ${settingsFor(agentId)}, then opens your browser to sign in with your ${provider.name} account; the command waits until you finish.${noKey}`
        : `Adds the ${provider.name} MCP server to ${settingsFor(agentId)}. Then sign in with your ${provider.name} account in your browser: use Sign in here, or run /mcp in Claude Code.${noKey}`;
  } else if (agentId === "codex" && provider.codexKeyEnv) {
    const where = isPowerShellFlavor(flavor) ? "your Windows user environment" : "your shell profile";
    text =
      `Asks for your ${provider.name} key without showing it and saves it as ${provider.codexKeyEnv} in ${where}, ` +
      `then adds the ${provider.name} MCP server to ${settingsFor(agentId)}, which reads the key from ${provider.codexKeyEnv}. ` +
      `Restart libi and Codex afterwards so they pick up the key.${pasteKeyHint(flavor)}${uv}`;
  } else if (raw?.includes(KEY_PLACEHOLDER)) {
    text =
      `Asks for your ${provider.name} key without showing it, then adds the ${provider.name} MCP server with that key to ` +
      `${settingsFor(agentId)}, so ${name} can use ${provider.name} in libi and everywhere else.${pasteKeyHint(flavor)}${uv}`;
  } else {
    text = `Adds the ${provider.name} MCP server to ${settingsFor(agentId)}, so ${name} can use ${provider.name} in libi and everywhere else.${uv}`;
  }
  return text + constrainedLanguageModeNote(flavor);
}

export function explainSetupCommand(ctx: SetupCommandContext): string {
  const name = NAME[ctx.agentId];
  switch (ctx.action) {
    case "install": {
      if (ctx.via === "updater") return `Runs ${name}'s own updater to bring it up to the version libi needs.`;
      const installer =
        ctx.agentId === "claude-code"
          ? "Anthropic's official Claude Code installer from claude.ai"
          : "OpenAI's official Codex installer from chatgpt.com";
      return ctx.update
        ? `Runs ${installer} again to update ${name} to the version libi needs.`
        : `Downloads and runs ${installer}. libi's chats then run on the ${name} it installs.`;
    }
    case "sign-in":
      return ctx.agentId === "claude-code"
        ? "Starts Claude Code in this terminal. Type /login and follow the steps to sign in — Claude Code keeps your sign-in, and libi never sees it."
        : "Runs codex login, which opens your browser to sign in to Codex. Codex keeps your sign-in, and libi never sees it.";
    case "connect-libi":
      return (
        `Adds Libi MCP — libi's tools at ${ctx.endpointUrl} — to ${settingsFor(ctx.agentId, "user")}, ` +
        `so ${name} chats in any folder can use them. Nothing else in your ${name} setup changes.`
      );
    case "disconnect-libi":
      return `Removes Libi MCP from ${settingsFor(ctx.agentId, ctx.scope)}. ${name} chats outside libi stop seeing libi's tools; libi's own chats keep them.`;
    case "reconnect-libi":
      return `libi's MCP address changed. This removes the old Libi MCP entry from ${settingsFor(ctx.agentId, ctx.scope)} and adds it again, for your whole account, at ${ctx.endpointUrl}.`;
    case "provider-add":
      return providerAdd(ctx.agentId, ctx.provider, ctx.flavor);
    case "provider-replace":
      return `Replaces your current ${ctx.provider.name} entry in ${name}: it removes that entry first, then ${lowerFirst(providerAdd(ctx.agentId, ctx.provider, ctx.flavor))}`;
    case "provider-sign-in":
      // Credits: https://higgsfield.ai/mcp, as in providerAdd above.
      return (
        `Runs ${name}'s own MCP sign-in for ${ctx.provider.name}: your browser opens to sign in with your ${ctx.provider.name} account, ` +
        `and the command waits until you finish. ${name} keeps the sign-in, and libi never sees it. Generations use your ${ctx.provider.name} credits.`
      );
    case "provider-remove": {
      let removeText: string;
      if (ctx.provider.auth === "oauth") {
        // remove-provider signs out BEFORE the remove: both agents look the stored sign-in up through the entry,
        // and once the entry is gone their `mcp logout` answers "No MCP server named …" and clears nothing.
        removeText =
          `Signs ${name} out of ${ctx.provider.name} first, so the sign-in it stored isn't left behind, then removes the ` +
          `${ctx.provider.name} MCP server from ${settingsFor(ctx.agentId, ctx.scope)}, so ${name} stops using ${ctx.provider.name}.`;
      } else if (ctx.agentId === "codex" && ctx.provider.codexKeyEnv) {
        const key = ctx.provider.codexKeyEnv;
        removeText = isPowerShellFlavor(ctx.flavor)
          ? `Removes the ${ctx.provider.name} MCP server from ${settingsFor(ctx.agentId)}, then clears ${key} from your Windows user environment.`
          : `Removes the ${ctx.provider.name} MCP server from ${settingsFor(ctx.agentId)}, then deletes the ${key} line libi saved in your shell profile.`;
      } else {
        removeText = `Removes the ${ctx.provider.name} MCP server, with any key saved in its entry, from ${settingsFor(ctx.agentId, ctx.scope)}.`;
      }
      return removeText + constrainedLanguageModeNote(ctx.flavor);
    }
  }
}
