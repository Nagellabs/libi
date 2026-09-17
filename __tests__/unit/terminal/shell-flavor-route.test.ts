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
 * they always agree, with `isWindows()` mocked both ways — flipping
 * `isWindows` per test rather than relying on the host platform.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isWindows = vi.fn(() => false);
const isMac = vi.fn(() => false);
vi.mock("@/lib/platform", () => ({
  isWindows: () => isWindows(),
  isMac: () => isMac(),
  isLinux: () => false,
}));

import { GET } from "@/app/api/terminal/shell-flavor/route";
import { resolveSetupShell, resolveShell } from "@/lib/terminal/pty";

beforeEach(() => {
  isWindows.mockReturnValue(false);
  isMac.mockReturnValue(false);
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

describe("resolveSetupShell — a known shell regardless of $SHELL", () => {
  const prevShell = process.env.SHELL;
  afterEach(() => {
    if (prevShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = prevShell;
  });

  it("macOS: /bin/zsh -l even when $SHELL is fish", () => {
    isMac.mockReturnValue(true);
    process.env.SHELL = "/opt/homebrew/bin/fish";
    expect(resolveSetupShell()).toEqual({ shell: "/bin/zsh", args: ["-l"] });
    expect(resolveShell()).toEqual({ shell: "/opt/homebrew/bin/fish", args: ["-l"] }); // chat keeps $SHELL
  });
  it("Linux: /bin/bash -l", () => {
    expect(resolveSetupShell()).toEqual({ shell: "/bin/bash", args: ["-l"] });
  });
  it("Windows: powershell.exe", () => {
    isWindows.mockReturnValue(true);
    expect(resolveSetupShell()).toEqual({ shell: "powershell.exe", args: [] });
  });
});
