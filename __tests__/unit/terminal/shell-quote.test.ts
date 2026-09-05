import { describe, it, expect } from "vitest";
import {
  quoteForShell,
  buildInsertText,
} from "@/lib/terminal/shell-quote";

describe("quoteForShell", () => {
  it("leaves an ordinary path unquoted", () => {
    const p = "/Users/nadav/.libi/storage/p1/shot.png";
    expect(quoteForShell(p, "posix")).toBe(p);
  });

  it("quotes a path containing spaces", () => {
    expect(quoteForShell("/tmp/my shot.png", "posix")).toBe("'/tmp/my shot.png'");
  });

  it("escapes an embedded single quote per flavor", () => {
    expect(quoteForShell("/tmp/nadav's.png", "posix")).toBe("'/tmp/nadav'\\''s.png'");
    expect(quoteForShell("C:\\x\\nadav's.png", "powershell")).toBe("'C:\\x\\nadav''s.png'");
  });

  it("escapes EVERY embedded single quote, not just the first", () => {
    // Regression guard for a `.replaceAll` -> `.replace` mutation: a fixture
    // with only one embedded quote can't tell "escape all" from "escape
    // first" apart, so this one carries two.
    expect(quoteForShell("/tmp/o'brien's.png", "posix")).toBe(
      "'/tmp/o'\\''brien'\\''s.png'",
    );
    expect(quoteForShell("C:\\x\\o'brien's.png", "powershell")).toBe(
      "'C:\\x\\o''brien''s.png'",
    );
  });

  it("always quotes for powershell, even an unremarkable path", () => {
    // There used to be a PowerShell "safe to leave bare" character class
    // mirroring the POSIX one (plus backslash), and this path stayed bare
    // under it. It's gone now: `lib/agents/terminal-remedy.ts`'s own
    // "does this path look tame?" test proved any such heuristic is a trap —
    // it accepted a plain `C:\…\claude.cmd` as tame but rejected
    // `C:\…\@nagellabslibi\…` (the `@`), so two sign-in remedies typing a
    // path into the same PowerShell PTY took different branches, and only
    // one of them was ever exercised before shipping. Always-quoting removes
    // the branch instead of trying to draw the character class more
    // carefully. A quoted path is still a valid path.
    const p = "C:\\Users\\nadav\\.libi\\storage\\shot.png";
    expect(quoteForShell(p, "powershell")).toBe(`'${p}'`);
  });

  it("QUOTES a backslash for posix, where it is an escape character", () => {
    // The bug this case exists to prevent: an unquoted backslash is consumed
    // by zsh/bash, so `/tmp/a\b.png` pasted bare reaches the CLI as
    // `/tmp/ab.png` — a path that does not exist. It must be quoted.
    expect(quoteForShell("/tmp/a\\b.png", "posix")).toBe("'/tmp/a\\b.png'");
  });

  it("quotes shell metacharacters", () => {
    expect(quoteForShell("/tmp/a$b.png", "posix")).toBe("'/tmp/a$b.png'");
    expect(quoteForShell("/tmp/a;b.png", "posix")).toBe("'/tmp/a;b.png'");
    expect(quoteForShell("/tmp/a`b.png", "powershell")).toBe("'/tmp/a`b.png'");
  });

  it("quotes `%` and `=` as the FIRST character, where each is unsafe", () => {
    // Verified in real shells: a leading `%` is a job spec to bash/zsh
    // (`bash: fg: no job control`), and a leading `=` triggers zsh's
    // on-by-default EQUALS expansion (`zsh:1: myfile.png not found`). Both
    // are safe mid-token — see the next test — so the safe set must treat
    // position 0 differently from the rest, not exclude `%`/`=` outright.
    expect(quoteForShell("%report.png", "posix")).toBe("'%report.png'");
    expect(quoteForShell("=draft.png", "posix")).toBe("'=draft.png'");
  });

  it("leaves `%` and `=` bare mid-token, where they carry no special meaning", () => {
    const p = "/tmp/a%b=c.png";
    expect(quoteForShell(p, "posix")).toBe(p);
  });

  it("leaves every widened POSIX-safe character bare, not just the ones the ordinary-path fixture happens to contain", () => {
    // The "ordinary path" fixture above never exercises `@ % + = ,` — a
    // reviewer once deleted `@` from the safe set and only an unrelated
    // agents-module test caught it. This fixture pins the full class,
    // mid-token where every character in it is unconditionally safe.
    const p = "/x/@scope/pkg-1.0/a,b+c=d%e/f";
    expect(quoteForShell(p, "posix")).toBe(p);
  });
});

describe("buildInsertText", () => {
  it("joins multiple paths with a single space and a trailing space", () => {
    expect(buildInsertText(["/tmp/a.png", "/tmp/b.png"], "posix")).toBe(
      "/tmp/a.png /tmp/b.png ",
    );
  });

  it("quotes only the paths that need it", () => {
    expect(buildInsertText(["/tmp/a.png", "/tmp/b c.png"], "posix")).toBe(
      "/tmp/a.png '/tmp/b c.png' ",
    );
  });

  it("ends a non-empty result with a single trailing space", () => {
    // Native terminals (macOS Terminal, iTerm2, GNOME Terminal) all do this
    // on file drag-drop. It also fixes the abutting-drops bug: see the test
    // below.
    expect(buildInsertText(["/tmp/a.png"], "posix")).toBe("/tmp/a.png ");
  });

  it("never appends a trailing newline", () => {
    // Load-bearing: the path is pasted, not run. A newline would submit it
    // into a CLI that may not be at its prompt. A trailing SPACE (added
    // above) is not a trailing newline — this must keep passing.
    expect(buildInsertText(["/tmp/a.png"], "posix")).not.toMatch(/[\r\n]/);
  });

  it("returns an empty string for no paths", () => {
    // No lone trailing space for an empty result.
    expect(buildInsertText([], "posix")).toBe("");
  });

  it("does not let two consecutive drops abut into one bogus path", () => {
    // The real bug: the hook calls buildInsertText once per drop and the PTY
    // concatenates whatever text arrives. Without a trailing space on the
    // first call, "/tmp/a.png" + "/tmp/b.png" reads as one path to the shell.
    const first = buildInsertText(["/tmp/a.png"], "posix");
    const second = buildInsertText(["/tmp/b.png"], "posix");
    const combined = first + second;

    expect(combined).toBe("/tmp/a.png /tmp/b.png ");
    expect(combined).not.toMatch(/png\/tmp/);
    expect(combined).toMatch(/^\S+\s+\S+/);
  });
});
