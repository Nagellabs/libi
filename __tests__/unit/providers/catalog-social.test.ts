import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PROVIDER_KINDS, findProvider, providersForKind } from "@/lib/providers/catalog";

describe("social provider kind", () => {
  it("lists social as a kind and Zernio as its only remote-mcp provider", () => {
    expect(PROVIDER_KINDS).toContain("social");
    expect(providersForKind("social").map((p) => p.id)).toEqual(["zernio"]);
  });
  it("Zernio is an OAuth http provider whose add and sign-in commands match the docs", () => {
    const z = findProvider("zernio");
    expect(z.auth).toBe("oauth");
    expect(z.transport).toBe("http");
    expect(z.commands).toEqual({
      claude: "claude mcp add --transport http --scope user zernio https://mcp.zernio.com/mcp",
      codex: "codex mcp add zernio --url https://mcp.zernio.com/mcp",
    });
    expect(z.signInCommands).toEqual({ claude: "claude mcp login zernio", codex: "codex mcp login zernio" });
    expect(z.addSignsIn).toEqual(["codex", "claude"]);
    expect(z.match).toEqual({ names: ["zernio"], urls: ["mcp.zernio.com"] });
  });
  it("every setup script knows the zernio row", () => {
    const dir = path.join(process.cwd(), "lib/agents/setup/scripts");
    for (const f of ["add-provider.sh", "remove-provider.sh", "replace-provider.sh", "signin-provider.sh",
                     "add-provider.ps1", "remove-provider.ps1", "replace-provider.ps1", "signin-provider.ps1"]) {
      expect(readFileSync(path.join(dir, f), "utf8"), f).toMatch(/zernio/);
    }
  });
});
