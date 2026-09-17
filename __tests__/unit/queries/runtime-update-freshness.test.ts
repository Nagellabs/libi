/**
 * Two of the three "wrongs" fixed in this task, both pure-function testable
 * without rendering a query or a component:
 *
 *  - `pollInterval()` — the card must poll unconditionally (slowly when idle,
 *    fast while something moves), not sit forever on the snapshot it
 *    mounted with.
 *  - `restartOffer()` — must not offer to restart into a staged runtime while
 *    the desktop shell is fetching its own update; that restart would kill
 *    the in-flight download (observed 2026-09-07: 340 MB discarded).
 *
 * Also `isShellInstallInFlight()` — it must agree with `restartOffer()` about
 * exactly the same window (an auto-download shell fetching, or about to,
 * starting from `update-available`), or Settings shows a silent dead zone:
 * slow polling, no "Downloading" badge, no explanation, yet a "Next launch"
 * row that promises a restart nothing can act on.
 */
import { describe, expect, it } from "vitest";

import {
  IDLE_POLL_MS,
  isShellInstallInFlight,
  pollInterval,
  restartOffer,
  type RuntimeUpdateDto,
  type ShellUpdateStatusDto,
} from "@/lib/queries/runtime-update";
import type { JobStatusSnapshot } from "@/lib/jobs/types";

function job(overrides: Partial<JobStatusSnapshot & { version: string | null }>) {
  const base: JobStatusSnapshot & { version: string | null } = {
    id: "job-1",
    kind: "runtime_update",
    status: "running",
    pieceId: null,
    fileId: null,
    progressDone: 1,
    progressTotal: 2,
    progressUnit: "bytes",
    etaMs: null,
    msPerUnit: null,
    msSinceProgress: null,
    error: null,
    resultJson: null,
    startedAt: new Date(),
    completedAt: null,
    lastProgressAt: new Date(),
    version: null,
  };
  return { ...base, ...overrides };
}

const shell: ShellUpdateStatusDto = {
  phase: "up-to-date",
  currentVersion: "0.1.8",
  latestVersion: null,
  percent: null,
  error: null,
  checkedAt: Date.now(),
  autoDownload: true,
};

const base: RuntimeUpdateDto = {
  current: { version: "0.1.12", source: "npm", shellApiVersion: 3, bundledVersion: null },
  shellApi: { min: 1, max: 3 },
  update: {
    state: "up-to-date",
    currentVersion: "0.1.12",
    latestVersion: null,
    latestShellApiVersion: null,
    checkedAt: Date.now(),
  },
  pendingVersion: null,
  install: null,
  shell: null,
};

const idleDto: RuntimeUpdateDto = { ...base };

const downloadingDto: RuntimeUpdateDto = {
  ...base,
  install: job({ status: "running", version: "0.1.13" }),
};

describe("pollInterval", () => {
  it("polls slowly when nothing is in flight", () => {
    expect(pollInterval(idleDto)).toBe(IDLE_POLL_MS);
  });

  it("polls fast while an install runs", () => {
    expect(pollInterval(downloadingDto)).toBe(2000);
  });
});

describe("restartOffer — shell-in-flight suppression", () => {
  it("suppresses the runtime restart while the desktop update is downloading", () => {
    const dto: RuntimeUpdateDto = {
      ...base,
      pendingVersion: "0.1.13",
      shell: { ...shell, phase: "downloading", latestVersion: "0.1.9" },
    };
    expect(restartOffer(dto)).toBeNull();
  });

  it("suppresses the runtime restart while a desktop update is available (about to fetch)", () => {
    const dto: RuntimeUpdateDto = {
      ...base,
      pendingVersion: "0.1.13",
      shell: { ...shell, phase: "update-available", latestVersion: "0.1.9" },
    };
    expect(restartOffer(dto)).toBeNull();
  });

  it("suppresses the runtime restart while an OLD shell is quitting into its own update", () => {
    // The old shell restarts itself ~2.5s after `ready`. Offering a runtime
    // restart here printed "restart whenever suits you" directly beside
    // "Restarting Libi…", and the click raced the shell's own quit.
    const dto: RuntimeUpdateDto = {
      ...base,
      pendingVersion: "0.1.13",
      shell: { ...shell, phase: "ready", latestVersion: "0.1.9", autoDownload: undefined },
    };
    expect(restartOffer(dto)).toBeNull();
  });

  it("still offers the runtime restart when the shell channel is idle", () => {
    const dto: RuntimeUpdateDto = {
      ...base,
      pendingVersion: "0.1.13",
      shell: { ...shell, phase: "up-to-date" },
    };
    expect(restartOffer(dto)).toEqual({ target: "runtime", version: "0.1.13" });
  });

  it("prefers the ready shell over a staged runtime", () => {
    const dto: RuntimeUpdateDto = {
      ...base,
      pendingVersion: "0.1.13",
      shell: { ...shell, phase: "ready", latestVersion: "0.1.9", autoDownload: true },
    };
    expect(restartOffer(dto)).toEqual({ target: "shell", version: "0.1.9" });
  });
});

describe("isShellInstallInFlight — agreeing with restartOffer's suppression window", () => {
  it("is in-flight the instant an auto-download shell reports update-available", () => {
    const dto: RuntimeUpdateDto = {
      ...base,
      shell: { ...shell, phase: "update-available", latestVersion: "0.1.9", autoDownload: true },
    };
    expect(isShellInstallInFlight(dto)).toBe(true);
    // And the fast poll follows from it.
    expect(pollInterval(dto)).toBe(2000);
  });

  it("stays false for an OLD shell's update-available — that is a stationary click-to-install offer", () => {
    const dto: RuntimeUpdateDto = {
      ...base,
      shell: { ...shell, phase: "update-available", latestVersion: "0.1.9", autoDownload: false },
    };
    expect(isShellInstallInFlight(dto)).toBe(false);
    expect(pollInterval(dto)).toBe(IDLE_POLL_MS);
  });

  it("stays false for an old shell even when autoDownload is simply absent", () => {
    const oldShell: ShellUpdateStatusDto = {
      phase: "update-available",
      currentVersion: "0.1.8",
      latestVersion: "0.1.9",
      percent: null,
      error: null,
      checkedAt: Date.now(),
      // autoDownload deliberately omitted — old shells never send it.
    };
    const dto: RuntimeUpdateDto = { ...base, shell: oldShell };
    expect(isShellInstallInFlight(dto)).toBe(false);
  });
});
