/**
 * `app/api/terminal/shell-flavor/route.ts` claims — in its own doc comment —
 * to "mirror `resolveShell`'s own platform check exactly"
 * (`lib/terminal/pty.ts#resolveShell`, the function that actually spawns the
 * terminal's PTY). Nothing enforces that claim: if `resolveShell` ever grows
 * a branch (a `pwsh` preference, honoring `COMSPEC`, …) the route could keep
 * quoting for a shell that isn't the one running, and a pasted path would be
 * silently mis-escaped.
 *
 * This test imports both the route's `GET` and `resolveShell` and asserts
 * they always agree, with `isWindows()` mocked both ways — same mocking
 * style as `__tests__/unit/agents/terminal-remedy.test.ts`, which already
 * flips `isWindows` per test rather than relying on the host platform.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isWindows = vi.fn(() => false);
vi.mock("@/lib/platform", () => ({
  isWindows: () => isWindows(),
  isMac: () => false,
  isLinux: () => false,
}));

import { GET } from "@/app/api/terminal/shell-flavor/route";
import { resolveShell } from "@/lib/terminal/pty";

beforeEach(() => {
  isWindows.mockReturnValue(false);
});

describe("GET /api/terminal/shell-flavor agrees with resolveShell", () => {
  it("on Windows: route says powershell AND the PTY spawns powershell.exe", async () => {
    isWindows.mockReturnValue(true);

    const res = await GET();
    const body = (await res.json()) as { flavor: string };
    expect(body.flavor).toBe("powershell");

    const { shell } = resolveShell();
    expect(shell).toBe("powershell.exe");
  });

  it("off Windows: route says posix AND the PTY does not spawn powershell.exe", async () => {
    isWindows.mockReturnValue(false);

    const res = await GET();
    const body = (await res.json()) as { flavor: string };
    expect(body.flavor).toBe("posix");

    const { shell } = resolveShell();
    expect(shell).not.toBe("powershell.exe");
  });
});
