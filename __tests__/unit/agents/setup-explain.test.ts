import { describe, it, expect } from "vitest";
import { explainSetupCommand } from "@/lib/agents/setup/explain";
import { findProvider, KEY_PLACEHOLDER } from "@/lib/providers/catalog";

const fal = findProvider("fal");
const elevenlabs = findProvider("elevenlabs");
const higgsfield = findProvider("higgsfield");
const zernio = findProvider("zernio");
const URL = "http://127.0.0.1:3457/mcp";
const CLM_NOTE =
  " If your organization locks down PowerShell (Constrained Language Mode), this can't run; use the View script link below to do the same steps by hand.";
const clmSuffix = (flavor: "posix" | "powershell") => (flavor === "powershell" ? CLM_NOTE : "");

describe("explainSetupCommand", () => {
  it("names the official installer, and the updater when that is what runs", () => {
    expect(explainSetupCommand({ action: "install", agentId: "claude-code", via: "installer" })).toBe(
      "Downloads and runs Anthropic's official Claude Code installer from claude.ai. libi's chats then run on the Claude Code it installs.",
    );
    expect(explainSetupCommand({ action: "install", agentId: "codex", via: "installer", update: true })).toBe(
      "Runs OpenAI's official Codex installer from chatgpt.com again to update Codex to the version libi needs.",
    );
    expect(explainSetupCommand({ action: "install", agentId: "claude-code", via: "updater", update: true })).toBe(
      "Runs Claude Code's own updater to bring it up to the version libi needs.",
    );
  });

  it("tells Claude Code users to type /login, and Codex users that a browser opens", () => {
    expect(explainSetupCommand({ action: "sign-in", agentId: "claude-code" })).toMatch(/Type \/login/);
    expect(explainSetupCommand({ action: "sign-in", agentId: "codex" })).toMatch(/opens your browser/);
    for (const agentId of ["claude-code", "codex"] as const) {
      expect(explainSetupCommand({ action: "sign-in", agentId })).toMatch(/libi never sees it\.$/);
    }
  });

  it("says where Libi MCP is added or removed, with the address it points at", () => {
    expect(explainSetupCommand({ action: "connect-libi", agentId: "claude-code", endpointUrl: URL })).toBe(
      `Adds Libi MCP — libi's tools at ${URL} — to Claude Code's user settings (~/.claude.json), so Claude Code chats in any folder can use them. Nothing else in your Claude Code setup changes.`,
    );
    expect(explainSetupCommand({ action: "connect-libi", agentId: "codex", endpointUrl: URL })).toContain("Codex's config (~/.codex/config.toml)");
    expect(explainSetupCommand({ action: "disconnect-libi", agentId: "claude-code", scope: "local" })).toContain("Claude Code's local-scope settings");
    expect(explainSetupCommand({ action: "reconnect-libi", agentId: "codex", endpointUrl: URL, scope: "user" })).toBe(
      `libi's MCP address changed. This removes the old Libi MCP entry from Codex's config (~/.codex/config.toml) and adds it again, for your whole account, at ${URL}.`,
    );
  });

  it("says a Codex fal.ai key is saved to the shell profile, or the Windows user environment on PowerShell", () => {
    const posix = explainSetupCommand({ action: "provider-add", agentId: "codex", provider: fal, flavor: "posix" });
    expect(posix).toContain("saves it as FAL_KEY in your shell profile");
    expect(posix).toContain("Restart libi and Codex afterwards");
    const ps = explainSetupCommand({ action: "provider-add", agentId: "codex", provider: fal, flavor: "powershell" });
    expect(ps).toContain("saves it as FAL_KEY in your Windows user environment");
    expect(explainSetupCommand({ action: "provider-remove", agentId: "codex", provider: fal, flavor: "posix" })).toContain(
      "deletes the FAL_KEY line libi saved in your shell profile",
    );
    expect(explainSetupCommand({ action: "provider-remove", agentId: "codex", provider: fal, flavor: "powershell" })).toContain(
      "clears FAL_KEY from your Windows user environment",
    );
  });

  it("describes a keyed Claude add, a hosted sign-in add, a replace, and a Claude remove in its scope", () => {
    expect(explainSetupCommand({ action: "provider-add", agentId: "claude-code", provider: fal, flavor: "posix" })).toBe(
      "Asks for your fal.ai key without showing it, then adds the fal.ai MCP server with that key to Claude Code's user settings (~/.claude.json), so Claude Code can use fal.ai in libi and everywhere else. When it asks for the key, paste it (⌘V on a Mac, Ctrl+Shift+V on Linux) and press Enter; nothing shows as you paste.",
    );
    // ElevenLabs is its hosted server now: nothing to install, no key, a sign-in with the user's account.
    const elCodex = explainSetupCommand({ action: "provider-add", agentId: "codex", provider: elevenlabs, flavor: "posix" });
    expect(elCodex).toBe(
      "Adds the ElevenLabs MCP server to Codex's config (~/.codex/config.toml), then opens your browser to sign in with your ElevenLabs account; the command waits until you finish. Codex keeps the sign-in, and libi never sees it. There is no key, and generations use your ElevenLabs credits.",
    );
    expect(elCodex).not.toMatch(/\buv\b/);
    expect(explainSetupCommand({ action: "provider-replace", agentId: "claude-code", provider: fal, flavor: "posix" })).toMatch(
      /^Replaces your current fal\.ai entry in Claude Code: it removes that entry first, then asks for your fal\.ai key/,
    );
    expect(explainSetupCommand({ action: "provider-remove", agentId: "claude-code", provider: fal, flavor: "posix", scope: "project" })).toBe(
      "Removes the fal.ai MCP server, with any key saved in its entry, from Claude Code's project-scope settings.",
    );
  });

  it("removing an older LOCAL ElevenLabs entry says it removes the entry with its key, and claims no sign-out", () => {
    expect(explainSetupCommand({ action: "provider-remove", agentId: "claude-code", provider: elevenlabs, flavor: "posix", scope: "user", transport: "stdio" })).toBe(
      "Removes the ElevenLabs MCP server, with any key saved in its entry, from Claude Code's user settings (~/.claude.json).",
    );
    expect(explainSetupCommand({ action: "provider-remove", agentId: "codex", provider: elevenlabs, flavor: "posix", transport: "http" })).toMatch(/^Signs Codex out of ElevenLabs first/);
  });

  it("a replace for an entry that can't start says why, naming the missing command, then what the add does", () => {
    const line = explainSetupCommand({ action: "provider-replace", agentId: "claude-code", provider: elevenlabs, flavor: "posix", missingCommand: "uvx" });
    // The fix for an old `uvx elevenlabs-mcp` entry: remove it, then add the hosted server and sign in.
    expect(line).toBe(
      "Your ElevenLabs entry in Claude Code can't start because libi can't find uvx on this computer. This removes that entry, then adds the ElevenLabs MCP server to Claude Code's user settings (~/.claude.json), then opens your browser to sign in with your ElevenLabs account; the command waits until you finish. Claude Code keeps the sign-in, and libi never sees it. There is no key, and generations use your ElevenLabs credits.",
    );
    // Without a missing command the replace reads as it always did.
    expect(explainSetupCommand({ action: "provider-replace", agentId: "claude-code", provider: elevenlabs, flavor: "posix" })).toMatch(
      /^Replaces your current ElevenLabs entry in Claude Code/,
    );
  });

  it("every command that asks for a key says how to paste it — Ctrl+V or a right-click on PowerShell — and a sign-in provider says nothing about pasting", () => {
    const POSIX_HINT = "When it asks for the key, paste it (⌘V on a Mac, Ctrl+Shift+V on Linux) and press Enter; nothing shows as you paste.";
    const PS_HINT = "When it asks for the key, paste it with Ctrl+V or a right-click, then press Enter.";
    for (const agentId of ["claude-code", "codex"] as const) {
      for (const provider of [fal]) {
        for (const action of ["provider-add", "provider-replace"] as const) {
          expect(explainSetupCommand({ action, agentId, provider, flavor: "posix" })).toContain(POSIX_HINT);
          const ps = explainSetupCommand({ action, agentId, provider, flavor: "powershell" });
          expect(ps).toContain(PS_HINT);
          expect(ps).not.toContain("⌘V");
        }
      }
      expect(explainSetupCommand({ action: "provider-add", agentId, provider: higgsfield, flavor: "powershell" })).not.toMatch(/paste/i);
      expect(explainSetupCommand({ action: "provider-add", agentId, provider: elevenlabs, flavor: "posix" })).not.toMatch(/paste/i);
      expect(explainSetupCommand({ action: "provider-remove", agentId, provider: fal, flavor: "powershell" })).not.toMatch(/paste/i);
    }
  });

  it("Higgsfield: no key, a browser sign-in with the Higgsfield account, and generations on Higgsfield credits", () => {
    for (const flavor of ["posix", "powershell"] as const) {
      expect(explainSetupCommand({ action: "provider-add", agentId: "claude-code", provider: higgsfield, flavor })).toBe(
        "Adds the Higgsfield MCP server to Claude Code's user settings (~/.claude.json), then opens your browser to sign in with your Higgsfield account; the command waits until you finish. Claude Code keeps the sign-in, and libi never sees it. There is no key, and generations use your Higgsfield credits." +
          clmSuffix(flavor),
      );
      expect(explainSetupCommand({ action: "provider-add", agentId: "codex", provider: higgsfield, flavor })).toBe(
        "Adds the Higgsfield MCP server to Codex's config (~/.codex/config.toml), then opens your browser to sign in with your Higgsfield account; the command waits until you finish. Codex keeps the sign-in, and libi never sees it. There is no key, and generations use your Higgsfield credits." +
          clmSuffix(flavor),
      );
      expect(explainSetupCommand({ action: "provider-remove", agentId: "codex", provider: higgsfield, flavor })).toBe(
        "Signs Codex out of Higgsfield first, so the sign-in it stored isn't left behind, then removes the Higgsfield MCP server from Codex's config (~/.codex/config.toml), so Codex stops using Higgsfield." +
          clmSuffix(flavor),
      );
    }
    expect(explainSetupCommand({ action: "provider-sign-in", agentId: "claude-code", provider: higgsfield })).toBe(
      "Runs Claude Code's own MCP sign-in for Higgsfield: your browser opens to sign in with your Higgsfield account, and the command waits until you finish. Claude Code keeps the sign-in, and libi never sees it. Generations use your Higgsfield credits.",
    );
    expect(explainSetupCommand({ action: "provider-sign-in", agentId: "codex", provider: higgsfield })).toBe(
      "Runs Codex's own MCP sign-in for Higgsfield: your browser opens to sign in with your Higgsfield account, and the command waits until you finish. Codex keeps the sign-in, and libi never sees it. Generations use your Higgsfield credits.",
    );
    expect(explainSetupCommand({ action: "provider-remove", agentId: "claude-code", provider: higgsfield, flavor: "posix", scope: "local" })).toBe(
      "Signs Claude Code out of Higgsfield first, so the sign-in it stored isn't left behind, then removes the Higgsfield MCP server from Claude Code's local-scope settings, so Claude Code stops using Higgsfield.",
    );
    for (const agentId of ["claude-code", "codex"] as const) {
      const lines = [
        explainSetupCommand({ action: "provider-add", agentId, provider: higgsfield, flavor: "posix" }),
        explainSetupCommand({ action: "provider-replace", agentId, provider: higgsfield, flavor: "posix" }),
        explainSetupCommand({ action: "provider-sign-in", agentId, provider: higgsfield }),
        explainSetupCommand({ action: "provider-remove", agentId, provider: higgsfield, flavor: "posix" }),
      ];
      for (const line of lines) expect(line).not.toMatch(/Asks for your|key saved|FAL_KEY/);
    }
  });

  it("Zernio: no key, a browser sign-in with the Zernio account, and never a credits or generation claim — it posts, it doesn't generate", () => {
    for (const flavor of ["posix", "powershell"] as const) {
      expect(explainSetupCommand({ action: "provider-add", agentId: "claude-code", provider: zernio, flavor })).toBe(
        "Adds the Zernio MCP server to Claude Code's user settings (~/.claude.json), then opens your browser to sign in with your Zernio account; the command waits until you finish. Claude Code keeps the sign-in, and libi never sees it. There is no key." +
          clmSuffix(flavor),
      );
      expect(explainSetupCommand({ action: "provider-add", agentId: "codex", provider: zernio, flavor })).toBe(
        "Adds the Zernio MCP server to Codex's config (~/.codex/config.toml), then opens your browser to sign in with your Zernio account; the command waits until you finish. Codex keeps the sign-in, and libi never sees it. There is no key." +
          clmSuffix(flavor),
      );
    }
    expect(explainSetupCommand({ action: "provider-sign-in", agentId: "claude-code", provider: zernio })).toBe(
      "Runs Claude Code's own MCP sign-in for Zernio: your browser opens to sign in with your Zernio account, and the command waits until you finish. Claude Code keeps the sign-in, and libi never sees it.",
    );
    expect(explainSetupCommand({ action: "provider-sign-in", agentId: "codex", provider: zernio })).toBe(
      "Runs Codex's own MCP sign-in for Zernio: your browser opens to sign in with your Zernio account, and the command waits until you finish. Codex keeps the sign-in, and libi never sees it.",
    );
    for (const agentId of ["claude-code", "codex"] as const) {
      const lines = [
        explainSetupCommand({ action: "provider-add", agentId, provider: zernio, flavor: "posix" }),
        explainSetupCommand({ action: "provider-replace", agentId, provider: zernio, flavor: "posix" }),
        explainSetupCommand({ action: "provider-sign-in", agentId, provider: zernio }),
      ];
      for (const line of lines) expect(line).not.toMatch(/credit|generation/i);
    }
  });

  it("notes Constrained Language Mode for PowerShell provider commands only, never for POSIX or sign-in", () => {
    for (const agentId of ["claude-code", "codex"] as const) {
      expect(explainSetupCommand({ action: "provider-add", agentId, provider: fal, flavor: "powershell" })).toContain(
        "Constrained Language Mode",
      );
      expect(explainSetupCommand({ action: "provider-add", agentId, provider: fal, flavor: "posix" })).not.toContain(
        "Constrained Language Mode",
      );
      expect(explainSetupCommand({ action: "provider-replace", agentId, provider: fal, flavor: "powershell" })).toContain(
        "Constrained Language Mode",
      );
      expect(explainSetupCommand({ action: "provider-replace", agentId, provider: fal, flavor: "posix" })).not.toContain(
        "Constrained Language Mode",
      );
      expect(
        explainSetupCommand({ action: "provider-remove", agentId, provider: fal, flavor: "powershell", scope: "user" }),
      ).toContain("Constrained Language Mode");
      expect(
        explainSetupCommand({ action: "provider-remove", agentId, provider: fal, flavor: "posix", scope: "user" }),
      ).not.toContain("Constrained Language Mode");
    }
    expect(explainSetupCommand({ action: "provider-sign-in", agentId: "claude-code", provider: fal })).not.toContain(
      "Constrained Language Mode",
    );
  });

  it("never carries a key placeholder", () => {
    for (const agentId of ["claude-code", "codex"] as const) {
      expect(explainSetupCommand({ action: "provider-sign-in", agentId, provider: higgsfield })).not.toContain(KEY_PLACEHOLDER);
      for (const provider of [fal, elevenlabs, higgsfield]) {
        for (const action of ["provider-add", "provider-replace"] as const) {
          expect(explainSetupCommand({ action, agentId, provider, flavor: "posix" })).not.toContain(KEY_PLACEHOLDER);
        }
      }
    }
  });
});
