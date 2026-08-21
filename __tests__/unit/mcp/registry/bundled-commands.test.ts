// Every bundled MCP must name a command libi can actually spawn.
//
// `elevenlabs` shipped with `command: "uvx"` while its own uv dependency
// extracts only `uv` out of the archive. `uvx` lives in that same archive and
// was never copied, so `spawn("uvx", …)` could not resolve out of
// `~/.libi/bin` — the server could not start on macOS, Linux or Windows.
// It went unnoticed because anyone with Homebrew's uv on PATH sees it work,
// and it was only found when a Windows audit went looking for something else.
//
// A def is spawnable when ONE of these is true, and this test says which:
//
//  * it has no command at all (HTTP servers, and the defs that stand in for
//    libi's own server),
//  * `inRepoEntry` makes `resolveBundledSpawn` build the entry point from the
//    source tree, and the def's `command` is a documented dead fallback,
//  * `npmPackage` + `pinnedVersion` make the resolver prefer the bin shim
//    under `~/.libi/node_modules/.bin/`, with `npx` as the fallback for the
//    window before the install lands,
//  * or the command is a binary the def's OWN dependencies install into
//    `~/.libi/bin`, which `buildSpawnEnv` prepends to PATH.
//
// Anything else is naming a binary and hoping the user's machine has it.
import { describe, it, expect } from "vitest";

import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("every bundled MCP names a spawnable command", () => {
  for (const def of BUNDLED_MCP_SERVERS) {
    it(`${def.id}: ${def.command || "(no command)"}`, () => {
      if (!def.command) {
        // HTTP transports and libi's own servers carry no spawn command.
        expect(def.type === "http" || def.args?.length === 0 || !def.args).toBe(true);
        return;
      }

      if (def.inRepoEntry) {
        // Resolved from the source tree; the command is never reached.
        expect(def.inRepoEntry.length).toBeGreaterThan(0);
        return;
      }

      if (def.command === "npx") {
        // Only defensible as the pre-install fallback for a pinned package
        // the resolver will otherwise run straight out of node_modules.
        expect(def.npmPackage).toBeTruthy();
        expect(def.pinnedVersion).toBeTruthy();
        return;
      }

      const installs = (def.dependencies ?? []).map((d) => d.binary);
      expect(
        installs,
        `"${def.id}" spawns "${def.command}", which nothing in its dependencies installs. ` +
          `It declares: [${installs.join(", ") || "nothing"}]. A binary libi does not install ` +
          `resolves only on machines that happen to already have it.`,
      ).toContain(def.command);
    });
  }
});

describe("elevenlabs specifically", () => {
  const def = BUNDLED_MCP_SERVERS.find((d) => d.id === "elevenlabs")!;

  it("runs the MCP through uv, the binary its dependency actually extracts", () => {
    expect(def.command).toBe("uv");
    expect(def.args).toEqual(["tool", "run", "elevenlabs-mcp"]);
  });

  // The regression in one line: `uvx` is in the uv archive, and the archive
  // extraction below is the exhaustive list of what comes out of it.
  it("does not reach for a second binary the uv dependency leaves behind", () => {
    const uv = def.dependencies?.find((d) => d.binary === "uv");
    expect(uv).toBeDefined();
    const extracted = JSON.stringify(uv!.archive?.binaryPathInArchive ?? {});
    expect(extracted).not.toContain("uvx");
    expect(def.command).not.toBe("uvx");
  });
});
