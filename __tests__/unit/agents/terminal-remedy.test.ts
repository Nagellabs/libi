/**
 * The sign-in remedies are strings TYPED into libi's built-in Terminal, whose
 * shell is PowerShell on Windows and the user's login `sh` everywhere else
 * (`lib/terminal/pty.ts#resolveShell`). PowerShell parses a statement that
 * starts with a quoted string as an EXPRESSION, so the line has to carry the
 * call operator `&` or nothing runs.
 *
 * Observed on the QA box, 2026-08-23, from the "Sign in to Codex" button:
 *
 *   PS …> 'C:\…\@openai\codex-win32-x64\…\codex.exe' login
 *   Unexpected token 'login' in expression or statement.
 *
 * The platform is pinned per test rather than inherited: the suite runs on
 * macOS here and ubuntu in CI, and neither would ever exercise the branch that
 * broke.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isWindows = vi.fn(() => false);
vi.mock("@/lib/platform", () => ({
  isWindows: () => isWindows(),
  isMac: () => false,
  isLinux: () => false,
}));

const resolveCodexNativeBinary = vi.fn<(root: string) => string | null>();
vi.mock("@/lib/agents/codex-native-binary", () => ({
  resolveCodexNativeBinary: (root: string) => resolveCodexNativeBinary(root),
}));

import {
  codexSignInRemedy,
  claudeSignInRemedy,
  codexInstallRemedy,
} from "@/lib/agents/terminal-remedy";

/** The exact path from the machine that reported the bug. */
const WIN_CODEX =
  "C:\\Users\\libiqa\\AppData\\Local\\Programs\\@nagellabslibi\\resources\\libi-bundle" +
  "\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
const POSIX_CODEX =
  "/Applications/Libi.app/Contents/Resources/libi-bundle/node_modules/@openai/codex-darwin-arm64" +
  "/vendor/aarch64-apple-darwin/bin/codex";

beforeEach(() => {
  isWindows.mockReturnValue(false);
  resolveCodexNativeBinary.mockReset();
});

describe("codexSignInRemedy", () => {
  it("on Windows, invokes the engine with the call operator", () => {
    isWindows.mockReturnValue(true);
    resolveCodexNativeBinary.mockReturnValue(WIN_CODEX);
    const remedy = codexSignInRemedy("C:\\root");
    expect(remedy?.command).toBe(`& '${WIN_CODEX}' login`);
  });

  it("on Windows, never emits the bare quoted form that PowerShell rejects", () => {
    isWindows.mockReturnValue(true);
    resolveCodexNativeBinary.mockReturnValue(WIN_CODEX);
    const command = codexSignInRemedy("C:\\root")!.command;
    // This is the regression, character for character: a line that STARTS with
    // a quote is an expression to PowerShell, and `login` after it is a syntax
    // error rather than an argument.
    expect(command.startsWith("'")).toBe(false);
    expect(command).toMatch(/^& /);
  });

  it("on POSIX, quotes the path and adds no call operator", () => {
    resolveCodexNativeBinary.mockReturnValue(POSIX_CODEX);
    const remedy = codexSignInRemedy("/root");
    expect(remedy?.command).toBe(`'${POSIX_CODEX}' login`);
    expect(remedy?.command).not.toContain("&");
  });

  it("leaves an unremarkable POSIX path unquoted", () => {
    resolveCodexNativeBinary.mockReturnValue("/usr/local/bin/codex");
    expect(codexSignInRemedy("/root")?.command).toBe("/usr/local/bin/codex login");
  });

  it("returns null when there is no root or no bundled engine", () => {
    expect(codexSignInRemedy(null)).toBeNull();
    resolveCodexNativeBinary.mockReturnValue(null);
    expect(codexSignInRemedy("/root")).toBeNull();
  });
});

describe("claudeSignInRemedy", () => {
  it("on Windows, invokes the CLI rather than printing its path", () => {
    isWindows.mockReturnValue(true);
    const bin = "C:\\Users\\libiqa\\AppData\\Roaming\\libi\\agents\\node_modules\\.bin\\claude.cmd";
    // Without `&` PowerShell echoes the path and exits 0 — the button appears
    // to work and nothing happens, which is worse than the codex parse error.
    expect(claudeSignInRemedy(bin).command).toBe(`& '${bin}'`);
  });

  it("keeps the bare PATH fallback bare on both platforms", () => {
    expect(claudeSignInRemedy(null).command).toBe("claude");
    isWindows.mockReturnValue(true);
    expect(claudeSignInRemedy(null).command).toBe("claude");
  });

  it("on POSIX, leaves an unremarkable path unquoted", () => {
    expect(claudeSignInRemedy("/opt/libi/bin/claude").command).toBe("/opt/libi/bin/claude");
  });
});

describe("quoting rules differ per shell", () => {
  it("PowerShell escapes an embedded quote by doubling it", () => {
    isWindows.mockReturnValue(true);
    resolveCodexNativeBinary.mockReturnValue("C:\\Users\\o'brien\\codex.exe");
    // The POSIX `'\''` idiom would terminate the PowerShell string early.
    expect(codexSignInRemedy("C:\\root")?.command).toBe(
      "& 'C:\\Users\\o''brien\\codex.exe' login",
    );
  });

  it("POSIX escapes an embedded quote the POSIX way", () => {
    resolveCodexNativeBinary.mockReturnValue("/Users/o'brien/codex");
    expect(codexSignInRemedy("/root")?.command).toBe(`'/Users/o'\\''brien/codex' login`);
  });

  it("POSIX never leaves a backslash bare, where it would be an escape", () => {
    resolveCodexNativeBinary.mockReturnValue("/weird/pa\\th/codex");
    expect(codexSignInRemedy("/root")?.command).toBe("'/weird/pa\\th/codex' login");
  });
});

describe("codexInstallRemedy", () => {
  it("is a bare command name and needs no shell treatment", () => {
    isWindows.mockReturnValue(true);
    expect(codexInstallRemedy().command).toBe("npm i -g @openai/codex");
  });
});
