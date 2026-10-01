// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as tlRender, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SocialAccount, TikTokCreatorInfo } from "@/lib/social/types";
import { composerDraftKey } from "@/hooks/social/use-composer-draft";

vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));
// AskAgentButton pulls in the whole chat-dispatch stack — the composer only
// has to hand it the right kind.
vi.mock("@/components/social/ask-agent-button", () => ({
  AskAgentButton: ({ kind, label }: { kind: string; label?: string }) => (
    <button data-testid={`ask-agent-${kind}`}>{label ?? "Ask the agent"}</button>
  ),
}));
// The Music block has its own tests (music-block.test.tsx) — here it is a
// stub whose click reports one of the two variants, so the composer's own
// gating (mixed variants, export mismatch) can be exercised without pulling
// in the plan/catalog queries.
//
// On MOUNT it auto-reports a NEUTRAL default ("strip" for every account, so
// `exportVariantOf` stays "without-song" until a test explicitly diverges the
// two accounts by clicking) — this is what a real MusicBlock does the moment
// ANY plan arrives, confident or not (the fallback mode is still a decided
// plan). Three sets steer that per account:
// - `unresolved`: still fires `onChange` (reported), but `onResolved(false)`
//   — a needsChoice plan, which is a RAIL-MARK cosmetic only, never a gate.
// - `neverReports`: fires NOTHING — simulates a MusicBlock that hasn't
//   mounted this session yet, or whose plan request never lands.
// - `erroring`: fires `onError(true)` and nothing else — the plan REQUEST
//   itself failed.
// - `awaiting`: reports NO music and `onAwaitingPick(true)` — attach with no
//   matching track, waiting on the user's pick or another option.
let unresolved = new Set<string>();
let neverReports = new Set<string>();
let erroring = new Set<string>();
let awaiting = new Set<string>();
/** Every `choice` each account's MusicBlock was MOUNTED with — the post override the composer holds. */
let mountedChoices: Array<{ accountId: string; choice: unknown }> = [];
vi.mock("@/components/social/music/music-block", async () => {
  const { useEffect } = await import("react");
  return {
    MusicBlock: ({
      accountId,
      choice,
      onChange,
      onChoice,
      onResolved,
      onAwaitingPick,
      onError,
    }: {
      accountId: string;
      choice?: unknown;
      onChange: (m: unknown) => void;
      onChoice?: (c: unknown, expected?: unknown) => void;
      onResolved?: (r: boolean) => void;
      onAwaitingPick?: (w: boolean) => void;
      onError?: (e: boolean) => void;
    }) => {
      useEffect(() => {
        mountedChoices.push({ accountId, choice });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      useEffect(() => {
        if (neverReports.has(accountId)) return;
        if (erroring.has(accountId)) {
          onError?.(true);
          return;
        }
        if (awaiting.has(accountId)) {
          onChange(undefined);
          onResolved?.(false);
          onAwaitingPick?.(true);
          return;
        }
        // Like the real plan: an override's mode is kept; otherwise the neutral default.
        onChange((choice as { mode?: string } | undefined)?.mode ? { mode: (choice as { mode: string }).mode } : { mode: "strip" });
        onResolved?.(!unresolved.has(accountId));
        onError?.(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [accountId]);
      return (
        <>
          <button data-testid={`music-block-${accountId}`} onClick={() => onChange(accountId === "acct-ig" ? { mode: "include" } : { mode: "strip" })}>
            music
          </button>
          <button data-testid={`music-choose-include-${accountId}`} onClick={() => onChoice?.({ mode: "include" })}>
            include
          </button>
          <button data-testid={`music-settle-stale-${accountId}`} onClick={() => onChoice?.(undefined, { mode: "attach", trackId: "old" })}>
            settle
          </button>
        </>
      );
    },
  };
});
let pieceCopyrighted: Array<{ fileId: string; name: string; clipSeconds: number }> = [];
let pieceAudioState: "ok" | "loading" | "error" = "ok";
const pieceAudioRefetch = vi.fn();
vi.mock("@/lib/queries/audio-rights", () => ({
  usePieceAudioRights: () =>
    pieceAudioState === "ok"
      ? { data: { copyrighted: pieceCopyrighted, ownMusic: [] }, isLoading: false, isError: false, refetch: pieceAudioRefetch }
      : { data: undefined, isLoading: pieceAudioState === "loading", isError: pieceAudioState === "error", refetch: pieceAudioRefetch },
}));

const accounts: SocialAccount[] = [
  { id: "acct-ig", platform: "instagram", username: "nagellabs", displayName: "Nagel Labs", active: true },
  { id: "acct-tt", platform: "tiktok", username: "nagellabs", displayName: "Nagel Labs", active: true },
];

/** The live account's real answer: ONE privacy level, all interactions
 *  required and defaulting to off (zernio-live-shapes.md). */
const creatorInfo: TikTokCreatorInfo = {
  accountId: "acct-tt",
  privacyLevels: ["PUBLIC_TO_EVERYONE"],
  maxVideoSeconds: 600,
  canPostMore: true,
  interactions: {
    // `default` is varied and is expected to be IGNORED: libi seeds from
    // `enabled`, not from TikTok's suggested default. The `enabled: false`
    // case is proved on the pure seeder (`composer-types.test.ts`) and in the
    // switch itself (`target-tiktok.test.tsx`) rather than here, so that this
    // fixture can still exercise a normal restore.
    allow_comment: { enabled: true, required: true, default: false },
    allow_duet: { enabled: true, required: true, default: true },
    allow_stitch: { enabled: true, required: true, default: false },
  },
};

let creatorInfoFixture: TikTokCreatorInfo = creatorInfo;
let existingPost: unknown = undefined;
const createMutate = vi.fn();
const updateMutate = vi.fn();

vi.mock("@/lib/queries/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/social")>();
  return {
    ...actual,
    useSocialStatus: () => ({
      data: { settings: { providerId: "zernio", timezone: "Asia/Bangkok", defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 } },
    }),
    useSocialAccounts: () => ({ data: accounts, isLoading: false }),
    useSocialPost: (id: string | null) => ({ data: id ? existingPost : undefined, isLoading: false }),
    useTikTokCreatorInfo: (id: string | null) => ({ data: id ? creatorInfoFixture : undefined, isLoading: false, error: null }),
    useCreateSocialPost: () => ({ mutateAsync: createMutate, isPending: false }),
    useUpdateSocialPost: () => ({ mutateAsync: updateMutate, isPending: false }),
  };
});

import { Composer } from "@/components/social/composer/composer";
import { SocialApiError } from "@/lib/queries/social";

/** Every render needs a client in scope: the fit, validate, dry-run and
 *  request-id reads are React Query hooks against the stubbed fetch. */
function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return tlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const PROBE = { durationSeconds: 34, width: 1080, height: 1920, sizeBytes: 41_000_000 };
const latestExport = { filePath: "/exp/e.mp4", ...PROBE };

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }
  removeEventListener(): void {}
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const UPLOAD_RESULT = {
  publicUrl: "https://media.zernio.com/temp/1_e.mp4",
  sizeBytes: PROBE.sizeBytes,
  contentType: "video/mp4",
  filename: "e.mp4",
};

/** The expiry the upload job reports. A PAST one is how a submit is made to
 *  upload again instead of reusing the cached URL. */
let uploadExpiry: string;

interface Call { url: string; body: unknown }
let calls: Call[] = [];
let fitVerdicts: Array<{ platform: string; postType: string; ok: boolean; problems: string[] }>;
let validateResult: Array<{ platform: string; ok: boolean; errors: string[] }>;
let postsFailures: number;
let postsStatus: number;
let postsThrow: (() => unknown) | null;
let seedRequestId: string | null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  // The composer autosaves to `localStorage` as the user types, and jsdom
  // keeps that store for the whole FILE — so without this, one test's
  // half-finished draft is restored into the next one's fresh composer and
  // the flow starts several steps in.
  window.localStorage.clear();
  calls = [];
  pieceCopyrighted = [];
  pieceAudioState = "ok";
  pieceAudioRefetch.mockReset();
  mountedChoices = [];
  unresolved = new Set();
  neverReports = new Set();
  awaiting = new Set();
  erroring = new Set();
  creatorInfoFixture = creatorInfo;
  existingPost = undefined;
  postsFailures = 0;
  postsStatus = 502;
  postsThrow = null;
  uploadExpiry = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
  seedRequestId = "11111111-2222-4333-8444-555555555555";
  createMutate.mockReset();
  updateMutate.mockReset();
  createMutate.mockImplementation(async (input: unknown) => {
    calls.push({ url: "/api/social/posts", body: input });
    if (postsFailures > 0) {
      postsFailures -= 1;
      throw postsThrow ? postsThrow() : new SocialApiError(postsStatus, { error: "provider", message: `HTTP ${postsStatus}` });
    }
    return { post: { id: "post_new", status: "draft" }, deduped: false };
  });
  updateMutate.mockImplementation(async (input: unknown) => {
    calls.push({ url: "PATCH", body: input });
    return { post: { id: "post_existing", status: "draft" }, deduped: false };
  });
  fitVerdicts = [
    { platform: "instagram", postType: "reel", ok: true, problems: [] },
    { platform: "tiktok", postType: "video", ok: true, problems: [] },
  ];
  validateResult = [
    { platform: "instagram", ok: true, errors: [] },
    { platform: "tiktok", ok: true, errors: [] },
  ];
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url === "/api/social/fit") {
        return jsonResponse({ probe: PROBE, verdicts: fitVerdicts.map((v) => ({ ...v, probe: PROBE })) });
      }
      if (url === "/api/social/upload") return jsonResponse({ jobId: "job-up-1" });
      if (url.startsWith("/api/social/request-id")) {
        return seedRequestId ? jsonResponse({ requestId: seedRequestId, source: "intent" }) : jsonResponse({ error: "internal" }, 500);
      }
      if (url === "/api/social/validate") {
        // The same route answers both checks; `dryRun: true` is TikTok's
        // advisory pre-flight and answers a verdict, never a verdict list.
        return (body as { dryRun?: boolean } | undefined)?.dryRun
          ? jsonResponse({ canPublish: true, perAccount: [] })
          : jsonResponse(validateResult);
      }
      return jsonResponse({ error: "not mocked" }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderComposer(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onExportRequested = vi.fn();
  const onDone = vi.fn();
  const utils = render(
    <Composer
      intent={{ pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/e.mp4" }}
      latestExport={latestExport}
      onExportRequested={onExportRequested}
      onDone={onDone}
      {...over}
    />,
  );
  return { ...utils, onExportRequested, onDone };
}

const next = () => screen.getByTestId("composer-next");
const composerBack = () => screen.getByTestId("composer-back");

/** Tick the upload job's SSE to completion, if one is open. */
async function finishUpload(percent?: number) {
  await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
  const es = MockEventSource.instances[MockEventSource.instances.length - 1];
  await act(async () => {
    if (percent !== undefined) {
      es.emit("progress", { jobId: "job-up-1", done: Math.round(PROBE.sizeBytes * (percent / 100)), total: PROBE.sizeBytes, unit: "bytes", etaMs: null });
      return;
    }
    es.emit("completed", { jobId: "job-up-1", result: { ...UPLOAD_RESULT, expiresAt: uploadExpiry } });
  });
}

/** Consent to TikTok on the Targets step so Next unlocks — a no-op when the
 *  draft being edited has no TikTok target at all. */
function consentTikTok() {
  const preview = screen.queryByTestId("tiktok-consent-preview");
  if (!preview) return;
  fireEvent.click(preview);
  fireEvent.click(screen.getByTestId("tiktok-consent-express"));
}

async function advanceToCaption() {
  await waitFor(() => expect(next()).toBeEnabled());
  fireEvent.click(next()); // media -> targets
  consentTikTok();
  await waitFor(() => expect(next()).toBeEnabled());
  fireEvent.click(next()); // targets -> music
  await waitFor(() => expect(next()).toBeEnabled());
  fireEvent.click(next()); // music -> caption (this is what starts the upload)
}

describe("Composer — media step", () => {
  it("shows the export line and a fit verdict per selected target", async () => {
    renderComposer();
    // 41_000_000 bytes = 39.1 MiB; sizes are printed in MiB so they match the
    // MiB platform limits they are checked against.
    expect(await screen.findByText("e.mp4 · 0:34 · 1080×1920 · 39.1 MB")).toBeInTheDocument();
    expect(await screen.findByText(/fits Instagram Reel/)).toBeInTheDocument();
    expect(await screen.findByText(/fits TikTok video/)).toBeInTheDocument();
  });

  /**
   * QA 2026-09-21, finding 1. `latestExport` comes from
   * `useAllJobs({ kind: "export" })`, which is not prefetched, so on a fresh
   * mount the composer is handed `null` and only learns about the export a
   * tick later. Seeding `exportPath` once in `useState` meant the first
   * screen of the feature told essentially every user to re-export a piece
   * that had just been exported — and it healed on a tab remount, which is
   * why it read as flaky.
   */
  it("shows the export as soon as the jobs query resolves, having said 'no export yet' while it was in flight", async () => {
    const { rerender } = render(
      <Composer
        intent={{ pieceId: "p1", pieceName: "Cutdown v3" }}
        latestExport={null}
        onExportRequested={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // While the query is in flight there is genuinely nothing to show.
    expect(await screen.findByTestId("media-step")).toHaveTextContent("This piece has no export yet");

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <Composer
          intent={{ pieceId: "p1", pieceName: "Cutdown v3" }}
          latestExport={latestExport}
          onExportRequested={vi.fn()}
          onDone={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("e.mp4 · 0:34 · 1080×1920 · 39.1 MB")).toBeInTheDocument();
    expect(screen.getByTestId("media-step")).not.toHaveTextContent("This piece has no export yet");
  });

  it("keeps the export the user picked when a newer one arrives from the jobs query", async () => {
    const older = { filePath: "/exp/older.mp4", ...PROBE };
    const { rerender } = render(
      <Composer
        intent={{ pieceId: "p1", pieceName: "Cutdown v3" }}
        latestExport={older}
        onExportRequested={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(await screen.findByTestId("export-line")).toHaveTextContent("older.mp4");
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <Composer
          intent={{ pieceId: "p1", pieceName: "Cutdown v3" }}
          latestExport={latestExport}
          onExportRequested={vi.fn()}
          onDone={vi.fn()}
        />
      </QueryClientProvider>,
    );
    // The seed fires ONCE: an export already chosen is not replaced under the
    // user by a later poll of the jobs list — and the step describes the file
    // the composer will actually post, never the newest one it heard about.
    expect(await screen.findByTestId("export-line")).toHaveTextContent("older.mp4");
  });

  it("asks /api/social/fit in the shape that route's schema actually takes", async () => {
    renderComposer();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/social/fit")).toBe(true));
    const body = calls.find((c) => c.url === "/api/social/fit")!.body as Record<string, unknown>;
    // A 400 here is invisible in the UI except as a missing verdict, which is
    // exactly how this shipped wrong the first time.
    expect(Object.keys(body).sort()).toEqual(["exportPath", "targets"]);
    expect(body.exportPath).toBe("/exp/e.mp4");
    expect(body.targets).toEqual([
      { platform: "instagram", postType: "reel" },
      { platform: "tiktok", postType: "video" },
    ]);
  });

  it("says so when the fit check itself could not run, rather than showing nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push({ url, body: undefined });
        if (url === "/api/social/fit") return jsonResponse({ error: "invalid body" }, 400);
        return jsonResponse({}, 404);
      }),
    );
    renderComposer();
    expect(await screen.findByTestId("fit-failed")).toBeInTheDocument();
    expect(next()).toBeDisabled();
  });

  it("a fit problem disables Next and names the problem per platform", async () => {
    fitVerdicts = [
      { platform: "instagram", postType: "reel", ok: false, problems: ["1:41 is longer than Instagram Reel's 1:30 maximum"] },
      { platform: "tiktok", postType: "video", ok: true, problems: [] },
    ];
    renderComposer();
    expect(await screen.findByText("1:41 is longer than Instagram Reel's 1:30 maximum")).toBeInTheDocument();
    await waitFor(() => expect(next()).toBeDisabled());
  });

  it("with no export at all the primary is Export & post and calls back", async () => {
    const { onExportRequested } = renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3" }, latestExport: null });
    const btn = await screen.findByRole("button", { name: "Export & post" });
    fireEvent.click(btn);
    expect(onExportRequested).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("composer-next")).not.toBeInTheDocument();
  });
});

describe("Composer — targets step", () => {
  it("lists exactly the connected accounts, renders only TikTok's returned privacy levels, and gates Next on both consents", async () => {
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());

    const toggles = screen.getAllByTestId(/^target-toggle-/);
    expect(toggles.map((t) => t.getAttribute("data-testid"))).toEqual(["target-toggle-acct-ig", "target-toggle-acct-tt"]);

    const radios = screen.getAllByRole("radio", { name: /Public|Friends|Followers|Only me/ });
    expect(radios).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "Public" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Only me" })).not.toBeInTheDocument();

    // Seeded ON wherever the account is ALLOWED the interaction — engagement
    // is what makes a post travel, and TikTok's own `default` is false for all
    // three here — a post that ships with comments, duets and stitches off is
    // a post that cannot travel.
    await waitFor(() => expect(screen.getByTestId("tiktok-allow_comment")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByTestId("tiktok-allow_duet")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("tiktok-allow_stitch")).toHaveAttribute("aria-checked", "true");

    expect(next()).toBeDisabled();
    fireEvent.click(screen.getByTestId("tiktok-consent-preview"));
    expect(next()).toBeDisabled();
    fireEvent.click(screen.getByTestId("tiktok-consent-express"));
    await waitFor(() => expect(next()).toBeEnabled());
  });

  it("the Music step blocks targets that need different exports, naming why", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(screen.getByTestId("music-step")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("music-block-acct-ig")); // include → with-song
    fireEvent.click(screen.getByTestId("music-block-acct-tt")); // strip → without-song
    expect(await screen.findByTestId("music-blocked-reason")).toHaveTextContent(
      "These accounts need different exports — one keeps the song, one doesn't. Post them one at a time.",
    );
    expect(next()).toBeDisabled();
  });
});

describe("Composer — an export that does not match the music plan", () => {
  const decided = (carriesCopyrighted: boolean) => ({
    ...latestExport,
    audioDecision: { purpose: carriesCopyrighted ? "personal" : "social", excludedFileIds: [], carriesCopyrighted },
  });

  it("offers Export for social, names why, and calls back", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    // A with-song export, but both targets default to leaving the song out.
    const { onExportRequested } = renderComposer({ latestExport: decided(true) as React.ComponentProps<typeof Composer>["latestExport"] });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(await screen.findByTestId("music-blocked-reason")).toHaveTextContent("This export doesn't match the music plan — export it for a social post first.");
    expect(next()).toBeDisabled();
    fireEvent.click(screen.getByTestId("export-for-social"));
    expect(onExportRequested).toHaveBeenCalledTimes(1);
  });

  it("judges the export actually used, not only the latest one — and, with a fitting export on hand, says what differs rather than to export again", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    // The latest export leaves the song out; the one the composer was opened on keeps it.
    const older = { ...decided(true), filePath: "/exp/older.mp4" };
    renderComposer({
      intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/older.mp4" },
      latestExport: decided(false) as React.ComponentProps<typeof Composer>["latestExport"],
      exports: [decided(false), older] as React.ComponentProps<typeof Composer>["exports"],
    });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(await screen.findByTestId("music-blocked-reason")).toHaveTextContent("This export has the song; your plan posts without it.");
  });

  it("offers nothing when the export already leaves the song out", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    renderComposer({ latestExport: decided(false) as React.ComponentProps<typeof Composer>["latestExport"] });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    await screen.findByTestId("music-step");
    expect(screen.queryByTestId("export-for-social")).not.toBeInTheDocument();
  });
});

describe("Composer — the Music step's rail mark", () => {
  it("is ticked once every target's plan is resolved, and not while one still needs a choice — but needsChoice never blocks Next", async () => {
    unresolved = new Set(["acct-tt"]);
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(screen.getByTestId("music-step")).toBeInTheDocument();
    expect(screen.getByTestId("rail-music")).not.toHaveTextContent("✓");
    expect(screen.getByTestId("rail-targets")).toHaveTextContent("✓");
    // needsChoice is a rail-mark cosmetic only — the fallback mode the mock
    // already reported ("strip") is still a decided plan, so Next holds open.
    expect(next()).toBeEnabled();
  });
  it("ticked when resolved", async () => {
    renderComposer();
    await advanceToCaption();
    expect(screen.getByTestId("rail-music")).toHaveTextContent("✓ Music");
  });
});

/** A `latestExport` that matches the mock's default "strip" (without-song)
 *  report, so `exportMismatch` never muddies a test aimed at the reported/
 *  unreported gate specifically. */
const withoutSongExport = (): React.ComponentProps<typeof Composer>["latestExport"] =>
  ({ ...latestExport, audioDecision: { purpose: "social", excludedFileIds: [], carriesCopyrighted: false } }) as React.ComponentProps<
    typeof Composer
  >["latestExport"];

describe("Composer — Music blocks ONLY a copyrighted piece with a target that hasn't reported", () => {
  it("Next on Music holds while a target's MusicBlock has never reported (loading, or never mounted) — copyrighted piece", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    neverReports = new Set(["acct-tt"]);
    renderComposer({ latestExport: withoutSongExport() });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(screen.getByTestId("music-step")).toBeInTheDocument();
    expect(next()).toBeDisabled();
    expect(screen.getByTestId("music-blocked-reason")).toHaveTextContent("Working out the music for @nagellabs…");
  });

  it("the same never-reported target does NOT block a piece with no copyrighted music", async () => {
    neverReports = new Set(["acct-tt"]);
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(next()).toBeEnabled();
    fireEvent.click(next()); // music -> caption
    expect(screen.getByTestId("caption-step")).toBeInTheDocument();
  });

  it("a plan-request error blocks a copyrighted piece with its own reason, but never a piece with no copyrighted music", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    erroring = new Set(["acct-tt"]);
    renderComposer({ latestExport: withoutSongExport() });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(next()).toBeDisabled();
    expect(screen.getByTestId("music-blocked-reason")).toHaveTextContent("Couldn't work out the music for @nagellabs — try again on the Music step");
  });

  it("attach with no matching track holds Next and says to pick a track or choose another option; a decision frees it", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    awaiting = new Set(["acct-tt"]);
    renderComposer({ latestExport: withoutSongExport() });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(next()).toBeDisabled();
    expect(screen.getByTestId("music-blocked-reason")).toHaveTextContent("Pick a TikTok track for @nagellabs, or choose another music option");
    fireEvent.click(screen.getByTestId("music-block-acct-tt")); // the user decides: the block reports
    await waitFor(() => expect(next()).toBeEnabled());
    expect(screen.queryByTestId("music-blocked-reason")).not.toBeInTheDocument();
  });

  it("the same plan-request error does not block a piece with no copyrighted music", async () => {
    erroring = new Set(["acct-tt"]);
    renderComposer();
    await advanceToCaption();
    expect(screen.getByTestId("caption-step")).toBeInTheDocument();
  });

  it("a target added back after Review was already reached blocks Review again, even jumped to via the rail", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    renderComposer({ latestExport: withoutSongExport() });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    // Drop TikTok before Music is ever visited: its MusicBlock never mounts.
    fireEvent.click(screen.getByTestId("target-toggle-acct-tt"));
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music (only Instagram mounts and reports)
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // music -> caption
    fireEvent.click(next()); // caption -> when
    fireEvent.click(next()); // when -> review
    await waitFor(() => expect(screen.getByTestId("review-step")).toBeInTheDocument());

    // Back to Targets, add TikTok back — its MusicBlock has never reported a
    // plan this session, and it carries no restored `options.music` either.
    fireEvent.click(screen.getByTestId("rail-targets"));
    fireEvent.click(screen.getByTestId("target-toggle-acct-tt"));
    consentTikTok();

    // The rail must refuse to jump straight back to Review: `furthest`
    // already includes it, but the newly-added target's music is unreported.
    expect(screen.getByTestId("rail-review")).toBeDisabled();
    fireEvent.click(screen.getByTestId("rail-review"));
    expect(screen.queryByTestId("review-step")).not.toBeInTheDocument();

    // Visiting Music reports it (the mock fires on mount) and Review becomes
    // reachable again.
    fireEvent.click(screen.getByTestId("rail-music"));
    await waitFor(() => expect(screen.getByTestId("rail-review")).toBeEnabled());
  });

  it("a restored options.music counts as reported even if its MusicBlock never reports again this session", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    neverReports = new Set(["acct-ig"]);
    existingPost = {
      id: "post_existing",
      status: "draft",
      content: "old caption",
      createdAt: "2026-09-19T00:00:00.000Z",
      media: [{ url: "https://media.zernio.com/media/old.mp4", type: "video" }],
      targets: [
        {
          platform: "instagram",
          accountId: "acct-ig",
          status: "pending",
          options: { platform: "instagram", instagram: { contentType: "reel", shareToFeed: true, commentsEnabled: true, isAiGenerated: true }, music: { mode: "strip" } },
        },
      ],
      tags: [],
      link: null,
      libi: undefined,
    };
    renderComposer({
      intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/e.mp4", draftPostId: "post_existing" },
      latestExport: withoutSongExport(),
    });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets (Zernio echoed this target's options)
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    // Its MusicBlock never calls back this session, but the RESTORED
    // options.music already satisfies "reported" — Next is not held.
    expect(next()).toBeEnabled();
    expect(screen.queryByTestId("music-blocked-reason")).not.toBeInTheDocument();

    fireEvent.click(next()); // music -> caption (starts the upload)
    await finishUpload();
    fireEvent.click(next()); // caption -> when
    fireEvent.click(next()); // when -> review
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toBeEnabled());
  });

  it("while the piece's audio is still being read, an unreported target blocks as on a copyrighted piece (M3)", async () => {
    pieceAudioState = "loading";
    neverReports = new Set(["acct-tt"]);
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(next()).toBeDisabled();
    expect(screen.getByTestId("music-blocked-reason")).toHaveTextContent("Checking the piece's music…");
  });

  it("a failed read of the piece's audio blocks an unreported target, says so, and offers a retry (M3)", async () => {
    pieceAudioState = "error";
    neverReports = new Set(["acct-tt"]);
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(next()).toBeDisabled();
    expect(screen.getByTestId("music-blocked-reason")).toHaveTextContent("Couldn't read the piece's music — try again");
    fireEvent.click(screen.getByTestId("piece-audio-retry"));
    expect(pieceAudioRefetch).toHaveBeenCalledTimes(1);
  });

  it("a piece with no copyrighted music still reaches Review with no friction", async () => {
    renderComposer(); // pieceCopyrighted defaults to [] — no music to decide
    await advanceToCaption();
    expect(screen.getByTestId("caption-step")).toBeInTheDocument();
  });
});

describe("Composer — a disabled Next says what is missing", () => {
  /** QA 2026-09-21, finding 7 — the repo's own UI rule: "A disabled button
   *  that only says 'Next' reads as broken." The consent boxes are several
   *  screen-lines above it, and unticked by default on every TikTok post. */
  it("names the unticked TikTok consents, and stops saying so once they are ticked", async () => {
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets

    expect(next()).toBeDisabled();
    expect(await screen.findByTestId("targets-blocked-reason")).toHaveTextContent(/Tick both TikTok consent boxes/);

    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    expect(screen.queryByTestId("targets-blocked-reason")).not.toBeInTheDocument();
  });

  it("names the account limit rather than the consents when TikTok is the blocker", async () => {
    creatorInfoFixture = { ...creatorInfo, maxVideoSeconds: 20 };
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
    consentTikTok();
    await waitFor(() => expect(next()).toBeDisabled());
    expect(screen.getByTestId("targets-blocked-reason")).toHaveTextContent(/longer than TikTok allows/);
  });

  it("asks for an account when every target has been unticked", async () => {
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
    fireEvent.click(screen.getByTestId("target-toggle-acct-ig"));
    fireEvent.click(screen.getByTestId("target-toggle-acct-tt"));
    expect(await screen.findByTestId("targets-blocked-reason")).toHaveTextContent("Pick at least one account to post to.");
  });
});

describe("Composer — TikTok's per-account limits are gates, not captions", () => {
  it("an export longer than this account's cap cannot leave the Targets step", async () => {
    // The live catalog allows 600 s; this ACCOUNT allows 20.
    creatorInfoFixture = { ...creatorInfo, maxVideoSeconds: 20 };
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    expect(await screen.findByTestId("tiktok-too-long")).toBeInTheDocument();
    // Consented, and still blocked: TikTok would refuse it.
    await waitFor(() => expect(next()).toBeDisabled());
  });
});

describe("Composer — caption step", () => {
  it("counts per platform, folds for Instagram, and offers the agent", async () => {
    renderComposer();
    await advanceToCaption();
    expect(screen.getByText("0 / 2,200 · fold at 125")).toBeInTheDocument();
    expect(screen.getByText("0 / 2,200")).toBeInTheDocument();
    expect(screen.getByTestId("ask-agent-caption")).toBeInTheDocument();
  });

  it("an Instagram Story target has no caption at all", async () => {
    renderComposer();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    fireEvent.click(screen.getByTestId("ig-type-story"));
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // music -> caption
    expect(screen.getByText("Story: no caption")).toBeInTheDocument();
  });
});

describe("Composer — when step", () => {
  it("defaults to Save as draft and spells out that Publish now cannot be undone", async () => {
    renderComposer();
    await advanceToCaption();
    fireEvent.click(next());
    expect(screen.getByTestId("when-draft")).toBeChecked();
    fireEvent.click(screen.getByTestId("when-now"));
    const note = screen.getByTestId("publish-now-note");
    // The whole sentence, not two loose matches: /Instagram/ + /TikTok/ both
    // passed while the rendered copy said "TikTokstraight away".
    expect(note.textContent).toContain("This posts to Instagram and TikTok straight away and can't be undone from libi");
    expect(note.textContent).toContain("delete it in their own app");
  });

  it("never renders a draft's leftover scheduled time as a schedule", async () => {
    existingPost = {
      id: "post_existing",
      status: "draft",
      content: "old caption",
      createdAt: "2026-09-19T00:00:00.000Z",
      scheduledFor: "2030-01-01T02:00:00.000Z",
      timezone: "Asia/Bangkok",
      media: [{ url: "https://media.zernio.com/media/old.mp4", type: "video" }],
      targets: [{ platform: "instagram", accountId: "acct-ig", status: "pending" }],
      tags: [],
      link: null,
    };
    renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/e.mp4", draftPostId: "post_existing" } });
    await advanceToCaption();
    fireEvent.click(next());
    expect(screen.getByTestId("when-draft")).toBeChecked();
    expect(screen.getByTestId("when-schedule-readback")).toHaveTextContent("No time chosen yet");
  });
});

describe("Composer — restoring a TikTok draft's own settings", () => {
  /** What libi itself stamped into `metadata.libi.targetOptions` the last
   *  time this post was written. */
  const storedTikTokOptions = {
    platform: "tiktok" as const,
    tiktok: {
      privacyLevel: "PUBLIC_TO_EVERYONE",
      allowComment: true,
      allowDuet: false,
      allowStitch: true,
      commercialContentType: "brand_organic" as const,
      madeWithAi: true,
      contentPreviewConfirmed: true as const,
      expressConsentGiven: true as const,
    },
  };

  /** A draft whose TikTok target's `options` is undefined, exactly like the
   *  live shape — Zernio never echoes `tiktok_settings` back. */
  function draftWithTikTok(targetOptions?: unknown[]) {
    return {
      id: "post_existing",
      status: "draft",
      content: "old caption",
      createdAt: "2026-09-19T00:00:00.000Z",
      media: [{ url: "https://media.zernio.com/media/old.mp4", type: "video" }],
      targets: [
        { platform: "instagram", accountId: "acct-ig", status: "pending", options: { platform: "instagram", instagram: { contentType: "reel" } } },
        { platform: "tiktok", accountId: "acct-tt", status: "pending" },
      ],
      tags: [],
      link: null,
      libi: targetOptions ? { pieceId: "p1", requestId: "r-orig", targetOptions } : undefined,
    };
  }

  it("restores the stored options AND pre-checks consent, without asking again", async () => {
    existingPost = draftWithTikTok([storedTikTokOptions]);
    renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/e.mp4", draftPostId: "post_existing" } });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets

    // Pre-checked WITHOUT any click — restored from libi's own record of what
    // the user chose, not invented.
    await waitFor(() => expect(screen.getByTestId("tiktok-consent-preview")).toBeChecked());
    expect(screen.getByTestId("tiktok-consent-express")).toBeChecked();
    // The rest of the TikTok settings came back too, not just the consent.
    expect(screen.getByRole("radio", { name: /Public/ })).toBeChecked();
    expect(screen.getByTestId("tiktok-allow_comment")).toBeChecked();
    expect(screen.getByTestId("tiktok-allow_stitch")).toBeChecked();
    expect(screen.getByTestId("tiktok-allow_duet")).not.toBeChecked();
    // Nothing left to ask — Next unlocks on its own.
    expect(next()).toBeEnabled();
  });

  it("never invents consent when there is nothing stored — it asks again, same as a fresh compose", async () => {
    existingPost = draftWithTikTok(undefined);
    renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/e.mp4", draftPostId: "post_existing" } });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets

    expect(await screen.findByTestId("tiktok-consent-preview")).not.toBeChecked();
    expect(screen.getByTestId("tiktok-consent-express")).not.toBeChecked();
    expect(next()).toBeDisabled();
  });

  it("an update extends the post's own metadata.libi (pieceId + requestId) instead of replacing it", async () => {
    existingPost = draftWithTikTok([storedTikTokOptions]);
    renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/e.mp4", draftPostId: "post_existing" } });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // music -> caption (this is what starts the upload)
    await finishUpload();
    fireEvent.click(next()); // caption -> when
    fireEvent.click(next()); // when -> review
    await waitFor(() => expect(screen.getAllByTestId(/^validate-ok-/)).toHaveLength(2));

    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(updateMutate).toHaveBeenCalled());
    const patch = updateMutate.mock.calls[0][0] as { libi?: { pieceId: string; requestId?: string; exportFile?: string } };
    // The post's OWN existing pieceId/requestId ride along unchanged — losing
    // either here is exactly the REPLACE bug `toUpdateBody` guards against.
    expect(patch.libi).toMatchObject({ pieceId: "p1", requestId: "r-orig" });
  });
});

describe("Composer — review and submit", () => {
  it("validates per target and saves the draft with the uploaded media, the piece stamp and the request id", async () => {
    const { onDone } = renderComposer();
    await advanceToCaption();
    await finishUpload();
    fireEvent.change(screen.getByTestId("caption-input"), { target: { value: "hello there" } });
    fireEvent.click(next());
    fireEvent.click(next());

    await waitFor(() => expect(calls.some((c) => c.url === "/api/social/validate")).toBe(true));
    await waitFor(() => expect(screen.getAllByTestId(/^validate-ok-/)).toHaveLength(2));

    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("post_new"));

    const post = calls.filter((c) => c.url === "/api/social/posts").pop()!.body as Record<string, unknown>;
    expect((post.when as { mode: string }).mode).toBe("draft");
    expect((post.libi as { pieceId: string }).pieceId).toBe("p1");
    expect((post.media as Array<{ url: string }>)[0].url).toBe(UPLOAD_RESULT.publicUrl);
    expect(String(post.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.exportPath).toBe("/exp/e.mp4");
    expect(post.createdBy).toBe("ui");
  });

  it("Retry after a 502 re-sends the SAME requestId", async () => {
    postsFailures = 1;
    renderComposer();
    await advanceToCaption();
    await finishUpload();
    fireEvent.click(next());
    fireEvent.click(next());
    await waitFor(() => expect(screen.getAllByTestId(/^validate-ok-/)).toHaveLength(2));

    fireEvent.click(screen.getByTestId("composer-submit"));
    const retry = await screen.findByTestId("composer-retry");
    fireEvent.click(retry);
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/social/posts")).toHaveLength(2));
    const [first, second] = calls.filter((c) => c.url === "/api/social/posts").map((c) => c.body as { requestId: string });
    expect(second.requestId).toBe(first.requestId);
  });

  it("a failed Publish now offers NO retry until a human confirms nothing went out", async () => {
    postsFailures = 1;
    renderComposer();
    await advanceToCaption();
    await finishUpload();
    fireEvent.click(next());
    fireEvent.click(screen.getByTestId("when-now"));
    fireEvent.click(next());
    await waitFor(() => expect(screen.getAllByTestId(/^validate-ok-/)).toHaveLength(2));

    fireEvent.click(screen.getByTestId("composer-submit"));
    fireEvent.click(await screen.findByTestId("publish-now-confirm"));
    await waitFor(() => expect(screen.getByTestId("composer-needs-confirmation")).toBeInTheDocument());
    expect(screen.queryByTestId("composer-retry")).not.toBeInTheDocument();

    const again = screen.getByTestId("composer-publish-again");
    expect(again).toBeDisabled();
    fireEvent.click(screen.getByTestId("composer-checked-nothing-posted"));
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/social/posts")).toHaveLength(2));
    const second = calls.filter((c) => c.url === "/api/social/posts")[1].body as Record<string, unknown>;
    expect(second.republishConfirmedByUser).toBe(true);
  });
});

describe("Composer — the upload job", () => {
  it("uploads once after Music, shows the percentage, and never re-uploads on a second Next", async () => {
    renderComposer();
    await advanceToCaption();
    await finishUpload(62);
    expect(await screen.findByText("Uploading 62%")).toBeInTheDocument();
    await finishUpload();
    expect(calls.filter((c) => c.url === "/api/social/upload")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("composer-back"));
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/social/upload")).toHaveLength(1));
  });

  /**
   * The route's half of finding 5: a fresh composer mount (a second visit to
   * the Posting tab, edit mode, an abandoned pre-flight) asks again, and the
   * route answers with the upload it already has. That job is terminal, so
   * there is no stream to follow — waiting on one would hang the composer on
   * events that already happened.
   */
  it("takes the reused upload the route hands back, without opening a stream for a finished job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, body });
        if (url === "/api/social/fit") return jsonResponse({ probe: PROBE, verdicts: fitVerdicts.map((v) => ({ ...v, probe: PROBE })) });
        if (url === "/api/social/upload") {
          return jsonResponse({ jobId: "job-up-earlier", reused: true, result: { ...UPLOAD_RESULT, expiresAt: uploadExpiry } });
        }
        if (url.startsWith("/api/social/request-id")) return jsonResponse({ requestId: seedRequestId, source: "intent" });
        if (url === "/api/social/validate") {
          return (body as { dryRun?: boolean } | undefined)?.dryRun ? jsonResponse({ canPublish: true, perAccount: [] }) : jsonResponse(validateResult);
        }
        return jsonResponse({ error: "not mocked" }, 404);
      }),
    );
    renderComposer();
    await advanceToCaption();
    expect(await screen.findByText("Media uploaded")).toBeInTheDocument();
    expect(MockEventSource.instances).toHaveLength(0);

    // And it is the media that goes on the wire.
    fireEvent.click(next()); // caption -> when
    fireEvent.click(next()); // when -> review
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const sent = createMutate.mock.calls[0][0] as { media: Array<{ url: string }> };
    expect(sent.media[0].url).toBe(UPLOAD_RESULT.publicUrl);
  });
});

/** Straight to Review with the upload finished, in the given mode. */
async function advanceToReviewIn(mode: "draft" | "now" | "schedule") {
  await advanceToCaption();
  await finishUpload();
  fireEvent.click(next()); // caption -> when
  if (mode === "now") fireEvent.click(screen.getByTestId("when-now"));
  if (mode === "schedule") {
    fireEvent.click(screen.getByTestId("when-schedule"));
    // Through the picker's own calendar, the way a user reaches an arbitrary
    // date: open Custom, walk to the month, pick the day, then the time.
    fireEvent.click(screen.getByTestId("when-schedule-custom"));
    while (screen.getByTestId("when-schedule-month").textContent !== "January 2030") {
      fireEvent.click(screen.getByLabelText("Next month"));
    }
    fireEvent.click(screen.getByTestId("when-schedule-day-2030-01-01"));
    fireEvent.click(screen.getByTestId("when-schedule-hour-09"));
    fireEvent.click(screen.getByTestId("when-schedule-minute-00"));
  }
  fireEvent.click(next()); // when -> review
}

const lastBodyFor = (url: string) => calls.filter((c) => c.url === url).pop()?.body as Record<string, unknown> | undefined;

describe("Composer — autosave", () => {
  it("keeps what was typed when the composer unmounts, and drops it once the post exists", async () => {
    const { unmount } = renderComposer();
    await advanceToCaption();
    fireEvent.change(screen.getByTestId("caption-input"), { target: { value: "a hook worth keeping" } });
    // Leaving the Posting tab unmounts the composer. Before autosave this
    // threw away every caption and target choice.
    await waitFor(() => expect(window.localStorage.getItem(composerDraftKey("p1", null))).toContain("a hook worth keeping"));
    unmount();

    renderComposer();
    await waitFor(() => expect(screen.getByTestId("caption-input")).toHaveValue("a hook worth keeping"));
  });

  it("an untouched composer leaves nothing behind", async () => {
    renderComposer();
    await waitFor(() => expect(screen.getByTestId("media-step")).toBeInTheDocument());
    expect(window.localStorage.getItem(composerDraftKey("p1", null))).toBeNull();
  });
});

describe("Composer — a 207 partial publish", () => {
  /** What the route really answers (`socialErrorToResponse` -> `partial`),
   *  normalized by `api()`: per-target failures and NO post. 207 is `res.ok`,
   *  so this used to arrive typed as `{ post }`, and reading `.post.targets`
   *  off it threw — on top of a post that was already live on Instagram. */
  const PARTIAL = {
    error: "partial" as const,
    perTarget: [{ platform: "tiktok", accountId: "acct-tt", error: "TikTok rejected the video: unaudited client can only post to private accounts" }],
  };

  it("shows the failing target's own words, finishes, and never invites a republish", async () => {
    createMutate.mockImplementation(async (input: unknown) => {
      calls.push({ url: "/api/social/posts", body: input });
      return PARTIAL;
    });
    const { onDone } = renderComposer();
    await advanceToReviewIn("now");
    await waitFor(() => expect(screen.getAllByTestId(/^validate-ok-/)).toHaveLength(2));

    fireEvent.click(screen.getByTestId("composer-submit"));
    fireEvent.click(await screen.findByTestId("publish-now-confirm"));

    await waitFor(() => expect(screen.getByTestId("per-target-errors")).toBeInTheDocument());
    expect(screen.getByTestId("per-target-errors").textContent).toContain(PARTIAL.perTarget[0].error);
    // The post EXISTS. Offering "nothing was posted → publish again" here is
    // exactly the double post this screen is meant to prevent.
    expect(screen.queryByTestId("composer-needs-confirmation")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-error")).not.toBeInTheDocument();
    expect(onDone).toHaveBeenCalledWith(null);
  });
});

describe("Composer — TikTok's consents are the checkboxes, not a constant", () => {
  it("unticking them after Review sends false and blocks the send", async () => {
    renderComposer();
    await advanceToReviewIn("draft");
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toBeEnabled());

    // The rail walks BACK past a gate the Next button would have held.
    fireEvent.click(screen.getByTestId("rail-targets"));
    fireEvent.click(screen.getByTestId("tiktok-consent-preview"));
    fireEvent.click(screen.getByTestId("tiktok-consent-express"));
    fireEvent.click(screen.getByTestId("rail-review"));

    await waitFor(() => {
      const sent = lastBodyFor("/api/social/validate") as { targets?: Array<{ options: { platform: string; tiktok?: Record<string, unknown> } }> };
      const tt = sent?.targets?.find((t) => t.options.platform === "tiktok");
      expect(tt?.options.tiktok?.contentPreviewConfirmed).toBe(false);
      expect(tt?.options.tiktok?.expressConsentGiven).toBe(false);
    });
    expect(screen.getByTestId("composer-submit")).toBeDisabled();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("a consented send carries both consents true", async () => {
    renderComposer();
    await advanceToReviewIn("draft");
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const body = createMutate.mock.calls[0][0] as { targets: Array<{ options: { platform: string; tiktok?: Record<string, unknown> } }> };
    const tt = body.targets.find((t) => t.options.platform === "tiktok");
    expect(tt?.options.tiktok).toMatchObject({ contentPreviewConfirmed: true, expressConsentGiven: true });
  });
});

describe("Composer — what does and does not count as 'libi could not confirm'", () => {
  async function failPublishWith(thrown: () => unknown) {
    postsFailures = 1;
    postsThrow = thrown;
    renderComposer();
    await advanceToReviewIn("now");
    await waitFor(() => expect(screen.getAllByTestId(/^validate-ok-/)).toHaveLength(2));
    fireEvent.click(screen.getByTestId("composer-submit"));
    fireEvent.click(await screen.findByTestId("publish-now-confirm"));
  }

  it("a 422 libi's own route produced is a plain failure with a Retry", async () => {
    await failPublishWith(() => new SocialApiError(422, { error: "validation", message: "Instagram posts require media content" }));
    expect(await screen.findByTestId("composer-error")).toBeInTheDocument();
    // Nothing reached a platform, so nothing to go and check.
    expect(screen.queryByTestId("composer-needs-confirmation")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-retry")).toBeInTheDocument();
  });

  it("the adapter's own confirm_republish raises the gate", async () => {
    await failPublishWith(() => new SocialApiError(409, { error: "confirm_republish", message: "A previous attempt may have gone out" }));
    expect(await screen.findByTestId("composer-needs-confirmation")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-retry")).not.toBeInTheDocument();
  });

  it("a 5xx after the request left raises it too — that is the unreadable window", async () => {
    await failPublishWith(() => new SocialApiError(502, { error: "provider", message: "upstream broke" }));
    expect(await screen.findByTestId("composer-needs-confirmation")).toBeInTheDocument();
  });

  it("an upload that failed before a byte left is never a maybe-published post", async () => {
    // The uploaded URL is already past its expiry, so submit uploads again —
    // and THAT attempt fails with the provider untouched.
    uploadExpiry = new Date(Date.now() - 1000).toISOString();
    renderComposer();
    await advanceToCaption();
    await finishUpload();
    fireEvent.click(next());
    fireEvent.click(screen.getByTestId("when-now"));
    fireEvent.click(next());
    await waitFor(() => expect(screen.getAllByTestId(/^validate-ok-/)).toHaveLength(2));

    // The cached upload is gone at submit time, and the re-upload 422s.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      calls.push({ url, body: undefined });
      if (url === "/api/social/upload") return jsonResponse({ error: "validation", message: "that file is not one of your exports" }, 422);
      if (url === "/api/social/validate") return jsonResponse(validateResult);
      return jsonResponse({}, 404);
    });
    fireEvent.click(screen.getByTestId("composer-submit"));
    fireEvent.click(await screen.findByTestId("publish-now-confirm"));
    await waitFor(() => expect(screen.getAllByText("that file is not one of your exports").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("composer-needs-confirmation")).not.toBeInTheDocument();
    expect(createMutate).not.toHaveBeenCalled();
  });
});

describe("Composer — the request id is the server's, so it survives a remount", () => {
  it("sends the id the route answered with, for this piece", async () => {
    renderComposer();
    await advanceToReviewIn("draft");
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(createMutate).toHaveBeenCalled());

    const asked = calls.find((c) => c.url.startsWith("/api/social/request-id"));
    expect(asked?.url).toContain("pieceId=p1");
    // Not `crypto.randomUUID()`: a per-mount id gives a reopened composer a
    // brand-new identity, and the adapter's dedupe never fires.
    expect((createMutate.mock.calls[0][0] as { requestId: string }).requestId).toBe(seedRequestId);
  });

  it("still composes when the route cannot answer, with an id of its own", async () => {
    seedRequestId = null;
    renderComposer();
    await advanceToReviewIn("draft");
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    expect(String((createMutate.mock.calls[0][0] as { requestId: string }).requestId)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("Composer — one send per click", () => {
  it("two fast clicks on Retry dispatch ONE create", async () => {
    postsFailures = 1;
    renderComposer();
    await advanceToReviewIn("draft");
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("composer-submit"));
    const retry = await screen.findByTestId("composer-retry");

    // BOTH clicks inside one act: the second lands before React has
    // re-rendered the button as disabled, which is what a real double click
    // does and what the `disabled` prop alone cannot catch.
    await act(async () => {
      retry.click();
      retry.click();
    });
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(createMutate).toHaveBeenCalledTimes(2); // the failed one + ONE retry
  });
});

describe("Composer — the gate needs an actual verdict", () => {
  function validateFails() {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url === "/api/social/fit") return jsonResponse({ probe: PROBE, verdicts: fitVerdicts.map((v) => ({ ...v, probe: PROBE })) });
      if (url === "/api/social/upload") return jsonResponse({ jobId: "job-up-1" });
      if (url.startsWith("/api/social/request-id")) return jsonResponse({ requestId: seedRequestId, source: "intent" });
      if (url === "/api/social/validate") return jsonResponse({ error: "internal" }, 500);
      return jsonResponse({}, 404);
    });
  }

  it("Schedule stays blocked when validation never answered", async () => {
    validateFails();
    renderComposer();
    await advanceToReviewIn("schedule");
    expect(await screen.findByTestId("validate-error")).toBeInTheDocument();
    // No verdict is not the same as nothing failed.
    expect(screen.getByTestId("composer-submit")).toBeDisabled();
  });

  it("a draft is still saveable — it reaches no platform", async () => {
    validateFails();
    renderComposer();
    await advanceToReviewIn("draft");
    expect(await screen.findByTestId("validate-error")).toBeInTheDocument();
    expect(screen.getByTestId("composer-submit")).toBeEnabled();
  });
});

describe("Composer — a reopened schedule keeps its own wall clock", () => {
  it("renders the time in the POST's timezone, not the browser's", async () => {
    existingPost = {
      id: "post_existing",
      status: "scheduled",
      content: "old caption",
      createdAt: "2026-09-19T00:00:00.000Z",
      scheduledFor: "2030-01-01T02:00:00.000Z",
      // +05:45. No test host is in this zone, so a browser-zone conversion
      // cannot accidentally produce the right answer.
      timezone: "Asia/Kathmandu",
      media: [{ url: "https://media.zernio.com/media/old.mp4", type: "video" }],
      targets: [{ platform: "instagram", accountId: "acct-ig", status: "pending" }],
      tags: [],
      link: null,
    };
    renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/e.mp4", draftPostId: "post_existing" } });
    await advanceToCaption();
    fireEvent.click(next());
    expect(screen.getByTestId("when-schedule")).toBeChecked();
    expect(screen.getByTestId("when-schedule-tz")).toHaveValue("Asia/Kathmandu");
    // 02:00 UTC is 07:45 in Kathmandu. Showing the browser's wall clock under
    // this label would MOVE the schedule on the next save.
    expect(screen.getByTestId("when-schedule-readback")).toHaveTextContent("Tue 1 Jan, 07:45");
    expect(screen.getByTestId("when-schedule-readback")).toHaveTextContent("Asia/Kathmandu");
  });
});

describe("Composer — an update re-sends media libi can still resolve", () => {
  it("sends this upload's own temp URL, never the promoted one the post carries", async () => {
    existingPost = {
      id: "post_existing",
      status: "draft",
      content: "old caption",
      createdAt: "2026-09-19T00:00:00.000Z",
      // What a read really returns: the PROMOTED url, which 404s.
      media: [{ url: "https://media.zernio.com/media/1_e.mp4", type: "video" }],
      targets: [{ platform: "instagram", accountId: "acct-ig", status: "pending", options: { platform: "instagram", instagram: { contentType: "reel" } } }],
      tags: [],
      link: null,
      libi: { pieceId: "p1", requestId: "r-orig", mediaUrl: "https://media.zernio.com/temp/1_e.mp4" },
    };
    renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/e.mp4", draftPostId: "post_existing" } });
    await advanceToReviewIn("draft");
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(updateMutate).toHaveBeenCalled());

    const patch = updateMutate.mock.calls[0][0] as { media?: Array<{ url: string }>; libi?: { mediaUrl?: string } };
    // An update that carried NO media failed with "Some media files failed to
    // upload" just as surely as one that re-sent the promoted URL.
    expect(patch.media?.[0].url).toBe(UPLOAD_RESULT.publicUrl);
    expect(patch.media?.[0].url).toContain("/temp/");
    expect(patch.media?.[0].url).not.toContain("/media/");
    expect(patch.libi?.mediaUrl).toBe("https://media.zernio.com/temp/1_e.mp4");
  });
});

describe("Composer — the post's music override is the user's choice, never the resolved plan (I1)", () => {
  async function toMusic() {
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(screen.getByTestId("music-step")).toBeInTheDocument();
  }
  const choicesOf = (id: string) => mountedChoices.filter((m) => m.accountId === id).map((m) => m.choice);

  it("leaving Music and coming back re-plans with NO override: the reported music is not pinned", async () => {
    renderComposer();
    await toMusic();
    // Each block reported its resolved music on mount ("strip" in this stub)…
    fireEvent.click(next()); // music -> caption
    fireEvent.click(composerBack()); // caption -> music: the blocks remount
    await waitFor(() => expect(choicesOf("acct-tt")).toHaveLength(2));
    // …and still mount with no override: the song's current pick decides.
    expect(choicesOf("acct-tt")).toEqual([undefined, undefined]);
    expect(choicesOf("acct-ig")).toEqual([undefined, undefined]);
  });

  it("an explicit choice survives the round trip; a settling pick clears only the override it set", async () => {
    renderComposer();
    await toMusic();
    fireEvent.click(screen.getByTestId("music-choose-include-acct-ig"));
    // A stale settle (expects an override that is no longer there) changes nothing.
    fireEvent.click(screen.getByTestId("music-settle-stale-acct-ig"));
    fireEvent.click(composerBack()); // music -> targets
    fireEvent.click(next()); // targets -> music
    await waitFor(() => expect(choicesOf("acct-ig")).toHaveLength(2));
    expect(choicesOf("acct-ig")[1]).toEqual({ mode: "include" });
    expect(choicesOf("acct-tt")[1]).toBeUndefined();
  });
});

describe("Composer — a reopened post keeps its explicit Keep in / Leave out (I1-reopen)", () => {
  const igOptions = (mode: string) => ({
    platform: "instagram", instagram: { contentType: "reel", shareToFeed: true, commentsEnabled: true, isAiGenerated: true }, music: { mode },
  });
  const reopen = (mode: string) => {
    // The provider's real shape: Instagram's echoed options carry NO music —
    // libi's decision survives only in its own stamp (metadata.libi.targetOptions).
    const { music: _music, ...echoed } = igOptions(mode);
    void _music;
    existingPost = {
      id: "post_existing", status: "draft", content: "old caption", createdAt: "2026-09-19T00:00:00.000Z",
      media: [{ url: "https://media.zernio.com/media/old.mp4", type: "video" }],
      targets: [{ platform: "instagram", accountId: "acct-ig", status: "pending", options: echoed }],
      tags: [], link: null, libi: { pieceId: "p1", targetOptions: [igOptions(mode)] },
    };
    return renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/exp/e.mp4", draftPostId: "post_existing" } });
  };

  for (const mode of ["include", "strip"]) {
    it(`a provider draft with ${mode}: the plan keeps it and a re-save sends it`, async () => {
      reopen(mode);
      await waitFor(() => expect(next()).toBeEnabled());
      fireEvent.click(next()); // media -> targets
      await waitFor(() => expect(next()).toBeEnabled());
      fireEvent.click(next()); // targets -> music
      await waitFor(() => expect(mountedChoices.some((m) => m.accountId === "acct-ig")).toBe(true));
      expect(mountedChoices.find((m) => m.accountId === "acct-ig")!.choice).toEqual({ mode });
      await waitFor(() => expect(next()).toBeEnabled());
      fireEvent.click(next()); // music -> caption
      await finishUpload();
      fireEvent.click(next()); // caption -> when
      fireEvent.click(next()); // when -> review
      await waitFor(() => expect(screen.getByTestId("composer-submit")).toBeEnabled());
      fireEvent.click(screen.getByTestId("composer-submit"));
      await waitFor(() => expect(updateMutate).toHaveBeenCalled());
      const patch = updateMutate.mock.calls[0][0] as { targets?: Array<{ options: { music?: { mode: string } } }> };
      expect(patch.targets?.[0].options.music).toEqual({ mode });
    });
  }

  it("a local composer draft saved without musicChoice restores include as the override; attach is not pinned", async () => {
    window.localStorage.setItem(
      composerDraftKey("p1", null),
      JSON.stringify({
        v: 1, step: "targets", exportPath: "/exp/e.mp4", caption: "c", when: { mode: "draft" }, savedAt: new Date().toISOString(),
        targets: [
          { platform: "instagram", accountId: "acct-ig", options: igOptions("include") },
          { platform: "tiktok", accountId: "acct-tt", options: { platform: "tiktok", tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, commercialContentType: "none", madeWithAi: true, contentPreviewConfirmed: false, expressConsentGiven: false }, music: { mode: "attach", track: { id: "t", title: "Espresso" }, musicVolume: 80, originalVolume: 100 } } },
        ],
      }),
    );
    renderComposer();
    await waitFor(() => expect(screen.getByTestId("rail-targets")).toBeInTheDocument());
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    await waitFor(() => expect(mountedChoices).toHaveLength(2));
    expect(mountedChoices.find((m) => m.accountId === "acct-ig")!.choice).toEqual({ mode: "include" });
    expect(mountedChoices.find((m) => m.accountId === "acct-tt")!.choice).toBeUndefined();
  });
});

// ── The exports rework: the picker, the music plan, and the round trip ─────────

type ComposerExports = NonNullable<React.ComponentProps<typeof Composer>["exports"]>;
type AwaitedExport = NonNullable<React.ComponentProps<typeof Composer>["awaitedExport"]>;

/** One finished export, as the Posting tab hands it to the composer. */
const exportRow = (id: string, over: Record<string, unknown> = {}, song: "with" | "without" | "none" = "none") => ({
  filePath: `/s/p1/exports/${id}.mp4`,
  exportId: `exp_${id}`,
  name: id,
  aspect: "9:16",
  ...PROBE,
  ...(song === "none"
    ? {}
    : {
        audioDecision: {
          purpose: song === "with" ? "personal" : "social",
          excludedFileIds: song === "with" ? [] : ["s"],
          carriesCopyrighted: song === "with",
        },
      }),
  ...over,
});

/** An export record in any state, as `useExports` answers it. */
const record = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id: `exp_${id}`, pieceId: "p1", pieceName: "Cutdown v3", jobId: null, name: id, fileName: `${id}.mp4`, path: null, status: "running",
    missing: false, error: null, queuedAt: 1, startedAt: 2, completedAt: null, sizeBytes: null, durationSec: null, width: null, height: null,
    aspect: "9:16", container: "mp4", codec: "avc", fps: 30, quality: "source", graphicsQuality: null, purpose: "social",
    carriesCopyrighted: false, excludedFileIds: [], backend: null, droppedOverlays: null, source: "user", progress: null, waiting: null, ...over,
  }) as unknown as AwaitedExport;

/** `renderComposer`, but keeping the query client so a rerender is the SAME composer. */
function renderKeeping(props: Partial<React.ComponentProps<typeof Composer>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const onExportRequested = vi.fn();
  const base = {
    intent: { pieceId: "p1", pieceName: "Cutdown v3" },
    latestExport: null,
    onExportRequested,
    onDone: vi.fn(),
  } as React.ComponentProps<typeof Composer>;
  const tree = (over: Partial<React.ComponentProps<typeof Composer>>) => (
    <QueryClientProvider client={qc}>
      <Composer {...base} {...props} {...over} />
    </QueryClientProvider>
  );
  const utils = tlRender(tree({}));
  return { ...utils, onExportRequested, update: (over: Partial<React.ComponentProps<typeof Composer>>) => utils.rerender(tree(over)) };
}

describe("Composer — the Media step's export picker offers every finished export", () => {
  it("lists them newest first, each labelled so they can be told apart", async () => {
    const list = [
      exportRow("promo-final", { aspect: "9:16", width: 1080, height: 1920 }, "without"),
      exportRow("promo-song", { aspect: "9:16", sizeBytes: 20_000_000 }, "with"),
      exportRow("wide-cut", { aspect: "16:9", width: 1920, height: 1080 }, "none"),
    ] as ComposerExports;
    renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3" }, latestExport: list[0], exports: list });
    const picker = await screen.findByRole("combobox", { name: "Export file" });
    const options = Array.from(picker.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual([
      "promo-final · 9:16 · 1080×1920 · 39.1 MB · without the song",
      "promo-song · 9:16 · 1080×1920 · 19.1 MB · with the song",
      "wide-cut · 16:9 · 1920×1080 · 39.1 MB",
    ]);
    // The newest is selected, and the step says what it carries.
    expect(picker).toHaveValue("/s/p1/exports/promo-final.mp4");
    expect(screen.getByTestId("export-song-note")).toHaveTextContent("without the song");
  });

  it("an explicit pick is what the composer posts, and a later poll does not undo it", async () => {
    const list = [exportRow("new"), exportRow("old")] as ComposerExports;
    const { update } = renderKeeping({ latestExport: list[0], exports: list });
    const picker = await screen.findByRole("combobox", { name: "Export file" });
    fireEvent.change(picker, { target: { value: "/s/p1/exports/old.mp4" } });
    expect(await screen.findByTestId("export-line")).toHaveTextContent("old.mp4");
    // A newer export lands in the list meanwhile.
    const more = [exportRow("newest"), ...list] as ComposerExports;
    update({ latestExport: more[0], exports: more });
    expect(screen.getByTestId("export-line")).toHaveTextContent("old.mp4");
    await waitFor(() => expect(calls.some((c) => (c.body as { exportPath?: string } | undefined)?.exportPath === "/s/p1/exports/old.mp4")).toBe(true));
  });

  it("a single export needs no picker", async () => {
    const list = [exportRow("only")] as ComposerExports;
    renderComposer({ intent: { pieceId: "p1", pieceName: "Cutdown v3" }, latestExport: list[0], exports: list });
    await screen.findByTestId("export-line");
    expect(screen.queryByRole("combobox", { name: "Export file" })).toBeNull();
  });
});

describe("Composer — a music plan that needs another export uses one the piece already has", () => {
  const SONG = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
  async function toMusic() {
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    await screen.findByTestId("music-step");
  }
  const NO_PIN = { pieceId: "p1", pieceName: "Cutdown v3" };

  it("switches to the newest export that leaves the song out, says which, and never offers to export again", async () => {
    pieceCopyrighted = SONG;
    // The newest keeps the song; the plan (both accounts default to leaving it out) needs one that doesn't.
    const list = [exportRow("with-song-new", {}, "with"), exportRow("social-new", {}, "without"), exportRow("social-old", {}, "without")] as ComposerExports;
    renderComposer({ intent: NO_PIN, latestExport: list[0], exports: list });
    await toMusic();
    expect(await screen.findByTestId("export-notice")).toHaveTextContent("Switched to social-new");
    expect(screen.getByTestId("export-notice")).toHaveTextContent("leaves out the song");
    expect(screen.queryByTestId("music-blocked-reason")).toBeNull();
    expect(screen.queryByTestId("export-for-social")).toBeNull();
    expect(next()).toBeEnabled();
    // Back on Media, the switched-to export is the one selected.
    fireEvent.click(screen.getByTestId("rail-media"));
    expect(await screen.findByTestId("export-line")).toHaveTextContent("social-new.mp4");
  });

  it("offers Export for social only when no finished export fits", async () => {
    pieceCopyrighted = SONG;
    const list = [exportRow("with-song-new", {}, "with"), exportRow("with-song-old", {}, "with")] as ComposerExports;
    const { onExportRequested } = renderComposer({ intent: NO_PIN, latestExport: list[0], exports: list });
    await toMusic();
    expect(await screen.findByTestId("music-blocked-reason")).toHaveTextContent("This export doesn't match the music plan");
    expect(screen.queryByTestId("export-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("export-for-social"));
    expect(onExportRequested).toHaveBeenCalledTimes(1);
  });

  it("an export that predates the audio record never counts as a match", async () => {
    pieceCopyrighted = SONG;
    const list = [exportRow("with-song", {}, "with"), exportRow("undated", {}, "none")] as ComposerExports;
    renderComposer({ intent: NO_PIN, latestExport: list[0], exports: list });
    await toMusic();
    expect(await screen.findByTestId("export-for-social")).toBeInTheDocument();
  });

  it("an export the user chose for this plan is not swapped: the block says why and offers the one that fits", async () => {
    pieceCopyrighted = SONG;
    const list = [exportRow("with-song", {}, "with"), exportRow("social", {}, "without")] as ComposerExports;
    // Opened on the song export on purpose (Post…); the plan wants the song left out.
    renderComposer({
      intent: { pieceId: "p1", pieceName: "Cutdown v3", exportPath: "/s/p1/exports/with-song.mp4" },
      latestExport: list[0],
      exports: list,
    });
    await toMusic();
    expect(await screen.findByTestId("music-blocked-reason")).toHaveTextContent("This export has the song; your plan posts without it.");
    expect(screen.queryByTestId("export-notice")).toBeNull();
    expect(screen.queryByTestId("export-for-social")).toBeNull();
    fireEvent.click(screen.getByTestId("use-matching-export"));
    await waitFor(() => expect(next()).toBeEnabled());
    expect(screen.queryByTestId("music-blocked-reason")).toBeNull();
  });

  it("a pick made under one plan is swapped, with an explanation, once the plan changes and it no longer fits", async () => {
    pieceCopyrighted = SONG;
    const list = [exportRow("social", {}, "without"), exportRow("with-song", {}, "with")] as ComposerExports;
    renderComposer({ intent: NO_PIN, latestExport: list[0], exports: list });
    await waitFor(() => expect(next()).toBeEnabled());
    // The user picks the social (no-song) export for the plan as it stands…
    fireEvent.change(await screen.findByRole("combobox", { name: "Export file" }), { target: { value: "/s/p1/exports/social.mp4" } });
    fireEvent.click(next()); // media -> targets
    fireEvent.click(screen.getByTestId("target-toggle-acct-tt")); // post to Instagram only
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    await screen.findByTestId("music-step");
    // …and no swap happens while the plan still fits it.
    expect(screen.queryByTestId("export-notice")).toBeNull();
    // Then the user keeps the song in: the pick no longer fits, and the composer says what it moved to.
    fireEvent.click(screen.getByTestId("music-block-acct-ig"));
    expect(await screen.findByTestId("export-notice")).toHaveTextContent("Switched to with-song");
    expect(screen.getByTestId("export-notice")).toHaveTextContent("keeps the song");
    expect(next()).toBeEnabled();
  });

  it("does nothing before the plan is known: a song export is not swapped away on the first steps", async () => {
    pieceCopyrighted = SONG;
    neverReports = new Set(["acct-ig", "acct-tt"]);
    const list = [exportRow("with-song", {}, "with"), exportRow("social", {}, "without")] as ComposerExports;
    renderComposer({ intent: NO_PIN, latestExport: list[0], exports: list });
    await toMusic();
    expect(screen.queryByTestId("export-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("rail-media"));
    expect(await screen.findByTestId("export-line")).toHaveTextContent("with-song.mp4");
  });
});

describe("Composer — the export this post is waiting for", () => {
  it("while it renders, the Media step says so with the record's own progress, and offers no second export", async () => {
    renderKeeping({ awaitedExport: record("social", { status: "running", progress: { done: 40, total: 100, unit: "%", etaMs: null } }) });
    const box = await screen.findByTestId("export-await");
    expect(box).toHaveTextContent("Exporting social for this post");
    expect(screen.getByTestId("export-await-line")).toHaveTextContent("Exporting 40%");
    expect(screen.getByTestId("media-step")).toHaveTextContent("Your export is rendering");
    expect(screen.queryByRole("button", { name: "Export & post" })).toBeNull();
  });

  it("a queued export says why it waits", async () => {
    renderKeeping({
      awaitedExport: record("social", { status: "queued", waiting: { reason: "memory", message: "Waiting for memory — 2 exports running" } }),
    });
    expect(await screen.findByTestId("export-await-line")).toHaveTextContent("Waiting for memory — 2 exports running");
  });

  it("when it finishes it is selected for the user, who can go on", async () => {
    const { update } = renderKeeping({ awaitedExport: record("social", { status: "running" }) });
    await screen.findByTestId("export-await");
    expect(screen.queryByTestId("composer-next")).toBeNull();

    const done = exportRow("social", {}, "without") as unknown as LatestExportRow;
    update({
      latestExport: done,
      exports: [done] as ComposerExports,
      awaitedExport: record("social", { status: "done", path: done.filePath }),
    });
    expect(await screen.findByTestId("export-line")).toHaveTextContent("social.mp4");
    expect(screen.queryByTestId("export-await")).toBeNull();
    expect(screen.getByTestId("export-notice")).toHaveTextContent("Your new export social");
    await waitFor(() => expect(next()).toBeEnabled());
  });

  it("selects it over an older export the composer had already picked", async () => {
    const older = exportRow("older") as unknown as LatestExportRow;
    const { update } = renderKeeping({ latestExport: older, exports: [older] as ComposerExports, awaitedExport: record("social", { status: "running" }) });
    expect(await screen.findByTestId("export-line")).toHaveTextContent("older.mp4");
    const done = exportRow("social", {}, "without") as unknown as LatestExportRow;
    update({ latestExport: done, exports: [done, older] as ComposerExports, awaitedExport: record("social", { status: "done", path: done.filePath }) });
    await waitFor(() => expect(screen.getByTestId("export-line")).toHaveTextContent("social.mp4"));
  });

  it("a failed export is said so in the composer, with its reason, and Try again asks for the dialog again", async () => {
    const { onExportRequested } = renderKeeping({ awaitedExport: record("social", { status: "failed", error: "ffmpeg ran out of memory" }) });
    const box = await screen.findByTestId("export-await");
    expect(box).toHaveTextContent("The export social failed: ffmpeg ran out of memory");
    fireEvent.click(screen.getByTestId("export-await-retry"));
    expect(onExportRequested).toHaveBeenCalledTimes(1);
    // The Media step is back to offering to export, not stuck "rendering".
    expect(screen.getByTestId("media-step")).not.toHaveTextContent("Your export is rendering");
    fireEvent.click(screen.getByTestId("export-await-dismiss"));
    expect(screen.queryByTestId("export-await")).toBeNull();
  });

  it("a cancelled export is said so too", async () => {
    renderKeeping({ awaitedExport: record("social", { status: "cancelled" }) });
    expect(await screen.findByTestId("export-await")).toHaveTextContent("The export social was cancelled.");
    expect(screen.getByTestId("export-await-retry")).toBeInTheDocument();
  });

  it("does not offer Export for social on the Music step while one is already rendering", async () => {
    pieceCopyrighted = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
    const withSong = exportRow("with-song", {}, "with") as unknown as LatestExportRow;
    renderKeeping({
      latestExport: withSong,
      exports: [withSong] as ComposerExports,
      awaitedExport: record("social", { status: "running" }),
    });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // media -> targets
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(await screen.findByTestId("music-blocked-reason")).toBeInTheDocument();
    expect(screen.queryByTestId("export-for-social")).toBeNull();
    expect(screen.getByTestId("export-await")).toBeInTheDocument();
  });
});

type LatestExportRow = NonNullable<React.ComponentProps<typeof Composer>["latestExport"]>;


describe("Composer — pins, notices and the hand-offs it stops handing on", () => {
  const SONG = [{ fileId: "s", name: "s.mp3", clipSeconds: 10 }];
  const NO_PIN = { pieceId: "p1", pieceName: "Cutdown v3" };
  const toTargets = async () => {
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
  };

  it("says what differs, and offers the fitting export, when the pick does not fit but another does; only 'export it' when none does", async () => {
    pieceCopyrighted = SONG;
    const list = [exportRow("social", {}, "without"), exportRow("with-song", {}, "with")] as ComposerExports;
    renderComposer({ intent: { ...NO_PIN, exportPath: "/s/p1/exports/with-song.mp4" }, latestExport: list[0], exports: list });
    await toTargets();
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
    const reason = await screen.findByTestId("music-blocked-reason");
    expect(reason).toHaveTextContent("This export has the song; your plan posts without it.");
    expect(reason).not.toHaveTextContent("export it for a social post first");
    expect(screen.getByTestId("use-matching-export")).toBeInTheDocument();
    expect(screen.queryByTestId("export-for-social")).toBeNull();
  });

  it("a Post… export is pinned to the plan it first meets, not to a guess: a without-song export under an include plan is swapped", async () => {
    pieceCopyrighted = SONG;
    const list = [exportRow("social", {}, "without"), exportRow("with-song", {}, "with")] as ComposerExports;
    // Post… on the no-song export, but the plan (Instagram only, keep the song) needs the one with it.
    renderComposer({ intent: { ...NO_PIN, exportPath: "/s/p1/exports/social.mp4" }, latestExport: list[0], exports: list });
    await toTargets();
    fireEvent.click(screen.getByTestId("target-toggle-acct-tt"));
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    await screen.findByTestId("music-step");
    expect(screen.queryByTestId("export-notice")).toBeNull(); // strip plan: the no-song export fits and stays
    fireEvent.click(screen.getByTestId("music-block-acct-ig")); // include
    expect(await screen.findByTestId("export-notice")).toHaveTextContent("Switched to with-song");
  });

  it("after a swap the pick is released: the plan going A -> B -> A swaps back instead of blocking", async () => {
    pieceCopyrighted = SONG;
    const list = [exportRow("no-song", {}, "without"), exportRow("with-song", {}, "with")] as ComposerExports;
    renderComposer({ intent: NO_PIN, latestExport: list[0], exports: list });
    await waitFor(() => expect(next()).toBeEnabled());
    // The user picks the no-song export under the plan as it stands.
    fireEvent.change(await screen.findByRole("combobox", { name: "Export file" }), { target: { value: "/s/p1/exports/no-song.mp4" } });
    fireEvent.click(next()); // media -> targets
    fireEvent.click(screen.getByTestId("target-toggle-acct-tt")); // Instagram only
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music (plan: without the song, which fits)
    await screen.findByTestId("music-step");
    fireEvent.click(screen.getByTestId("music-block-acct-ig")); // plan B: with the song -> swaps
    expect(await screen.findByTestId("export-notice")).toHaveTextContent("Switched to with-song");
    // Plan A again: post to TikTok only (it reports "without the song").
    fireEvent.click(composerBack()); // music -> targets
    fireEvent.click(screen.getByTestId("target-toggle-acct-tt"));
    fireEvent.click(screen.getByTestId("target-toggle-acct-ig"));
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // targets -> music
    expect(await screen.findByTestId("export-notice")).toHaveTextContent("Switched to no-song");
    expect(screen.queryByTestId("music-blocked-reason")).toBeNull();
    expect(next()).toBeEnabled();
  });

  it("a swap's notice goes away with its step and with its plan", async () => {
    pieceCopyrighted = SONG;
    const list = [exportRow("with-song-new", {}, "with"), exportRow("social", {}, "without")] as ComposerExports;
    renderComposer({ intent: NO_PIN, latestExport: list[0], exports: list });
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next()); // music: swaps
    expect(await screen.findByTestId("export-notice")).toBeInTheDocument();
    fireEvent.click(next()); // caption
    await waitFor(() => expect(screen.getByTestId("rail-caption")).toHaveAttribute("aria-current", "step"));
    expect(screen.queryByTestId("export-notice")).toBeNull();
  });

  it("an adopted awaited export is reported handled once, and a dismissed failure too", async () => {
    const onAwaitedHandled = vi.fn();
    const done = exportRow("social", {}, "without") as unknown as LatestExportRow;
    const { update } = renderKeeping({ onAwaitedHandled, awaitedExport: record("social", { status: "running" }) });
    await screen.findByTestId("export-await");
    expect(onAwaitedHandled).not.toHaveBeenCalled();
    update({ latestExport: done, exports: [done] as ComposerExports, awaitedExport: record("social", { status: "done", path: done.filePath }), onAwaitedHandled });
    await waitFor(() => expect(onAwaitedHandled).toHaveBeenCalledTimes(1));

    const dismissed = vi.fn();
    cleanup();
    renderKeeping({ onAwaitedHandled: dismissed, awaitedExport: record("x", { status: "failed", error: "boom" }) });
    fireEvent.click(await screen.findByTestId("export-await-dismiss"));
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it("another export finishing meanwhile is not adopted: only the awaited one is", async () => {
    const older = exportRow("older") as unknown as LatestExportRow;
    const other = exportRow("other", {}, "without") as unknown as LatestExportRow;
    const { update } = renderKeeping({ latestExport: older, exports: [older] as ComposerExports, awaitedExport: record("social", { status: "running" }) });
    expect(await screen.findByTestId("export-line")).toHaveTextContent("older.mp4");
    update({ latestExport: other, exports: [other, older] as ComposerExports, awaitedExport: record("social", { status: "running" }) });
    await screen.findByTestId("export-await");
    expect(screen.getByTestId("export-line")).toHaveTextContent("older.mp4");
    expect(screen.queryByTestId("export-notice")).toBeNull();
  });

  it("a finished export the composer cannot read says so instead of the panel just vanishing", async () => {
    // Done, but the record has no size: it never enters the list of finished exports.
    renderKeeping({ awaitedExport: record("odd", { status: "done", path: "/s/p1/exports/odd.mp4", width: null, height: null }) });
    const box = await screen.findByTestId("export-await");
    expect(box).toHaveTextContent("finished, but libi can't read its file");
    expect(screen.getByTestId("export-await-retry")).toBeInTheDocument();
  });
});
