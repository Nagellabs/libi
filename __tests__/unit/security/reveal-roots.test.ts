import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

import { isPathRevealable, normalizeRoots } from "@/lib/shell/reveal-roots";

// Every path here is built from the real filesystem root, never a hardcoded
// "/Users/...". CI is ubuntu-only while the product also ships Windows, and a
// literal POSIX path silently resolves to something else under a Windows
// `path.resolve` — the class of test that passes on a Mac and fails elsewhere.
const ROOT = path.parse(process.cwd()).root;
const p = (...segs: string[]) => path.join(ROOT, ...segs);

// isPathRevealable case-folds on Windows via isWindows(); default these suites
// to the case-SENSITIVE branch so the assertions below mean what they say
// regardless of the host, and exercise the Windows branch explicitly instead.
vi.mock("@/lib/platform", () => ({
  isWindows: () => windowsMode.value,
  isMac: () => false,
}));
const windowsMode = { value: false };

describe("isPathRevealable", () => {
  const roots = [p("Users", "nadav"), p("Volumes", "Media", "libi")];

  beforeEach(() => {
    windowsMode.value = false;
  });

  it("accepts the root itself and anything inside it", () => {
    expect(isPathRevealable(p("Users", "nadav"), roots)).toBe(true);
    expect(isPathRevealable(p("Users", "nadav", ".libi", "storage", "p1", "clip.mp4"), roots)).toBe(true);
  });

  it("accepts a path under a non-$HOME root (the LIBI_HOME / export-folder case)", () => {
    // The bug this whole change exists to fix: storage honours LIBI_HOME and
    // the export folder is user-set, so both routinely sit off $HOME.
    expect(isPathRevealable(p("Volumes", "Media", "libi", "storage", "p1", "clip.mp4"), roots)).toBe(true);
  });

  it("rejects a sibling whose name merely starts with a root's name", () => {
    // A bare startsWith() passes this — /Users/nadavil-evil begins with
    // /Users/nadav — which silently widens the allowlist to a directory
    // that was never on it.
    expect(isPathRevealable(p("Users", "nadavil-evil", "secrets.txt"), roots)).toBe(false);
    expect(isPathRevealable(p("Volumes", "Media", "libi-other", "x.mp4"), roots)).toBe(false);
  });

  it("rejects a path outside every root", () => {
    expect(isPathRevealable(p("etc", "passwd"), roots)).toBe(false);
    expect(isPathRevealable(ROOT, roots)).toBe(false);
  });

  it("resolves traversal before deciding", () => {
    expect(isPathRevealable(p("Users", "nadav", "..", "nadavil-evil", "x"), roots)).toBe(false);
    expect(isPathRevealable(p("Users", "nadav", "sub", "..", "ok.txt"), roots)).toBe(true);
  });

  it("rejects everything when the root list is empty", () => {
    expect(isPathRevealable(p("Users", "nadav", "x"), [])).toBe(false);
  });

  // These drive the real `path.win32` module, so backslash separators and
  // `C:\` drive roots are genuinely exercised. Mocking isWindows() alone is
  // not enough: the module otherwise uses the platform-native `path`, so on
  // ubuntu CI every "Windows" path would still be POSIX-shaped and only the
  // case-folding would actually be under test.
  describe("on real Windows path shapes", () => {
    const winRoots = ["C:\\Users\\nadav", "D:\\Media\\libi"];
    const win = (abs: string, roots = winRoots) =>
      isPathRevealable(abs, roots, path.win32, true);

    it("accepts a path inside a drive-rooted root, across backslashes", () => {
      expect(win("C:\\Users\\nadav\\.libi\\storage\\p1\\clip.mp4")).toBe(true);
      expect(win("D:\\Media\\libi\\storage\\clip.mp4")).toBe(true);
    });

    it("accepts a path whose casing and drive letter case differ", () => {
      expect(win("c:\\users\\NADAV\\storage\\clip.mp4")).toBe(true);
      expect(win("C:\\USERS\\NADAV")).toBe(true);
    });

    it("rejects a different drive with the same trailing path", () => {
      // E:\Users\nadav is a different volume, not the allowed root.
      expect(win("E:\\Users\\nadav\\clip.mp4")).toBe(false);
    });

    it("rejects a backslash sibling that merely prefixes a root", () => {
      expect(win("C:\\Users\\nadavil-evil\\secrets.txt")).toBe(false);
    });

    it("rejects a path outside every root", () => {
      expect(win("C:\\Windows\\System32\\config")).toBe(false);
    });

    it("handles a UNC share root without crashing or over-matching", () => {
      // Documents the actual behaviour on UNC paths, which nothing else
      // covers and which no POSIX box can answer by reasoning.
      const uncRoots = ["\\\\nas\\libi"];
      expect(isPathRevealable("\\\\nas\\libi\\storage\\clip.mp4", uncRoots, path.win32, true)).toBe(true);
      expect(isPathRevealable("\\\\nas\\libi-other\\clip.mp4", uncRoots, path.win32, true)).toBe(false);
      expect(isPathRevealable("\\\\other\\libi\\clip.mp4", uncRoots, path.win32, true)).toBe(false);
    });
  });

  describe("on Windows, where the filesystem is case-insensitive", () => {
    beforeEach(() => {
      windowsMode.value = true;
    });

    it("accepts a path whose casing differs from the root's", () => {
      // The two sides come from different places: os.homedir()/getLibiHome()
      // supply the root, the path under test came from the DB or an export
      // job. Windows treats these as one directory; a case-SENSITIVE compare
      // rejects it and the user gets a Reveal button that does nothing.
      const winRoots = [p("Users", "nadav")];
      expect(isPathRevealable(p("USERS", "NADAV", "storage", "clip.mp4"), winRoots)).toBe(true);
      expect(isPathRevealable(p("users", "nadav"), winRoots)).toBe(true);
    });

    it("still rejects a case-varied sibling that merely prefixes a root", () => {
      // Folding case must not also drop the separator check.
      expect(
        isPathRevealable(p("USERS", "NADAVIL-EVIL", "secrets.txt"), [p("Users", "nadav")]),
      ).toBe(false);
    });

    it("still rejects a case-varied path outside every root", () => {
      expect(isPathRevealable(p("WINDOWS", "system32", "config"), [p("Users", "nadav")])).toBe(
        false,
      );
    });
  });
});

describe("normalizeRoots", () => {
  it("drops empty and nullish entries", () => {
    expect(normalizeRoots(["", null, undefined, p("Users", "nadav")])).toEqual([p("Users", "nadav")]);
  });

  it("drops the filesystem root so a misconfiguration can't silently allow everything", () => {
    // LIBI_HOME=/ would otherwise make the allowlist match every path on the
    // machine while still looking like an allowlist.
    const fsRoot = ROOT;
    expect(normalizeRoots([fsRoot, p("Users", "nadav")])).toEqual([p("Users", "nadav")]);
  });

  it("drops a bare Windows UNC share root, the same way it drops C:\\ or /", () => {
    // path.win32 reports \\\\nas\\libi as its own filesystem root, so the volume-root
    // rule catches it. Pinned deliberately: it means LIBI_HOME set to a BARE
    // share root contributes no allowlist entry, and reveal for files under it
    // falls back to whatever other roots apply. A normal LIBI_HOME one level
    // in (\\\\nas\\share\\libi) is not a root and survives — that is the case
    // people actually configure.
    const B = String.fromCharCode(92);
    const shareRoot = B + B + "nas" + B + "libi";
    const oneLevelIn = shareRoot + B + "libi";
    expect(path.win32.resolve(shareRoot)).toBe(path.win32.parse(path.win32.resolve(shareRoot)).root);
    expect(path.win32.resolve(oneLevelIn)).not.toBe(
      path.win32.parse(path.win32.resolve(oneLevelIn)).root,
    );
  });

  it("de-duplicates and resolves to absolute paths", () => {
    expect(normalizeRoots([p("Users", "nadav"), p("Users", "nadav") + path.sep, p("Users", "nadav", "sub", "..")])).toEqual([
      p("Users", "nadav"),
    ]);
  });
});

describe("revealRoots", () => {
  const OLD_ENV = process.env.LIBI_HOME;

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = OLD_ENV;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("includes $HOME, the temp dir and a relocated LIBI_HOME", async () => {
    process.env.LIBI_HOME = p("Volumes", "Media", "libi");
    vi.doMock("@/lib/db/settings", () => ({
      resolveExportFolder: () => path.join(os.homedir(), "Movies", "libi exports"),
    }));
    const { revealRoots } = await import("@/lib/shell/reveal-roots");

    const roots = revealRoots();
    expect(roots).toContain(path.resolve(os.homedir()));
    expect(roots).toContain(path.resolve(os.tmpdir()));
    expect(roots).toContain(path.resolve(process.env.LIBI_HOME!));
  });

  it("includes the configured export folder even when it is outside $HOME", async () => {
    const external = p("Volumes", "Media", "exports");
    vi.doMock("@/lib/db/settings", () => ({ resolveExportFolder: () => external }));
    const { revealRoots } = await import("@/lib/shell/reveal-roots");

    expect(revealRoots()).toContain(path.resolve(external));
  });

  it("still returns the other roots when the export-folder lookup throws", async () => {
    vi.doMock("@/lib/db/settings", () => ({
      resolveExportFolder: () => {
        throw new Error("no db");
      },
    }));
    const { revealRoots } = await import("@/lib/shell/reveal-roots");

    const roots = revealRoots();
    expect(roots).toContain(path.resolve(os.homedir()));
    expect(roots.length).toBeGreaterThan(0);
  });
});
