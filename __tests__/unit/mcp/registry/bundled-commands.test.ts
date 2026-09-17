// Every bundled MCP must name a command libi can actually spawn.
//
// The ElevenLabs def (since deleted) once shipped with `command: "uvx"`
// while its own uv dependency extracted only `uv` out of the archive. `uvx`
// lives in that same archive and was never copied, so `spawn("uvx", …)` could
// not resolve out of `~/.libi/bin` — the server could not start on macOS,
// Linux or Windows. It went unnoticed because anyone with Homebrew's uv on
// PATH sees it work, and it was only found when a Windows audit went looking
// for something else.
//
// A def is spawnable when ONE of these is true, and this test says which:
//
//  * it has no command at all (the core row, and `noServer` extensions whose
//    work runs inside libi's own server),
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
        // The core row and noServer extensions carry no spawn command.
        expect(def.core === true || def.noServer === true).toBe(true);
        expect(def.args).toEqual([]);
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
