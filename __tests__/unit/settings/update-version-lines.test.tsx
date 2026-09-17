// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { RuntimeUpdateDto } from "@/lib/queries/runtime-update";

/**
 * The confusion the report was about: one bare version number per row, with
 * nothing distinguishing "running now" from "downloaded, applies at next
 * launch" — and no signal at all while a download is actually in flight.
 * `useRuntimeUpdate` and its mutations are mocked here so the assertions are
 * about `UpdatesSection`'s own rendering, not the query layer (that is
 * `runtime-update-freshness.test.ts`'s job).
 */

let dto: RuntimeUpdateDto | undefined;
const recheckMutate = vi.fn();
const installMutate = vi.fn();
const restartMutate = vi.fn();

vi.mock("@/lib/queries/runtime-update", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/queries/runtime-update")>();
  return {
    ...original,
    useRuntimeUpdate: () => ({ data: dto, isLoading: false, isError: false }),
    useRecheckRuntimeUpdate: () => ({ mutate: recheckMutate, isPending: false }),
    useInstallRuntimeUpdate: () => ({ mutate: installMutate, isPending: false, isError: false }),
    useRestartToApply: () => ({
      mutate: restartMutate,
      isPending: false,
      isIdle: true,
      isError: false,
    }),
  };
});

import { UpdatesSection, pendingRuntimeLine } from "@/components/settings/updates-section";

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

beforeEach(() => {
  recheckMutate.mockClear();
  installMutate.mockClear();
  restartMutate.mockClear();
  dto = undefined;
});

describe("UpdatesSection — version lines", () => {
  it("separates the running runtime from the one that applies at next launch", () => {
    dto = {
      ...base,
      pendingVersion: "0.1.13",
      update: { ...base.update, state: "update-available", latestVersion: "0.1.13" },
    };
    render(<UpdatesSection />);
    expect(screen.getByText("Runtime").parentElement).toHaveTextContent("0.1.12");
    expect(screen.getByText("Next launch").parentElement).toHaveTextContent("0.1.13");
  });

  it("says a version is downloading rather than printing it bare", () => {
    dto = {
      ...base,
      install: {
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
        version: "0.1.13",
      },
    };
    render(<UpdatesSection />);
    expect(screen.getByText("Next launch").parentElement).toHaveTextContent(/downloading/i);
  });

  it("shows a badge while a download runs", () => {
    dto = {
      ...base,
      install: {
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
        version: "0.1.13",
      },
    };
    render(<UpdatesSection />);
    // Exact match: distinguishes the header BADGE ("Downloading") from the
    // narrative copy elsewhere on the card that also mentions downloading
    // ("downloading…" in the Next-launch row, "Downloading Libi 0.1.13 in
    // the background…" in the progress paragraph) — the busiest minutes
    // must show a badge, not just prose someone could miss.
    expect(screen.getByText("Downloading")).toBeInTheDocument();
  });

  it("says Restarting, not Downloading, while an old shell quits into its update", () => {
    // An old shell (no autoDownload) at `ready` counts as in-flight but its
    // download has FINISHED — it is restarting itself. Labelling that
    // "Downloading" put the wrong word beside a body that said
    // "Restarting Libi…", and the staged-runtime restart offer used to sit
    // there too, inviting a click that raced the shell's own quit.
    dto = {
      ...base,
      pendingVersion: "0.1.13",
      shell: {
        phase: "ready",
        currentVersion: "0.1.8",
        latestVersion: "0.1.9",
        percent: 100,
        error: null,
        checkedAt: Date.now(),
      },
    };
    render(<UpdatesSection />);
    expect(screen.getByText("Restarting")).toBeInTheDocument();
    expect(screen.queryByText("Downloading")).not.toBeInTheDocument();
    expect(screen.queryByText("Update ready")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /restart to apply/i }),
    ).not.toBeInTheDocument();
  });

  it("shows nothing extra when what is running is already the newest thing on disk", () => {
    dto = { ...base };
    render(<UpdatesSection />);
    expect(screen.queryByText("Next launch")).not.toBeInTheDocument();
  });
});

/**
 * `pendingRuntimeLine` exercised directly rather than only through the rendered
 * card — it is exported specifically so this pair could be pinned as a pure
 * function (Finding 6), and the "both exist" case below is exactly the bug
 * (Finding 5b): the helper used to prefer `pendingVersion` unconditionally,
 * which made a NEWER download running while an OLDER one was staged invisible.
 */
describe("pendingRuntimeLine", () => {
  it("returns null when nothing is staged or downloading", () => {
    expect(pendingRuntimeLine(base)).toBeNull();
  });

  it("reports the staged runtime alone", () => {
    const dto: RuntimeUpdateDto = { ...base, pendingVersion: "0.1.13" };
    expect(pendingRuntimeLine(dto)).toEqual({ version: "0.1.13", state: "ready" });
  });

  it("reports the downloading runtime alone", () => {
    const dto: RuntimeUpdateDto = {
      ...base,
      install: {
        id: "job-1", kind: "runtime_update", status: "running",
        pieceId: null, fileId: null, progressDone: 1, progressTotal: 2,
        progressUnit: "bytes", etaMs: null, msPerUnit: null, msSinceProgress: null,
        error: null, resultJson: null, startedAt: new Date(), completedAt: null,
        lastProgressAt: new Date(), version: "0.1.14",
      },
    };
    expect(pendingRuntimeLine(dto)).toEqual({ version: "0.1.14", state: "downloading" });
  });

  it("prefers the NEWER of a staged runtime and a running download, when both exist", () => {
    // 0.1.13 is already staged for next launch; 0.1.14 is being fetched
    // behind it. The newer one is the one worth telling the user about.
    const dto: RuntimeUpdateDto = {
      ...base,
      pendingVersion: "0.1.13",
      install: {
        id: "job-1", kind: "runtime_update", status: "running",
        pieceId: null, fileId: null, progressDone: 1, progressTotal: 2,
        progressUnit: "bytes", etaMs: null, msPerUnit: null, msSinceProgress: null,
        error: null, resultJson: null, startedAt: new Date(), completedAt: null,
        lastProgressAt: new Date(), version: "0.1.14",
      },
    };
    expect(pendingRuntimeLine(dto)).toEqual({ version: "0.1.14", state: "downloading" });
  });

  it("prefers the staged runtime when it is the newer of the two", () => {
    // The download in flight is for an OLDER version than what already
    // landed — a retried/failed 0.1.12 catching up behind a staged 0.1.13.
    const dto: RuntimeUpdateDto = {
      ...base,
      pendingVersion: "0.1.13",
      install: {
        id: "job-1", kind: "runtime_update", status: "running",
        pieceId: null, fileId: null, progressDone: 1, progressTotal: 2,
        progressUnit: "bytes", etaMs: null, msPerUnit: null, msSinceProgress: null,
        error: null, resultJson: null, startedAt: new Date(), completedAt: null,
        lastProgressAt: new Date(), version: "0.1.12",
      },
    };
    expect(pendingRuntimeLine(dto)).toEqual({ version: "0.1.13", state: "ready" });
  });
});
