/**
 * Codex detection and spawn, on the platforms nobody ran it on.
 *
 * C1 — `resolveCodexBin` probed the adapter with `execSync('test -x "<path>"')`.
 *      `test` is not a cmd.exe builtin and there is no `test.exe` on a stock
 *      Windows, so that command failed on EVERY Windows machine: codex was
 *      reported not-installed no matter what was on disk.
 * C3 — a Windows `.cmd` shim was handed back to `spawn()` unchanged. Since the
 *      CVE-2024-27980 fix (Node >=18.20.2 / >=20.12.0) that throws `EINVAL`
 *      without `shell: true` — so detection said installed and the adapter
 *      could never launch. `shell: true` is not the fix: it is the thing the
 *      CVE was about, and it breaks on the space in `C:\\Users\\First Last\\`.
 * C4 — `CODEX_PATH` was ignored by detection even though the adapter reads it
 *      FIRST and libi forwards the whole env to the child, so a user pointing
 *      it at their own engine was hard-blocked for a file the adapter would
 *      never consult.
 * C5 — a dev checkout missing the optional engine was told to "reinstall
 *      libi", which is not a thing a contributor can act on.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";

import { spawnViaNodeIfScript, resolveCmdShimTarget } from "@/lib/agents/acp/agent-registry";
import { codexNativeBinaryMissingError } from "@/lib/agents/codex-native-binary";

// The shape npm's cmd-shim actually writes.
const CMD_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\..\@agentclientprotocol\codex-acp\dist\index.js" %*
`;

describe("C3 — Windows .cmd shims", () => {
  it("extracts the JS target from an npm cmd shim", () => {
    const shim = path.join("C:", "app", "node_modules", ".bin", "codex-acp.cmd");
    expect(resolveCmdShimTarget(shim, () => CMD_SHIM)).toBe(
      path.resolve(
        path.dirname(shim),
        path.join("..", "@agentclientprotocol", "codex-acp", "dist", "index.js"),
      ),
    );
  });

  it("spawns the .cmd's JS target through node, not the .cmd itself", () => {
    const shim = path.join("C:", "app", "node_modules", ".bin", "codex-acp.cmd");
    const resolved = spawnViaNodeIfScript(
      shim,
      (p) => p, // realpath is a no-op on a plain file
      () => CMD_SHIM,
    );
    expect(
      resolved.command,
      "handing the .cmd back unchanged is the EINVAL that made the adapter unlaunchable",
    ).not.toBe(shim);
    expect(resolved.args[0]).toMatch(/index\.js$/);
  });

  it("falls back to spawning the shim when it is not a recognisable npm shim", () => {
    // No worse than the old behaviour, and better than guessing.
    const shim = path.join("C:", "app", "weird.cmd");
    const resolved = spawnViaNodeIfScript(shim, (p) => p, () => "@echo off\r\nrem nothing\r\n");
    expect(resolved).toEqual({ command: shim, args: [] });
  });

  it("survives an unreadable shim", () => {
    const shim = path.join("C:", "app", "gone.cmd");
    const resolved = spawnViaNodeIfScript(
      shim,
      (p) => p,
      () => {
        throw new Error("ENOENT");
      },
    );
    expect(resolved).toEqual({ command: shim, args: [] });
  });

  it("still wraps a plain .js bin exactly as before", () => {
    const resolved = spawnViaNodeIfScript("/repo/node_modules/.bin/codex-acp", () => "/repo/x.js");
    expect(resolved.args).toEqual(["/repo/x.js"]);
  });

  it("leaves a genuine native launcher alone", () => {
    const resolved = spawnViaNodeIfScript("/usr/local/bin/codex", (p) => p);
    expect(resolved).toEqual({ command: "/usr/local/bin/codex", args: [] });
  });
});

describe("C5 — the message a dev checkout gets", () => {
  const DEV = "/home/dev/libi";
  const INSTALL = "/Applications/Libi.app/Resources/libi-bundle";

  it("names npm install, not 'reinstall libi', for a checkout", () => {
    const msg = codexNativeBinaryMissingError(DEV, {
      platform: "darwin",
      arch: "arm64",
      exists: (p) => p === path.join(DEV, ".git"),
    });
    expect(msg).toContain("npm install");
    expect(msg).toContain("--omit=optional");
    expect(msg, "a contributor cannot 'reinstall libi'").not.toContain("reinstall libi");
  });

  it("keeps the reinstall advice for a real install", () => {
    const msg = codexNativeBinaryMissingError(INSTALL, {
      platform: "darwin",
      arch: "arm64",
      exists: () => false,
    });
    expect(msg).toContain("reinstall libi");
    expect(msg).not.toContain("--omit=optional");
  });

  it("mentions CODEX_PATH as the escape hatch in a checkout", () => {
    const msg = codexNativeBinaryMissingError(DEV, {
      exists: (p) => p === path.join(DEV, ".git"),
    });
    expect(msg).toContain("CODEX_PATH");
  });
});
