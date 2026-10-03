import { describe, it, expect } from "vitest";
import {
  PROVIDER_CATALOG,
  findProvider,
  providersForKind,
  commandNeedsKey,
  billsGenerationCredits,
} from "@/lib/providers/catalog";

describe("PROVIDER_CATALOG", () => {
  it("holds the eight entries the design names", () => {
    expect(PROVIDER_CATALOG.map((p) => p.id).sort()).toEqual([
      "ace-step",
      "elevenlabs",
      "fal",
      "higgsfield",
      "kokoro",
      "playwright",
      "whisper",
      "zernio",
    ]);
  });

  it("Playwright is a key-less local browser server, added at user scope, wrapped in cmd /c for Claude Code on Windows", () => {
    const pw = findProvider("playwright");
    expect(pw.kinds).toEqual(["browser"]);
    expect(pw.kind).toBe("remote-mcp");
    expect(pw.transport).toBe("stdio");
    expect(pw.auth).toBe("none");
    expect(pw.commands).toEqual({
      claude: "claude mcp add --scope user playwright -- npx @playwright/mcp@latest",
      codex: "codex mcp add playwright -- npx @playwright/mcp@latest",
    });
    expect(pw.windowsCommands?.claude).toBe("claude mcp add --scope user playwright -- cmd /c npx @playwright/mcp@latest");
    expect(commandNeedsKey(pw.commands!.claude)).toBe(false);
    expect(billsGenerationCredits(pw)).toBe(false);
    expect(providersForKind("browser").map((p) => p.id)).toEqual(["playwright"]);
  });

  it("fal's docs link is the MCP setup page (the old model-context-protocol URL 404s)", () => {
    expect(findProvider("fal").docsUrl).toBe("https://fal.ai/docs/documentation/setting-up/mcp");
  });

  it("gives fal the exact Claude and Codex add commands", () => {
    const fal = findProvider("fal");
    expect(fal.commands!.claude).toBe(
      'claude mcp add --scope user --transport http fal-ai https://mcp.fal.ai/mcp --header "Authorization: Bearer <your key>"',
    );
    expect(fal.commands!.codex).toBe(
      "codex mcp add fal-ai --url https://mcp.fal.ai/mcp --bearer-token-env-var FAL_KEY",
    );
    expect(fal.codexNote).toMatch(/FAL_KEY/);
    expect(fal.transport).toBe("http");
    expect(fal.keyName).toBe("FAL_KEY");
    expect(fal.kinds).toEqual(["image", "video"]);
  });

  // The owner's ElevenLabs add ran `uvx elevenlabs-mcp` on a Mac without uv, and the chat had no ElevenLabs tools
  // (2026-09-25). The hosted server needs nothing installed and no key: the user signs in with their account.
  it("gives ElevenLabs its hosted MCP server at api.us: OAuth, the exact add and sign-in commands, no key, no uv", () => {
    const el = findProvider("elevenlabs");
    expect(el.kind).toBe("remote-mcp");
    expect(el.transport).toBe("http");
    expect(el.auth).toBe("oauth");
    expect(el.commands).toEqual({
      claude: "claude mcp add --transport http --scope user elevenlabs https://api.us.elevenlabs.io/v1/mcp",
      codex: "codex mcp add elevenlabs --url https://api.us.elevenlabs.io/v1/mcp",
    });
    expect(el.signInCommands).toEqual({ claude: "claude mcp login elevenlabs", codex: "codex mcp login elevenlabs" });
    expect(el.addSignsIn).toEqual(["codex", "claude"]);
    expect(el.keyName).toBeUndefined();
    expect(el.codexKeyEnv).toBeUndefined();
    for (const cmd of Object.values(el.commands!)) {
      expect(commandNeedsKey(cmd)).toBe(false);
      expect(cmd).not.toMatch(/\buvx?\b/);
      // api.elevenlabs.io advertises api.us as its protected resource, which Claude Code refuses as a mismatch.
      expect(cmd).not.toContain("https://api.elevenlabs.io");
    }
    expect(el.codexNote).toBe("Add opens your browser to sign in with your ElevenLabs account, and waits until you finish.");
    expect(el.match).toEqual({ names: ["elevenlabs", "eleven-labs", "eleven_labs"], urls: ["elevenlabs.io"] });
    // Voice, music and sound effects only: its image/video generation is not what libi recommends it for.
    expect([...el.kinds].sort()).toEqual(["music", "sfx", "voice"]);
    expect(billsGenerationCredits(el)).toBe(true);
  });

  it("gives Higgsfield its hosted MCP server: OAuth, the exact add and sign-in commands, and no key anywhere", () => {
    const h = findProvider("higgsfield");
    expect(h.kind).toBe("remote-mcp");
    expect(h.transport).toBe("http");
    expect(h.auth).toBe("oauth");
    expect(h.kinds).toEqual(["image", "video"]);
    expect(h.docsUrl).toBe("https://higgsfield.ai/mcp");
    expect(h.commands).toEqual({
      claude: "claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp",
      codex: "codex mcp add higgsfield --url https://mcp.higgsfield.ai/mcp",
    });
    expect(h.signInCommands).toEqual({ claude: "claude mcp login higgsfield", codex: "codex mcp login higgsfield" });
    expect(h.keyName).toBeUndefined();
    expect(h.codexKeyEnv).toBeUndefined();
    for (const cmd of Object.values(h.commands!)) expect(commandNeedsKey(cmd)).toBe(false);
    expect(h.codexNote).toBe("Add opens your browser to sign in with your Higgsfield account, and waits until you finish.");
  });

  it("only a provider signed in to with an account has sign-in commands, and such a provider names no key", () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.auth === "oauth") {
        expect(p.commands, p.id).toBeDefined();
        expect(p.signInCommands, p.id).toBeDefined();
        expect(p.keyName, p.id).toBeUndefined();
        expect(p.codexKeyEnv, p.id).toBeUndefined();
      } else {
        expect(p.signInCommands, p.id).toBeUndefined();
        // Only an add that can sign in can do both steps at once.
        expect(p.addSignsIn, p.id).toBeUndefined();
      }
    }
  });

  it("maps every extension entry to a real bundled def id", async () => {
    const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
    const ids = new Set(BUNDLED_MCP_SERVERS.map((d) => d.id));
    const extensions = PROVIDER_CATALOG.filter((p) => p.kind === "extension");
    expect(extensions.map((p) => p.id).sort()).toEqual(["ace-step", "kokoro", "whisper"]);
    for (const p of extensions) {
      expect(p.extensionId).toBeDefined();
      expect(ids.has(p.extensionId!)).toBe(true);
    }
  });

  it("never puts a key VALUE in the catalog — only the placeholder", () => {
    for (const p of PROVIDER_CATALOG) {
      for (const cmd of Object.values(p.commands ?? {})) {
        expect(cmd).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{12,}/);
        expect(cmd).not.toMatch(/=[A-Za-z0-9_-]{20,}/);
      }
    }
  });

  it("providersForKind returns remote MCPs before extensions", () => {
    expect(providersForKind("music").map((p) => p.id)).toEqual(["elevenlabs", "ace-step"]);
    expect(providersForKind("video").map((p) => p.id)).toEqual(["fal", "higgsfield"]);
    expect(providersForKind("transcription").map((p) => p.id)).toEqual(["whisper"]);
    expect(providersForKind("social").map((p) => p.id)).toEqual(["zernio"]);
  });

  it("findProvider throws on an unknown id", () => {
    expect(() => findProvider("nope" as never)).toThrow(/unknown provider/i);
  });

  it("commandNeedsKey spots the placeholder", () => {
    expect(commandNeedsKey(findProvider("fal").commands!.claude)).toBe(true);
    expect(commandNeedsKey(findProvider("fal").commands!.codex)).toBe(false);
  });
});
