// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as tlRender, screen, fireEvent, waitFor, act } from "@testing-library/react";
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
  fireEvent.click(next()); // targets -> caption
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
    fireEvent.click(next());
    fireEvent.click(screen.getByTestId("ig-type-story"));
    consentTikTok();
    await waitFor(() => expect(next()).toBeEnabled());
    fireEvent.click(next());
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
    fireEvent.click(next()); // targets -> caption (this is what starts the upload)
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
  it("uploads once after Targets, shows the percentage, and never re-uploads on a second Next", async () => {
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
