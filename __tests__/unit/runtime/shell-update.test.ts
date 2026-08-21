// The shell-updater bridge slot (lib/runtime/shell-update.ts) and the offer
// logic built on top of it (lib/queries/runtime-update.ts#updateOffer).
//
// The slot itself is four lines; what the tests pin down is the CONTRACT the
// UI depends on: registration survives module-instance splits (globalThis,
// not a module variable — same reasoning as lifecycle/relaunch.ts), and the
// offer collapse prefers the shell for the documented reason.
import { describe, it, expect, beforeEach } from "vitest";

import {
  getShellUpdater,
  registerShellUpdater,
  type ShellUpdater,
  type ShellUpdateStatus,
} from "@/lib/runtime/shell-update";
import { restartOffer, updateOffer, type RuntimeUpdateDto } from "@/lib/queries/runtime-update";

function makeUpdater(status: Partial<ShellUpdateStatus> = {}): ShellUpdater {
  return {
    getStatus: () => ({
      phase: "idle",
      currentVersion: "0.1.0",
      latestVersion: null,
      percent: null,
      error: null,
      checkedAt: null,
      ...status,
    }),
    checkNow: async () => {},
    download: () => {},
  };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).__libiShellUpdater = null;
});

describe("shell updater slot", () => {
  it("is empty until the shell registers — dev / npx / pre-updater shells", () => {
    expect(getShellUpdater()).toBeNull();
  });

  it("hands back what was registered, via globalThis so a bundle split can't hide it", () => {
    const updater = makeUpdater();
    registerShellUpdater(updater);
    expect(getShellUpdater()).toBe(updater);
    // The property the OTHER module instance (Turbopack's route bundle)
    // would read — the whole reason this is not a module variable.
    expect((globalThis as Record<string, unknown>).__libiShellUpdater).toBe(updater);
  });
});

function dto(over: {
  state?: RuntimeUpdateDto["update"]["state"];
  latestVersion?: string | null;
  pendingVersion?: string | null;
  install?: RuntimeUpdateDto["install"];
  shell?: RuntimeUpdateDto["shell"];
}): RuntimeUpdateDto {
  return {
    current: { version: "0.1.0", source: "bundled", shellApiVersion: 1 },
    shellApi: { min: 1, max: 1 },
    update: {
      state: over.state ?? "up-to-date",
      currentVersion: "0.1.0",
      latestVersion: over.latestVersion ?? null,
      latestShellApiVersion: 1,
      checkedAt: 0,
    },
    pendingVersion: over.pendingVersion ?? null,
    install: over.install ?? null,
    shell: over.shell ?? null,
  };
}

const failedInstall = { status: "failed" } as unknown as RuntimeUpdateDto["install"];

const shellOffer: RuntimeUpdateDto["shell"] = {
  phase: "update-available",
  currentVersion: "0.1.0",
  latestVersion: "0.4.0",
  percent: null,
  error: null,
  checkedAt: 0,
};

describe("updateOffer — updates that still need a CLICK to download", () => {
  it("returns null when neither channel has anything", () => {
    expect(updateOffer(undefined)).toBeNull();
    expect(updateOffer(dto({}))).toBeNull();
    expect(updateOffer(dto({ shell: { ...shellOffer!, phase: "error" } }))).toBeNull();
  });

  it("a fresh runtime update is NOT an offer — the server downloads it itself", () => {
    expect(updateOffer(dto({ state: "update-available", latestVersion: "0.2.0" }))).toBeNull();
  });

  it("offers the runtime channel only after its auto-download failed", () => {
    expect(
      updateOffer(
        dto({ state: "update-available", latestVersion: "0.2.0", install: failedInstall }),
      ),
    ).toEqual({ target: "runtime", version: "0.2.0" });
  });

  it("offers an OLD shell's update — including for `shell-update-required`, whose remedy it is", () => {
    expect(updateOffer(dto({ shell: shellOffer }))).toEqual({
      target: "shell",
      version: "0.4.0",
    });
    expect(
      updateOffer(dto({ state: "shell-update-required", latestVersion: "0.5.0", shell: shellOffer })),
    ).toEqual({ target: "shell", version: "0.4.0" });
  });

  it("a NEW shell's update is NOT an offer — it downloads itself", () => {
    expect(updateOffer(dto({ shell: { ...shellOffer!, autoDownload: true } }))).toBeNull();
  });

  it("prefers the shell when both channels offer — the reverse could install a runtime the old shell can't run", () => {
    expect(
      updateOffer(
        dto({
          state: "update-available",
          latestVersion: "0.2.0",
          install: failedInstall,
          shell: shellOffer,
        }),
      ),
    ).toEqual({ target: "shell", version: "0.4.0" });
  });
});

describe("restartOffer — downloaded updates waiting for their restart", () => {
  it("returns null when nothing is downloaded", () => {
    expect(restartOffer(undefined)).toBeNull();
    expect(restartOffer(dto({}))).toBeNull();
    expect(restartOffer(dto({ shell: shellOffer }))).toBeNull();
  });

  it("offers a staged runtime download", () => {
    expect(restartOffer(dto({ pendingVersion: "0.2.0" }))).toEqual({
      target: "runtime",
      version: "0.2.0",
    });
  });

  it("offers a NEW shell's ready download, and prefers it over a staged runtime", () => {
    const readyShell = { ...shellOffer!, phase: "ready" as const, autoDownload: true };
    expect(restartOffer(dto({ shell: readyShell }))).toEqual({
      target: "shell",
      version: "0.4.0",
    });
    expect(restartOffer(dto({ pendingVersion: "0.2.0", shell: readyShell }))).toEqual({
      target: "shell",
      version: "0.4.0",
    });
  });

  it("an OLD shell's ready state is a self-restart in progress, never an offer", () => {
    expect(restartOffer(dto({ shell: { ...shellOffer!, phase: "ready" } }))).toBeNull();
  });
});
