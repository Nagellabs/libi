// Tests for the "can this install replace itself?" probe
// (electron/self-update-probe.ts).
//
// The bug being fixed is a silent one — 481 MB downloaded, then a log line
// nobody sees — so most of these assert the CLASSIFICATION that produces the
// user-facing message. The single most important one is the false-block
// guard: a writable non-/Applications path must be allowed, because a false
// block leaves the user with no workaround at all.
//
// Paths are injected throughout. The real app directory is never touched.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearPendingShellDownload,
  probeSelfUpdate,
  updateBundlePath,
} from "@/electron/self-update-probe";

/** A write probe that refuses everything — "this directory is read-only". */
const readOnly = () => false;
/** A write probe that accepts everything — "this directory is writable". */
const writable = () => true;

describe("updateBundlePath", () => {
  it("walks up from the macOS executable to the .app bundle", () => {
    expect(
      updateBundlePath("darwin", "/Applications/Libi.app/Contents/MacOS/Libi"),
    ).toBe("/Applications/Libi.app");
  });

  it("keeps the OUTERMOST .app when one is nested inside another", () => {
    // A helper bundle inside the app: /X.app/Contents/Frameworks/Y.app/...
    // Squirrel replaces the outer one, so the inner must not win.
    expect(
      updateBundlePath(
        "darwin",
        "/Applications/Libi.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
      ),
    ).toBe("/Applications/Libi.app");
  });

  it("uses the AppImage FILE on Linux, not the executable inside its mount", () => {
    // The executable lives in a read-only squashfs mount; probing next to it
    // would block every AppImage user. electron-updater replaces the file.
    expect(
      updateBundlePath("linux", "/tmp/.mount_Libi42/usr/bin/libi", "/home/u/Apps/Libi.AppImage"),
    ).toBe("/home/u/Apps/Libi.AppImage");
  });

  it("uses the executable itself on Windows", () => {
    expect(updateBundlePath("win32", "C:\\Program Files\\Libi\\Libi.exe")).toBe(
      "C:\\Program Files\\Libi\\Libi.exe",
    );
  });
});

describe("probeSelfUpdate", () => {
  // THE regression this design most needs pinned. `isInApplicationsFolder()`
  // would say no here; the write probe says yes, and the write probe is right.
  it("allows a writable path that is NOT /Applications", () => {
    const result = probeSelfUpdate({
      platform: "darwin",
      execPath: "/Users/u/Applications/Libi.app/Contents/MacOS/Libi",
      isInApplicationsFolder: false,
      canWrite: writable,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("allows the ordinary /Applications install", () => {
    const result = probeSelfUpdate({
      platform: "darwin",
      execPath: "/Applications/Libi.app/Contents/MacOS/Libi",
      isInApplicationsFolder: true,
      canWrite: writable,
    });
    expect(result.ok).toBe(true);
  });

  // The live failure, verbatim: this is the path from the 0.1.2 QA run.
  it("classifies an App Translocation path as translocated", () => {
    const execPath =
      "/private/var/folders/gh/x8k/T/AppTranslocation/A1B2/d/Libi.app/Contents/MacOS/Libi";
    const result = probeSelfUpdate({
      platform: "darwin",
      execPath,
      isInApplicationsFolder: false,
      canWrite: readOnly,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("translocated");
    // The path is the evidence, and the message shows it verbatim.
    expect(result.path).toBe(
      "/private/var/folders/gh/x8k/T/AppTranslocation/A1B2/d/Libi.app",
    );
  });

  it("classifies a mounted disk image as running-from-dmg", () => {
    const result = probeSelfUpdate({
      platform: "darwin",
      execPath: "/Volumes/Libi 0.1.2/Libi.app/Contents/MacOS/Libi",
      isInApplicationsFolder: false,
      canWrite: readOnly,
    });
    expect(result.reason).toBe("running-from-dmg");
  });

  it("classifies an unwritable non-Applications path as not-in-applications", () => {
    const result = probeSelfUpdate({
      platform: "darwin",
      execPath: "/opt/libi/Libi.app/Contents/MacOS/Libi",
      isInApplicationsFolder: false,
      canWrite: readOnly,
    });
    expect(result.reason).toBe("not-in-applications");
  });

  it("classifies an unwritable /Applications as read-only-location", () => {
    // A managed Mac: the app IS in Applications, and still can't be written.
    const result = probeSelfUpdate({
      platform: "darwin",
      execPath: "/Applications/Libi.app/Contents/MacOS/Libi",
      isInApplicationsFolder: true,
      canWrite: readOnly,
    });
    expect(result.reason).toBe("read-only-location");
  });

  // "not-in-applications" is macOS copy. On Windows there is no Applications
  // folder to not be in, and saying so would be nonsense.
  it("never says not-in-applications off macOS", () => {
    const result = probeSelfUpdate({
      platform: "win32",
      execPath: "C:\\Program Files\\Libi\\Libi.exe",
      canWrite: readOnly,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("read-only-location");
  });

  // apt/dnf installs are updated by the package manager. electron-updater
  // never tries to replace them, so blocking would be a pure false positive.
  it("never blocks a package-managed Linux install", () => {
    const result = probeSelfUpdate({
      platform: "linux",
      execPath: "/usr/lib/libi/libi",
      appImagePath: null,
      canWrite: readOnly,
    });
    expect(result.ok).toBe(true);
  });

  it("does block a read-only AppImage location", () => {
    const result = probeSelfUpdate({
      platform: "linux",
      execPath: "/tmp/.mount_Libi42/usr/bin/libi",
      appImagePath: "/media/readonly/Libi.AppImage",
      canWrite: readOnly,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("read-only-location");
  });

  // The default probe is a real write. Prove it answers honestly both ways
  // rather than only ever being exercised through the injected stub.
  it("really writes when no probe is injected", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-probe-"));
    try {
      const ok = probeSelfUpdate({
        platform: "darwin",
        execPath: path.join(tmp, "Libi.app", "Contents", "MacOS", "Libi"),
        isInApplicationsFolder: false,
      });
      expect(ok.ok).toBe(true);
      // …and leaves nothing behind.
      expect(fs.readdirSync(tmp)).toEqual([]);

      const missing = probeSelfUpdate({
        platform: "darwin",
        execPath: path.join(tmp, "gone", "nowhere", "Libi.app", "Contents", "MacOS", "Libi"),
        isInApplicationsFolder: false,
      });
      expect(missing.ok).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("clearPendingShellDownload", () => {
  it("does nothing when there is no app-update.yml to read", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pending-"));
    try {
      expect(clearPendingShellDownload(tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes the pending directory named by app-update.yml", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pending-"));
    const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-cache-"));
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_CACHE_HOME;
    try {
      // getAppCacheDir reads HOME on darwin and XDG_CACHE_HOME on linux; set
      // both so this test does not depend on which machine runs it.
      process.env.HOME = cacheHome;
      process.env.XDG_CACHE_HOME = path.join(cacheHome, ".cache");
      fs.writeFileSync(
        path.join(tmp, "app-update.yml"),
        "provider: github\nupdaterCacheDirName: libi-test-updater\n",
      );
      const base =
        process.platform === "darwin"
          ? path.join(cacheHome, "Library", "Caches")
          : process.platform === "win32"
            ? process.env.LOCALAPPDATA || path.join(cacheHome, "AppData", "Local")
            : path.join(cacheHome, ".cache");
      const pending = path.join(base, "libi-test-updater", "pending");
      fs.mkdirSync(pending, { recursive: true });
      fs.writeFileSync(path.join(pending, "Libi-0.1.2-arm64-mac.zip"), "x");

      expect(clearPendingShellDownload(tmp)).toBe(pending);
      expect(fs.existsSync(pending)).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevXdg;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(cacheHome, { recursive: true, force: true });
    }
  });
});
