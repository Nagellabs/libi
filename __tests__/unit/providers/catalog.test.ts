import { describe, it, expect } from "vitest";
import {
  PROVIDER_CATALOG,
  findProvider,
  providersForKind,
  commandNeedsKey,
} from "@/lib/providers/catalog";

describe("PROVIDER_CATALOG", () => {
  it("holds the six entries the design names", () => {
    expect(PROVIDER_CATALOG.map((p) => p.id).sort()).toEqual([
      "ace-step",
      "elevenlabs",
      "fal",
      "higgsfield",
      "kokoro",
      "whisper",
    ]);
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

  it("gives ElevenLabs the stdio uvx commands", () => {
    const el = findProvider("elevenlabs");
    expect(el.commands!.claude).toBe(
      'claude mcp add --scope user elevenlabs -e "ELEVENLABS_API_KEY=<your key>" -- uvx elevenlabs-mcp',
    );
    expect(el.commands!.codex).toBe(
      'codex mcp add elevenlabs --env "ELEVENLABS_API_KEY=<your key>" -- uvx elevenlabs-mcp',
    );
    expect(el.transport).toBe("stdio");
    expect([...el.kinds].sort()).toEqual(["music", "sfx", "voice"]);
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
  });

  it("findProvider throws on an unknown id", () => {
    expect(() => findProvider("nope" as never)).toThrow(/unknown provider/i);
  });

  it("commandNeedsKey spots the placeholder", () => {
    expect(commandNeedsKey(findProvider("fal").commands!.claude)).toBe(true);
    expect(commandNeedsKey(findProvider("fal").commands!.codex)).toBe(false);
  });
});
