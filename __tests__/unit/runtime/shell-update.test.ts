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
import { updateOffer, type RuntimeUpdateDto } from "@/lib/queries/runtime-update";

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
    pendingVersion: null,
    install: null,
    shell: over.shell ?? null,
  };
}

const shellOffer: RuntimeUpdateDto["shell"] = {
  phase: "update-available",
  currentVersion: "0.1.0",
  latestVersion: "0.4.0",
  percent: null,
  error: null,
  checkedAt: 0,
};

describe("updateOffer — the one thing the user is offered", () => {
  it("returns null when neither channel has anything", () => {
    expect(updateOffer(undefined)).toBeNull();
    expect(updateOffer(dto({}))).toBeNull();
    expect(updateOffer(dto({ shell: { ...shellOffer!, phase: "error" } }))).toBeNull();
  });

  it("offers the runtime channel", () => {
    expect(updateOffer(dto({ state: "update-available", latestVersion: "0.2.0" }))).toEqual({
      target: "runtime",
      version: "0.2.0",
    });
  });

  it("offers the shell channel — including for `shell-update-required`, whose remedy it is", () => {
    expect(updateOffer(dto({ shell: shellOffer }))).toEqual({
      target: "shell",
      version: "0.4.0",
    });
    expect(
      updateOffer(dto({ state: "shell-update-required", latestVersion: "0.5.0", shell: shellOffer })),
    ).toEqual({ target: "shell", version: "0.4.0" });
  });

  it("prefers the shell when both channels offer — the reverse could install a runtime the old shell can't run", () => {
    expect(
      updateOffer(dto({ state: "update-available", latestVersion: "0.2.0", shell: shellOffer })),
    ).toEqual({ target: "shell", version: "0.4.0" });
  });
});
