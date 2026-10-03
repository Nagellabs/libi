import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `libi.post_piece` is the one agent-facing tool on this feature that can
 * spend the user's time (an export) and put something on their provider
 * account. The tests that matter most are therefore the NEGATIVE ones:
 *
 *  - it never publishes or schedules, whatever it is asked;
 *  - it does not export when the request cannot possibly post;
 *  - it uploads nothing when the export does not fit a platform;
 *  - it never invents a TikTok privacy level.
 *
 * Everything is driven through mocked HTTP (the MCP child reaches the studio
 * over 127.0.0.1 and may import neither `lib/social/service` nor `lib/jobs`),
 * plus module mocks for the two job-backed calls.
 */

const exportVideo = vi.hoisted(() => vi.fn());
const runJobViaServer = vi.hoisted(() => vi.fn());
/** When the piece's composition last changed (epoch ms); null = never saved. */
const compositionChangedAtMs = vi.hoisted(() => vi.fn(async (): Promise<number | null> => null));

vi.mock("@/mcp/tools/export-tools", () => ({ exportVideo }));
vi.mock("@/lib/composition/changed-at", () => ({ compositionChangedAtMs }));
// libi's storage is the OS temp dir here, so every fixture file below counts
// as one of the user's exports (lib/social/fit-check.ts#isAllowedExportPath)
// and this checkout's own files do not.
vi.mock("@/lib/libi-home", async (orig) => ({
  ...(await orig<typeof import("@/lib/libi-home")>()),
  getLibiStorageDir: () => os.tmpdir(),
}));
vi.mock("@/mcp/jobs-client", () => ({
  runJobViaServer,
  LibiServerUnavailableError: class extends Error {},
}));

import { socialStatus, postPiece, socialLinkPost } from "@/mcp/tools/social-tools";
import { notify } from "@/mcp/notify";
import { planInboxSend } from "@/lib/social/inbox";
import type { SocialPost, TargetOptions } from "@/lib/social/types";

const IG = {
  id: "acc-ig",
  platform: "instagram",
  username: "zernio_demo",
  displayName: "Zernio Demo",
  active: true,
};
const IG2 = { ...IG, id: "acc-ig-2", username: "second_account" };
const TT = {
  id: "acc-tt",
  platform: "tiktok",
  username: "tiktok_demo",
  displayName: "TikTok Demo",
  active: true,
};

const CREATOR = {
  accountId: "acc-tt",
  privacyLevels: ["PUBLIC_TO_EVERYONE"],
  maxVideoSeconds: 600,
  canPostMore: true,
  interactions: {
    allow_comment: { required: true, default: true },
    allow_duet: { required: true, default: false },
    allow_stitch: { required: true, default: true },
  },
};

const UPLOAD = {
  publicUrl: "https://media.zernio.com/temp/abc.mp4",
  expiresAt: "2026-09-20T12:00:00.000Z",
  sizeBytes: 1234,
  contentType: "video/mp4",
  filename: "piece.mp4",
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** Every studio call this test made, in order. */
let calls: Call[] = [];
/** Route table: the FIRST matching entry answers. */
let routes: Array<[RegExp, (url: string) => { status?: number; body: unknown }]> = [];

function respond(url: string): Response {
  const route = routes.find(([re]) => re.test(url));
  const answer = route ? route[1](url) : { status: 404, body: { error: "no route in test" } };
  const status = answer.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => answer.body,
  } as unknown as Response;
}

const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  let body: Record<string, unknown> | null = null;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  calls.push({ url: u, method: init?.method ?? "GET", body });
  return respond(u);
});

/**
 * The tests' finished-export fixtures (written as the job rows they used to
 * be) as the piece's export records the tool now reads — filtered to the piece
 * in the URL, `missing` when the file is not on disk, like the route.
 */
function toExportViews(jobs: unknown[], url: string): Array<Record<string, unknown>> {
  const pieceId = decodeURIComponent(url.match(/\/api\/pieces\/([^/]+)\/exports$/)?.[1] ?? "");
  const rows = jobs as Array<{ pieceId: string; status: string; startedAt?: string; completedAt: string | null; resultJson: string }>;
  return rows
    .filter((j) => j.pieceId === pieceId && j.status === "completed")
    .map((j, i) => {
      const r = JSON.parse(j.resultJson) as {
        filePath: string;
        width?: number;
        height?: number;
        audioDecision?: { purpose: string | null; excludedFileIds: string[]; carriesCopyrighted: boolean };
      };
      return {
        id: `exp_${i}`,
        pieceId,
        status: "done",
        path: r.filePath,
        missing: !fs.existsSync(r.filePath),
        startedAt: j.startedAt ? Date.parse(j.startedAt) : null,
        completedAt: j.completedAt ? Date.parse(j.completedAt) : null,
        purpose: r.audioDecision?.purpose ?? null,
        excludedFileIds: r.audioDecision?.excludedFileIds ?? [],
        carriesCopyrighted: r.audioDecision?.carriesCopyrighted ?? false,
        // A social-sized file unless a fixture says otherwise.
        width: r.width ?? 1080,
        height: r.height ?? 1920,
      };
    });
}

/** The default happy path: connected, one IG + one TikTok, everything fits. */
function connectedRoutes(over: Partial<{ accounts: unknown[]; verdicts: unknown[]; jobs: unknown[]; plan: unknown }> = {}) {
  let requestIds = 0;
  const nextRequestId = (): string => {
    requestIds += 1;
    return requestIds === 1 ? "11111111-2222-3333-4444-555555555555" : `11111111-2222-3333-4444-${String(requestIds).padStart(12, "0")}`;
  };
  routes = [
    [
      /\/api\/social\/status$/,
      () => ({
        body: {
          providerId: "zernio",
          connected: true,
          needsReconnect: false,
          settings: { timezone: "Asia/Bangkok", defaults: { instagramType: "reel", aiLabel: true } },
        },
      }),
    ],
    [/\/api\/social\/accounts$/, () => ({ body: { accounts: over.accounts ?? [IG, TT] } })],
    [/\/api\/social\/tiktok\/creator-info/, () => ({ body: CREATOR })],
    [/\/api\/pieces\/[^/]+\/exports$/, (url) => ({ body: { exports: toExportViews(over.jobs ?? [], url) } })],
    [
      /\/api\/social\/fit$/,
      () => ({
        body: {
          verdicts: over.verdicts ?? [
            { platform: "instagram", postType: "reel", ok: true, problems: [] },
            { platform: "tiktok", postType: "video", ok: true, problems: [] },
          ],
        },
      }),
    ],
    // A fresh id per call, as the route mints one per logical post: the first
    // is the fixed id the single-draft tests assert, every later one differs.
    [/\/api\/social\/request-id/, () => ({ body: { requestId: nextRequestId(), source: "fresh" } })],
    // A piece without copyrighted or own music: no plan to stamp, one export.
    [/\/api\/social\/music\/plan$/, () => ({ body: over.plan ?? { copyrighted: false, hasMusic: false, targets: [], variants: {} } })],
    [/\/api\/social\/posts$/, () => ({ body: { post: { id: "post-1", status: "draft" }, deduped: false } })],
    [/\/api\/social\/links$/, () => ({ body: { ok: true } })],
    [/\/api\/pieces\//, () => ({ body: { id: "piece-1", name: "My Piece" } })],
    [/\/api\/providers$/, () => ({ body: { connected: [] } })],
    [/\/api\/notify$/, () => ({ body: { ok: true } })],
  ];
}

/**
 * A REAL file standing in for the piece's export. `post_piece` fingerprints
 * the bytes it is about to upload (`exportFingerprint`) so the upload job
 * dedupes on the FILE and not merely its path — a path that does not exist
 * has no fingerprint, so the fixture has to be a file.
 */
const EXPORT_FILE = path.join(os.tmpdir(), "libi-social-tools-test-export.mp4");
fs.writeFileSync(EXPORT_FILE, "not really an mp4");
const EXPORT_FINGERPRINT = (): string => {
  const st = fs.statSync(EXPORT_FILE);
  return `${st.size}-${Math.round(st.mtimeMs)}`;
};

/** A second real file: an export larger than a post needs. */
const EXPORT_4K_FILE = path.join(os.tmpdir(), "libi-social-tools-test-export-4k.mp4");
fs.writeFileSync(EXPORT_4K_FILE, "not really a 4k mp4");

const postBody = () => calls.find((c) => /\/api\/social\/posts$/.test(c.url) && c.method === "POST")?.body ?? null;
const called = (re: RegExp) => calls.some((c) => re.test(c.url));

beforeEach(() => {
  calls = [];
  fetchMock.mockClear();
  exportVideo.mockReset();
  runJobViaServer.mockReset();
  compositionChangedAtMs.mockReset();
  compositionChangedAtMs.mockResolvedValue(null);
  runJobViaServer.mockResolvedValue({ status: "completed", jobId: "job-1", result: UPLOAD });
  exportVideo.mockResolvedValue({ success: true, data: { filePath: EXPORT_FILE, jobId: "x" } });
  vi.stubGlobal("fetch", fetchMock);
  connectedRoutes();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("libi.social_status", () => {
  it("reports libi's own connection, the accounts and the draft-only contract", async () => {
    routes.unshift([/\/api\/providers$/, () => ({ body: { connected: [{ agent: "claude", name: "zernio", providerId: "zernio", transport: "http", status: "connected" }] } })]);
    const res = await socialStatus();
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      providerId: "zernio",
      libiConnected: true,
      needsReconnect: false,
      timezone: "Asia/Bangkok",
      agentEntry: { claude: "connected", codex: "absent" },
    });
    expect((res.data!.accounts as unknown[]).length).toBe(2);
    expect(res.data!.postingContract).toMatch(/Draft only/);
  });

  it("a zernio entry the agent added but may never have signed in to is not reported as connected", async () => {
    routes.unshift([/\/api\/providers$/, () => ({ body: { connected: [{ agent: "codex", name: "zernio", providerId: "zernio", transport: "http", status: "connected", signIn: "unknown" }] } })]);
    const res = await socialStatus();
    expect((res.data!.agentEntry as Record<string, string>).codex).toBe("added-sign-in-unknown");
  });

  it("says plainly that LIBI is not connected, that the agent's own zernio tools are separate, and still carries the contract", async () => {
    routes.unshift([
      /\/api\/social\/status$/,
      () => ({ body: { providerId: "zernio", connected: false, needsReconnect: false, settings: { timezone: null, defaults: { instagramType: "reel", aiLabel: true } } } }),
    ]);
    const res = await socialStatus();
    expect(res.success).toBe(true);
    expect(res.data!.libiConnected).toBe(false);
    expect(res.data!.accounts).toBeNull();
    expect(res.data!.postingContract).toMatch(/Draft only/);
    expect(String(res.data!.hint)).toMatch(/separate from your own zernio tools/);
    expect(String(res.data!.hint)).toMatch(/libi\.social_link/);
    // Not connected: nothing is asked of the provider.
    expect(called(/\/api\/social\/accounts/)).toBe(false);
  });

  /**
   * QA 2026-09-21, finding 3. Handed `health.tokenExpiresAt` with nothing
   * saying what it means, a real chat turn told the user twice: "The TikTok
   * connection expires today at 11:47 UTC… you'll need to reconnect TikTok."
   * TikTok tokens are ~24 h and Zernio refreshes them silently — the UI shows
   * no countdown for exactly that reason — so the agent invented a chore.
   */
  it("hands the agent NO token expiry, for any account, however the provider reported it", async () => {
    routes.unshift([
      /\/api\/social\/accounts$/,
      () => ({
        body: {
          accounts: [
            { ...IG, health: { status: "healthy", tokenExpiresAt: "2026-11-18T11:00:22.425Z" } },
            { ...TT, health: { status: "healthy", tokenExpiresAt: "2026-09-22T11:47:00.000Z" } },
          ],
        },
      }),
    ]);
    const res = await socialStatus();
    // Not "absent from `health`" — absent from the whole answer. The agent
    // cannot editorialise a date it was never given.
    expect(JSON.stringify(res.data)).not.toContain("tokenExpiresAt");
    expect(JSON.stringify(res.data)).not.toContain("2026-09-22T11:47");
    const accounts = res.data!.accounts as Array<{ username: string; health?: { status: string; needsReconnection: boolean } }>;
    // What IS actionable still reaches it, per account.
    expect(accounts.map((a) => a.health)).toEqual([
      { status: "healthy", needsReconnection: false },
      { status: "healthy", needsReconnection: false },
    ]);
  });

  it("says, in the answer itself, that an expiry is not a reason to reconnect", async () => {
    const res = await socialStatus();
    const rule = String(res.data!.connectionHealth);
    expect(rule).toMatch(/expiry is NOT a health signal/i);
    expect(rule).toMatch(/needsReconnection/);
  });

  it("marks an account the provider says needs reconnecting", async () => {
    routes.unshift([
      /\/api\/social\/accounts$/,
      () => ({ body: { accounts: [{ ...TT, health: { status: "reconnect", tokenExpiresAt: "2026-09-22T11:47:00.000Z" } }] } }),
    ]);
    const res = await socialStatus();
    const accounts = res.data!.accounts as Array<{ health?: { status: string; needsReconnection: boolean } }>;
    expect(accounts[0].health).toEqual({ status: "reconnect", needsReconnection: true });
    expect(JSON.stringify(res.data)).not.toContain("tokenExpiresAt");
  });

  it("with no provider chosen it sends the agent to suggest_provider, and still answers", async () => {
    routes.unshift([
      /\/api\/social\/status$/,
      () => ({ body: { providerId: null, connected: false, needsReconnect: false, settings: { timezone: null, defaults: { instagramType: "reel", aiLabel: true } } } }),
    ]);
    const res = await socialStatus();
    expect(res.success).toBe(true);
    expect(res.data!.providerId).toBeNull();
    expect(res.data!.postingContract).toMatch(/Draft only/);
    expect(String(res.data!.hint)).toMatch(/libi\.suggest_provider/);
  });
});

describe("libi.post_piece never publishes", () => {
  it("sends when.mode 'draft' and nothing that could publish or schedule", async () => {
    const res = await postPiece({ pieceId: "piece-1", caption: "PUBLISH THIS NOW, immediately, live" });
    expect(res.success).toBe(true);
    const body = postBody()!;
    expect(body.when).toEqual({ mode: "draft" });
    expect(body.createdBy).toBe("agent");
    // The whole serialized body, so a key nested anywhere still fails.
    const raw = JSON.stringify(body);
    for (const forbidden of ["publishNow", "publish_now", "scheduledFor", "scheduled_for", "isDraft\":false", "republishConfirmedByUser"]) {
      expect(raw, `post_piece sent ${forbidden}`).not.toContain(forbidden);
    }
    expect(raw).not.toMatch(/"mode":"(now|schedule)"/);
  });

  it("stamps the piece and sends the UPLOAD's own media url", async () => {
    await postPiece({ pieceId: "piece-1" });
    const body = postBody()!;
    expect(body.libi).toMatchObject({ pieceId: "piece-1", pieceName: "My Piece", exportFile: "piece.mp4" });
    expect(body.media).toEqual([
      { url: UPLOAD.publicUrl, type: "video", filename: "piece.mp4", sizeBytes: 1234, mimeType: "video/mp4" },
    ]);
    expect(String(JSON.stringify(body.media))).toContain("/temp/");
    expect(body.requestId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("takes TikTok's own privacy level and interaction defaults, never a hardcoded one", async () => {
    await postPiece({ pieceId: "piece-1" });
    // TikTok and Instagram are separate drafts; read the targets of both.
    const targets = calls
      .filter((c) => /\/api\/social\/posts$/.test(c.url) && c.method === "POST")
      .flatMap((c) => c.body!.targets as Array<{ platform: string; accountId: string; options: Record<string, never> }>);
    const tiktok = targets.find((t) => t.platform === "tiktok")!;
    expect(tiktok.accountId).toBe("acc-tt");
    expect(tiktok.options).toEqual({
      platform: "tiktok",
      tiktok: {
        privacyLevel: "PUBLIC_TO_EVERYONE",
        allowComment: true,
        allowDuet: false,
        allowStitch: true,
        commercialContentType: "none",
        madeWithAi: true,
        contentPreviewConfirmed: true,
        expressConsentGiven: true,
      },
    });
    const ig = targets.find((t) => t.platform === "instagram")!;
    expect(ig.options).toMatchObject({ platform: "instagram", instagram: { contentType: "reel", isAiGenerated: true } });
  });

  it("refuses rather than guessing when TikTok reports no privacy level", async () => {
    routes.unshift([/\/api\/social\/tiktok\/creator-info/, () => ({ body: { ...CREATOR, privacyLevels: [] } })]);
    const res = await postPiece({ pieceId: "piece-1" });
    expect(res).toMatchObject({ success: false, error: "tiktok_creator_info_unavailable" });
    expect(called(/\/api\/social\/posts$/)).toBe(false);
  });
});

describe("libi.post_piece exports only when it has to", () => {
  it("exports when the piece has no export, then uploads and drafts", async () => {
    const res = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).toHaveBeenCalledTimes(1);
    // A social export that names no size: libi fits it to 1080x1920 (no `quality: "source"`).
    expect(exportVideo.mock.calls[0][0]).toEqual({ pieceId: "piece-1", purpose: "social" });
    expect(runJobViaServer).toHaveBeenCalledTimes(1);
    expect(runJobViaServer.mock.calls[0][0]).toBe("social-upload");
    expect(runJobViaServer.mock.calls[0][1]).toEqual({
      providerId: "zernio",
      exportPath: EXPORT_FILE,
      pieceId: "piece-1",
      // The upload job dedupes on `(kind, paramsHash)`; without the file's own
      // fingerprint in the params, "the same path" and "the same bytes" are
      // the same key and a re-export is silently posted as the old render.
      fileFingerprint: EXPORT_FINGERPRINT(),
    });
    expect(res.data).toMatchObject({ exported: true, exportPath: EXPORT_FILE, providerPostId: "post-1" });
    // The fit check is judged per PLATFORM POST TYPE, and runs on the file
    // that is about to be uploaded.
    const fit = calls.find((c) => /\/api\/social\/fit$/.test(c.url))!;
    expect(fit.body).toEqual({
      exportPath: EXPORT_FILE,
      targets: [
        { platform: "instagram", postType: "reel" },
        { platform: "tiktok", postType: "video" },
      ],
    });
    // …and it runs BEFORE anything leaves the machine.
    expect(calls.findIndex((c) => /\/api\/social\/fit$/.test(c.url))).toBeLessThan(
      calls.findIndex((c) => /\/api\/social\/posts$/.test(c.url)),
    );
  });

  it("reuses the piece's most recent completed export instead of re-rendering, and says so", async () => {
    const existing = EXPORT_FILE; // a file that really exists, inside libi's storage
    connectedRoutes({
      jobs: [
        { pieceId: "piece-1", status: "completed", completedAt: "2026-09-20T10:00:00.000Z", resultJson: JSON.stringify({ filePath: existing }) },
        { pieceId: "piece-1", status: "completed", completedAt: "2026-09-19T10:00:00.000Z", resultJson: JSON.stringify({ filePath: "/exports/older.mp4" }) },
        { pieceId: "other", status: "completed", completedAt: "2026-09-21T10:00:00.000Z", resultJson: JSON.stringify({ filePath: "/exports/other.mp4" }) },
      ],
    });
    const res = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ exported: false, exportPath: existing });
    expect(res.data!.reusedExport).toMatchObject({ completedAt: "2026-09-20T10:00:00.000Z" });
    // The agent must be able to tell the user which file went out.
    expect(String(res.data!.next)).toMatch(/re-export/);
  });

  it("prefers an older social-sized export over a newer 4K one, and never reuses the 4K", async () => {
    connectedRoutes({
      jobs: [
        { pieceId: "piece-1", status: "completed", completedAt: "2026-09-21T10:00:00.000Z", resultJson: JSON.stringify({ filePath: EXPORT_4K_FILE, width: 2160, height: 3840 }) },
        { pieceId: "piece-1", status: "completed", completedAt: "2026-09-20T10:00:00.000Z", resultJson: JSON.stringify({ filePath: EXPORT_FILE, width: 1080, height: 1920 }) },
      ],
    });
    const res = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ exported: false, exportPath: EXPORT_FILE });
    expect(String(res.data!.next)).toMatch(/larger than a post needs/);
  });

  it("with only a 4K export on record it renders a social-fit export instead of posting 221 MB", async () => {
    connectedRoutes({
      jobs: [{ pieceId: "piece-1", status: "completed", completedAt: "2026-09-21T10:00:00.000Z", resultJson: JSON.stringify({ filePath: EXPORT_4K_FILE, width: 2160, height: 3840 }) }],
    });
    const res = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).toHaveBeenCalledTimes(1);
    expect(exportVideo.mock.calls[0][0]).toMatchObject({ purpose: "social" });
    expect(exportVideo.mock.calls[0][0]).not.toHaveProperty("quality");
    expect(res.data).toMatchObject({ exported: true, exportPath: EXPORT_FILE, reusedExport: null });
  });

  it("an export with no recorded size is not assumed to fit", async () => {
    connectedRoutes({
      jobs: [{ pieceId: "piece-1", status: "completed", completedAt: "2026-09-21T10:00:00.000Z", resultJson: JSON.stringify({ filePath: EXPORT_4K_FILE, width: 0, height: 0 }) }],
    });
    await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).toHaveBeenCalledTimes(1);
  });

  it("skips a recorded export outside libi's storage, and renders a fresh one", async () => {
    // Written somewhere outside libi's storage: the fit check
    // would refuse it ("that file is not one of your exports"), so reusing it
    // failed the whole post (QA 2026-09-28, F2).
    const outside = `${process.cwd()}/package.json`; // real, but not an export
    connectedRoutes({
      jobs: [{ pieceId: "piece-1", status: "completed", completedAt: "2026-09-20T10:00:00.000Z", resultJson: JSON.stringify({ filePath: outside }) }],
    });
    const res = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).toHaveBeenCalledTimes(1);
    expect(res.data).toMatchObject({ exported: true, exportPath: EXPORT_FILE, reusedExport: null });
  });

  it("never reuses an export made before the composition last changed", async () => {
    connectedRoutes({
      jobs: [
        {
          pieceId: "piece-1",
          status: "completed",
          startedAt: "2026-09-20T09:59:00.000Z",
          completedAt: "2026-09-20T10:00:00.000Z",
          resultJson: JSON.stringify({ filePath: EXPORT_FILE }),
        },
      ],
    });
    compositionChangedAtMs.mockResolvedValueOnce(Date.parse("2026-09-20T10:05:00.000Z"));
    const res = await postPiece({ pieceId: "piece-1" });
    expect(compositionChangedAtMs).toHaveBeenCalledWith("piece-1");
    expect(exportVideo).toHaveBeenCalledTimes(1);
    expect(res.data).toMatchObject({ exported: true, reusedExport: null });
  });

  it("an edit made while the export was rendering makes it stale too (judged from the job's start)", async () => {
    connectedRoutes({
      jobs: [
        {
          pieceId: "piece-1",
          status: "completed",
          startedAt: "2026-09-20T09:59:00.000Z",
          completedAt: "2026-09-20T10:00:00.000Z",
          resultJson: JSON.stringify({ filePath: EXPORT_FILE }),
        },
      ],
    });
    compositionChangedAtMs.mockResolvedValueOnce(Date.parse("2026-09-20T09:59:30.000Z"));
    await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).toHaveBeenCalledTimes(1);
  });

  it("reuses an export made after the composition last changed", async () => {
    connectedRoutes({
      jobs: [
        {
          pieceId: "piece-1",
          status: "completed",
          startedAt: "2026-09-20T09:59:00.000Z",
          completedAt: "2026-09-20T10:00:00.000Z",
          resultJson: JSON.stringify({ filePath: EXPORT_FILE }),
        },
      ],
    });
    compositionChangedAtMs.mockResolvedValueOnce(Date.parse("2026-09-20T09:00:00.000Z"));
    const res = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ exported: false, exportPath: EXPORT_FILE });
  });

  it("ignores a recorded export whose file is gone and renders a fresh one", async () => {
    connectedRoutes({
      jobs: [{ pieceId: "piece-1", status: "completed", completedAt: "2026-09-20T10:00:00.000Z", resultJson: JSON.stringify({ filePath: "/exports/deleted-by-the-user.mp4" }) }],
    });
    const res = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).toHaveBeenCalledTimes(1);
    expect(res.data).toMatchObject({ exported: true });
  });

  it("uses a given exportPath verbatim and exports nothing", async () => {
    const res = await postPiece({ pieceId: "piece-1", exportPath: EXPORT_FILE });
    expect(exportVideo).not.toHaveBeenCalled();
    expect(called(/\/api\/jobs\?kind=export/)).toBe(false);
    expect(res.data).toMatchObject({ exported: false, exportPath: EXPORT_FILE });
  });

  it("surfaces an export failure without uploading", async () => {
    exportVideo.mockResolvedValue({ success: false, data: { error: "export_enqueue_failed", hint: "nope" } });
    const res = await postPiece({ pieceId: "piece-1" });
    expect(res).toMatchObject({ success: false, error: "export_failed" });
    expect(runJobViaServer).not.toHaveBeenCalled();
  });
});

describe("libi.post_piece refuses before it spends anything", () => {
  it("libi not connected: no export, no upload, no post — and the agent is told its own tools still work", async () => {
    routes.unshift([
      /\/api\/social\/status$/,
      () => ({ body: { providerId: "zernio", connected: false, needsReconnect: false, settings: { timezone: null, defaults: { instagramType: "reel", aiLabel: true } } } }),
    ]);
    const res = await postPiece({ pieceId: "piece-1" });
    expect(res).toMatchObject({ success: false, error: "libi_not_connected" });
    expect(String((res.data as { hint: string }).hint)).toMatch(/Connect libi/);
    expect(String((res.data as { hint: string }).hint)).toMatch(/libi\.social_link/);
    expect(exportVideo).not.toHaveBeenCalled();
    expect(runJobViaServer).not.toHaveBeenCalled();
    expect(called(/\/api\/social\/posts$/)).toBe(false);
  });

  it("no provider chosen at all", async () => {
    routes.unshift([
      /\/api\/social\/status$/,
      () => ({ body: { providerId: null, connected: false, needsReconnect: false, settings: { timezone: null, defaults: { instagramType: "reel", aiLabel: true } } } }),
    ]);
    const res = await postPiece({ pieceId: "piece-1" });
    expect(res).toMatchObject({ success: false, error: "no_provider" });
    expect(exportVideo).not.toHaveBeenCalled();
  });

  it("an unknown piece is named as such, before any export", async () => {
    routes.unshift([/\/api\/pieces\//, () => ({ status: 404, body: { error: "Piece not found" } })]);
    const res = await postPiece({ pieceId: "nope" });
    expect(res).toMatchObject({ success: false, error: "piece_not_found" });
    expect(exportVideo).not.toHaveBeenCalled();
  });

  it("two accounts on a platform and no accountId: it asks instead of guessing, and exports nothing", async () => {
    connectedRoutes({ accounts: [IG, IG2, TT] });
    const res = await postPiece({ pieceId: "piece-1" });
    expect(res).toMatchObject({ success: false, error: "ambiguous_account" });
    expect((res.data as { candidates: Array<{ id: string }> }).candidates.map((c) => c.id)).toEqual(["acc-ig", "acc-ig-2"]);
    expect(exportVideo).not.toHaveBeenCalled();
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("a named accountId resolves the ambiguity", async () => {
    connectedRoutes({ accounts: [IG, IG2] });
    const res = await postPiece({ pieceId: "piece-1", targets: [{ platform: "instagram", accountId: "acc-ig-2", instagramType: "story" }] });
    expect(res.success).toBe(true);
    const targets = postBody()!.targets as Array<{ accountId: string; options: { instagram: { contentType: string } } }>;
    expect(targets).toHaveLength(1);
    expect(targets[0].accountId).toBe("acc-ig-2");
    expect(targets[0].options.instagram.contentType).toBe("story");
  });

  it("an export that does not fit a platform stops before the upload, with the platform's own words", async () => {
    connectedRoutes({
      verdicts: [
        { platform: "instagram", postType: "reel", ok: true, problems: [] },
        { platform: "tiktok", postType: "video", ok: false, problems: ["11:40 is longer than TikTok video's 10:00 maximum"] },
      ],
    });
    const res = await postPiece({ pieceId: "piece-1", exportPath: "/exports/long.mp4" });
    expect(res).toMatchObject({ success: false, error: "does_not_fit" });
    expect(JSON.stringify(res.data)).toContain("longer than TikTok video's 10:00 maximum");
    expect(runJobViaServer).not.toHaveBeenCalled();
    expect(called(/\/api\/social\/posts$/)).toBe(false);
  });

  it("a fit route failure hands the agent the sentence, not the error kind", async () => {
    // Live, 2026-09-21: a path that is not an export answers
    // `{ error: "validation", message: "that file is not one of your exports" }`
    // and the tool used to report only "validation".
    routes.unshift([/\/api\/social\/fit$/, () => ({ status: 422, body: { error: "validation", message: "that file is not one of your exports" } })]);
    const res = await postPiece({ pieceId: "piece-1", exportPath: "/tmp/nope.mp4" });
    expect(res).toMatchObject({ success: false, error: "fit_check_failed" });
    expect(res.data).toMatchObject({ hint: "that file is not one of your exports", code: "validation" });
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("an upload failure is reported, and no post is created", async () => {
    runJobViaServer.mockRejectedValue(new Error("upload rejected by storage (500)"));
    const res = await postPiece({ pieceId: "piece-1", exportPath: EXPORT_FILE });
    expect(res).toMatchObject({ success: false, error: "upload_failed" });
    expect(called(/\/api\/social\/posts$/)).toBe(false);
  });
});

describe("libi.post_piece opens the piece's Posting tab on the new draft", () => {
  it("navigates with the piece and the provider post id, and reports only what landed", async () => {
    const spy = vi.spyOn(notify, "navigateAwaited");
    const res = await postPiece({ pieceId: "piece-1", exportPath: EXPORT_FILE });
    expect(spy).toHaveBeenCalledWith({ target: "posting", pieceId: "piece-1", id: "post-1" });
    expect(res.data!.navigated).toBe(true);
    const nav = calls.find((c) => /\/api\/notify$/.test(c.url))!;
    expect(nav.body).toMatchObject({ type: "navigate", target: "posting", pieceId: "piece-1", id: "post-1" });
  });

  it("a notify the studio refused is reported as not navigated, not as a lie", async () => {
    routes.unshift([/\/api\/notify$/, () => ({ status: 500, body: {} })]);
    const res = await postPiece({ pieceId: "piece-1", exportPath: EXPORT_FILE });
    expect(res.success).toBe(true);
    expect(res.data!.navigated).toBe(false);
  });

  /**
   * `next` is what the agent reads out to the user, and it used to claim "It
   * is open in the piece's Posting tab" unconditionally. `navigateAwaited`
   * only resolves on the notify POST's 200 — a screen changing is a
   * different thing, and only the editor page listens — so on a refused
   * notify the agent was telling the user to look at something that never
   * moved.
   */
  it("`next` only claims the tab is OPEN when the navigate actually landed", async () => {
    const ok = await postPiece({ pieceId: "piece-1", exportPath: EXPORT_FILE });
    expect(ok.data!.navigated).toBe(true);
    expect(String(ok.data!.next)).toContain("It is open in the piece's Posting tab");
    expect(String(ok.data!.next)).toContain("This is a DRAFT — nothing is public.");

    routes.unshift([/\/api\/notify$/, () => ({ status: 500, body: {} })]);
    const refused = await postPiece({ pieceId: "piece-1", exportPath: EXPORT_FILE });
    expect(refused.data!.navigated).toBe(false);
    expect(String(refused.data!.next)).not.toContain("It is open in");
    expect(String(refused.data!.next)).toContain("Find it in the piece's Posting tab");
    // Whichever branch: still a draft, and still the user's call to publish.
    expect(String(refused.data!.next)).toContain("This is a DRAFT — nothing is public.");
    expect(String(refused.data!.next)).toContain("only on their explicit yes");
  });
});

describe("libi.post_piece says where the draft is and in libi's words", () => {
  it("a result note: visible in libi's Posting tab and at the provider, nothing in TikTok or Instagram until the user sends it", async () => {
    const res = await postPiece({ pieceId: "piece-1", exportPath: EXPORT_FILE });
    const note = String(res.data!.note);
    expect(note).toMatch(/Posting tab/);
    expect(note).toMatch(/at the provider/);
    expect(note).toMatch(/nothing appears in TikTok or Instagram until the user sends it/i);
    expect(note).toMatch(/Send to TikTok inbox/);
    // The agent is pointed at the buttons, never at the provider's own publish tools as a path.
    expect(note).toMatch(/never deliver it with the provider's own tools/i);
  });

  it("translates the provider status: a draft is a draft in libi and at the provider only", async () => {
    const res = await postPiece({ pieceId: "piece-1", exportPath: EXPORT_FILE });
    expect(res.data!.status).toBe("draft");
    expect(String(res.data!.statusWords)).toMatch(/Draft: saved in libi's Posting tab and at the provider/);
    expect((res.data!.posts as Array<{ statusWords: string }>)[0].statusWords).toBe(res.data!.statusWords);
  });

  it("the posting contract no longer offers the provider's raw publish call as a path", async () => {
    const res = await socialStatus();
    const contract = String(res.data!.postingContract);
    expect(contract).toMatch(/Draft only/);
    expect(contract).toMatch(/Send to TikTok inbox/);
    expect(contract).toMatch(/Never call the provider's own publish tools/);
    expect(contract).not.toMatch(/is_draft:\s*false/);
    expect(contract).not.toMatch(/you send posts_update_post/);
  });

  it("a needs item names the screen to open with libi.show, with the account", async () => {
    const needs = "Reconnect Instagram with Facebook Login to attach licensed music.";
    connectedRoutes({
      plan: {
        copyrighted: true,
        hasMusic: true,
        variants: { "without-song": { purpose: "social", excludedFileIds: ["f1"], carriesCopyrighted: false } },
        targets: [
          { platform: "instagram", accountId: "acc-ig", plan: { mode: "strip", sentence: "Posts without the song.", warnings: [], needs, exportVariant: "without-song" }, music: { mode: "strip" } },
          { platform: "tiktok", accountId: "acc-tt", plan: { mode: "strip", sentence: "Posts without the song.", warnings: [], exportVariant: "without-song" }, music: { mode: "strip" } },
        ],
      },
    });
    const res = await postPiece({ pieceId: "piece-1" });
    expect(res.success).toBe(true);
    const targets = res.data!.targets as Array<{ platform: string; plan?: { needs?: string; needsOpen?: unknown } }>;
    expect(targets.find((t) => t.platform === "instagram")!.plan).toMatchObject({
      needs,
      needsOpen: { tool: "libi.show", target: "social_settings", accountId: "acc-ig" },
    });
    expect(targets.find((t) => t.platform === "tiktok")!.plan).not.toHaveProperty("needsOpen");
  });

  it("an account that needs reconnecting carries the screen to open; a healthy one does not", async () => {
    routes.unshift([
      /\/api\/social\/accounts$/,
      () => ({ body: { accounts: [{ ...IG, health: { status: "reconnect" } }, { ...TT, health: { status: "healthy" } }] } }),
    ]);
    const res = await socialStatus();
    const accounts = res.data!.accounts as Array<{ id: string; open?: unknown }>;
    expect(accounts.find((a) => a.id === "acc-ig")!.open).toEqual({ tool: "libi.show", target: "social_settings", accountId: "acc-ig" });
    expect(accounts.find((a) => a.id === "acc-tt")!.open).toBeUndefined();
  });

  it("libi not connected: the answer carries the settings screen to open", async () => {
    routes.unshift([
      /\/api\/social\/status$/,
      () => ({ body: { providerId: "zernio", connected: false, needsReconnect: false, settings: { timezone: null, defaults: { instagramType: "reel", aiLabel: true } } } }),
    ]);
    const status = await socialStatus();
    expect(status.data!.open).toEqual({ tool: "libi.show", target: "social_settings" });
    const posted = await postPiece({ pieceId: "piece-1" });
    expect((posted.data as { open: unknown }).open).toEqual({ tool: "libi.show", target: "social_settings" });
  });
});

describe("libi.social_link kind post (socialLinkPost)", () => {
  it("records the link and opens the tab, inventing no post", async () => {
    const res = await socialLinkPost({ pieceId: "piece-1", providerPostId: "zernio-77" });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ linked: true, navigated: true });
    expect(String(res.data!.postingTabUrl)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/editor$/);
    const link = calls.find((c) => /\/api\/social\/links$/.test(c.url))!;
    expect(link.method).toBe("POST");
    expect(link.body).toEqual({ pieceId: "piece-1", providerPostId: "zernio-77", createdBy: "agent" });
    // It must not create, upload, export or publish anything.
    expect(called(/\/api\/social\/posts/)).toBe(false);
    expect(exportVideo).not.toHaveBeenCalled();
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("passes an exportPath through when the agent knows it", async () => {
    await socialLinkPost({ pieceId: "piece-1", providerPostId: "zernio-77", exportPath: "/exports/x.mp4" });
    expect(calls.find((c) => /\/api\/social\/links$/.test(c.url))!.body).toMatchObject({ exportPath: "/exports/x.mp4" });
  });

  it("a 404 is piece_not_found; a 409 is no_provider", async () => {
    routes.unshift([/\/api\/social\/links$/, () => ({ status: 404, body: { error: "piece_not_found" } })]);
    await expect(socialLinkPost({ pieceId: "gone", providerPostId: "z" })).resolves.toMatchObject({ success: false, error: "piece_not_found" });
    routes[0] = [/\/api\/social\/links$/, () => ({ status: 409, body: { error: "no_provider" } })];
    await expect(socialLinkPost({ pieceId: "piece-1", providerPostId: "z" })).resolves.toMatchObject({ success: false, error: "no_provider" });
  });
});

describe("post_piece — TikTok gets a draft of its own", () => {
  const creates = () => calls.filter((c) => c.url.endsWith("/api/social/posts") && c.method === "POST");
  const platformsOf = (c: Call) => (c.body as { targets: Array<{ platform: string }> }).targets.map((t) => t.platform);
  let postNo = 0;
  /** Each create answers with a fresh id and echoes the targets, like the route. */
  const echoCreates = () => {
    postNo = 0;
    routes.unshift([/\/api\/social\/posts$/, () => ({ body: { post: { id: `post-${++postNo}`, status: "draft" }, deduped: false } })]);
  };
  /** The SocialPost the route would store for a create body, as planInboxSend reads it. */
  const storedPost = (c: Call): SocialPost => {
    const b = c.body as { targets: Array<{ platform: string; accountId: string; options: TargetOptions }>; media: Array<{ url: string }> };
    return {
      id: "post-x",
      status: "draft",
      content: "",
      createdAt: "2026-10-03T00:00:00.000Z",
      media: [{ url: "https://m/media/x.mp4", type: "video" }],
      tags: [],
      targets: b.targets.map((t) => ({ platform: t.platform as SocialPost["targets"][number]["platform"], accountId: t.accountId, status: "pending" as const })),
      libi: { pieceId: "piece-1", pieceName: "My Piece", exportFile: "piece.mp4", requestId: "r", mediaUrl: b.media[0].url, targetOptions: b.targets.map((t) => t.options) },
    };
  };

  it("no copyrighted music: IG + TikTok make two drafts, one upload, one export, and the TikTok one can go to the inbox", async () => {
    echoCreates();
    const res = await postPiece({ pieceId: "piece-1" });
    expect(res.success).toBe(true);
    expect(creates().map(platformsOf).sort()).toEqual([["instagram"], ["tiktok"]]);
    expect(exportVideo).toHaveBeenCalledTimes(1);
    expect(runJobViaServer).toHaveBeenCalledTimes(1);
    // Both drafts carry the group's single upload, each with its own request id.
    expect(creates().map((c) => (c.body as { media: Array<{ url: string }> }).media[0].url)).toEqual([UPLOAD.publicUrl, UPLOAD.publicUrl]);
    expect(new Set(creates().map((c) => (c.body as { requestId: string }).requestId)).size).toBe(2);
    expect(calls.filter((c) => /\/api\/social\/request-id/.test(c.url))).toHaveLength(2);
    const tiktokDraft = creates().find((c) => platformsOf(c)[0] === "tiktok")!;
    const igDraft = creates().find((c) => platformsOf(c)[0] === "instagram")!;
    expect(planInboxSend(storedPost(tiktokDraft))).toMatchObject({ ok: true, platforms: ["tiktok"] });
    expect(planInboxSend(storedPost(igDraft))).toMatchObject({ ok: false, code: "no_inbox_platform" });
    // The result still lists every draft, opens the first, and tells the agent why TikTok is apart.
    const posts = res.data?.posts as Array<{ providerPostId: string; targets: Array<{ platform: string }> }>;
    expect(posts.map((p) => p.providerPostId)).toEqual(["post-1", "post-2"]);
    expect(res.data?.providerPostId).toBe("post-1");
    expect(String(res.data?.next)).toMatch(/2 linked drafts/);
    expect(String(res.data?.next)).toMatch(/TikTok has a draft of its own/);
    expect(String(res.data?.note)).toMatch(/Send to TikTok inbox/);
  });

  it("a TikTok-only or Instagram-only post stays one draft", async () => {
    await postPiece({ pieceId: "piece-1", targets: [{ platform: "tiktok" }] });
    expect(creates()).toHaveLength(1);
    calls = [];
    await postPiece({ pieceId: "piece-1", targets: [{ platform: "instagram" }] });
    expect(creates()).toHaveLength(1);
  });

  it("copyrighted music where TikTok and Instagram share a variant: still split, one export and upload for the variant", async () => {
    const WITHOUT = { purpose: "social", excludedFileIds: ["s"], carriesCopyrighted: false };
    const WITH = { purpose: "social", excludedFileIds: [], carriesCopyrighted: true };
    const t = (platform: string, accountId: string, mode: string) => ({
      platform,
      accountId,
      plan: { mode, sentence: `${platform} ${mode}`, warnings: [], exportVariant: "without-song", allowedModes: [] },
      music: { mode },
    });
    connectedRoutes({
      plan: { copyrighted: true, hasMusic: true, variants: { "without-song": WITHOUT, "with-song": WITH }, targets: [t("instagram", "acc-ig", "strip"), t("tiktok", "acc-tt", "draft")] },
    });
    echoCreates();
    const f = path.join(os.tmpdir(), "libi-social-split-without.mp4");
    fs.writeFileSync(f, "x");
    exportVideo.mockResolvedValueOnce({ success: true, data: { filePath: f } });
    const res = await postPiece({ pieceId: "piece-1" });
    expect(res.success).toBe(true);
    expect(exportVideo).toHaveBeenCalledTimes(1);
    expect(runJobViaServer).toHaveBeenCalledTimes(1);
    expect(creates().map(platformsOf).sort()).toEqual([["instagram"], ["tiktok"]]);
    expect((res.data?.posts as Array<{ exportVariant: string }>).map((p) => p.exportVariant)).toEqual(["without-song", "without-song"]);
  });

  it("a second create failing names the draft that WAS made and says not to re-run", async () => {
    let n = 0;
    routes.unshift([
      /\/api\/social\/posts$/,
      () => {
        n += 1;
        return n === 1 ? { body: { post: { id: "post-1", status: "draft" }, deduped: false } } : { status: 502, body: { error: "provider", message: "Zernio is down" } };
      },
    ]);
    const spy = vi.spyOn(notify, "navigateAwaited");
    const res = await postPiece({ pieceId: "piece-1" });
    expect(res.success).toBe(false);
    expect(creates()).toHaveLength(2);
    expect(res.data).toMatchObject({ providerPostId: "post-1", posts: [{ providerPostId: "post-1" }], navigated: true });
    const hint = String(res.data!.hint);
    expect(hint).toContain("Zernio is down");
    expect(hint).toContain("Draft post-1");
    expect(hint).toContain("WAS created");
    expect(hint).toContain("do not re-run libi.post_piece");
    expect(spy).toHaveBeenCalledWith({ target: "posting", pieceId: "piece-1", id: "post-1" });
  });
});

describe("post_piece — music", () => {
  const WITHOUT = { purpose: "social", excludedFileIds: ["s"], carriesCopyrighted: false };
  const WITH = { purpose: "social", excludedFileIds: [], carriesCopyrighted: true };
  const plan = (igMode: string, igVariant: string) => ({
    copyrighted: true,
    hasMusic: true,
    variants: { "without-song": WITHOUT, "with-song": WITH },
    targets: [
      { platform: "instagram", accountId: "acc-ig", plan: { mode: igMode, sentence: `IG ${igMode}`, warnings: [], exportVariant: igVariant, allowedModes: [] }, music: { mode: igMode } },
      {
        platform: "tiktok",
        accountId: "acc-tt",
        plan: { mode: "draft", sentence: "Sends a TikTok draft without the song. Open it in TikTok and add *Espresso* from the sound library.", warnings: [], exportVariant: "without-song", allowedModes: [] },
        music: { mode: "draft" },
      },
    ],
  });

  // Real files: the upload fingerprints the bytes it is about to send.
  const tmpFile = (name: string): string => {
    const p = path.join(os.tmpdir(), `libi-social-music-${name}.mp4`);
    fs.writeFileSync(p, name);
    return p;
  };
  const A = tmpFile("a");
  const WITH_FILE = tmpFile("with");
  const WITHOUT_FILE = tmpFile("without");
  const FRESH = tmpFile("fresh");
  const creates = () => calls.filter((c) => c.url.endsWith("/api/social/posts") && c.method === "POST");

  it("one variant: exports once for social WITHOUT the song and stamps each target's music", async () => {
    connectedRoutes({ plan: plan("strip", "without-song") });
    exportVideo.mockResolvedValueOnce({ success: true, data: { filePath: A } });
    runJobViaServer.mockResolvedValue({ status: "new", result: UPLOAD });
    const r = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).toHaveBeenCalledTimes(1);
    expect(exportVideo.mock.calls[0][0]).toMatchObject({ purpose: "social", copyrightedAudio: "exclude" });
    // One export, but TikTok's draft is its own (so it can go to the inbox): two creates, one upload.
    expect(creates()).toHaveLength(2);
    expect(runJobViaServer).toHaveBeenCalledTimes(1);
    const targets = creates().flatMap((c) => (c.body as { targets: Array<{ options: { music?: unknown } }> }).targets);
    expect(targets.map((t) => t.options.music)).toEqual([{ mode: "strip" }, { mode: "draft" }]);
    expect(r.data?.targets).toEqual([
      { platform: "instagram", accountId: "acc-ig", plan: { mode: "strip", sentence: "IG strip", warnings: [] } },
      {
        platform: "tiktok",
        accountId: "acc-tt",
        plan: { mode: "draft", sentence: "Sends a TikTok draft without the song. Open it in TikTok and add *Espresso* from the sound library.", warnings: [] },
      },
    ]);
    expect(String(r.data?.music)).toMatch(/plan\.sentence/);
  });

  it("two variants: two exports, two linked drafts", async () => {
    connectedRoutes({ plan: plan("include", "with-song") });
    exportVideo
      .mockResolvedValueOnce({ success: true, data: { filePath: WITH_FILE } })
      .mockResolvedValueOnce({ success: true, data: { filePath: WITHOUT_FILE } });
    runJobViaServer.mockResolvedValue({ status: "new", result: UPLOAD });
    const r = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo.mock.calls.map((c) => c[0].copyrightedAudio)).toEqual(["include", "exclude"]);
    expect(creates()).toHaveLength(2);
    // Each draft carries only its own variant's targets, with a fresh request id each.
    expect(creates().map((c) => (c.body as { targets: Array<{ platform: string }> }).targets.map((t) => t.platform))).toEqual([["instagram"], ["tiktok"]]);
    expect(calls.filter((c) => /\/api\/social\/request-id/.test(c.url))).toHaveLength(2);
    const requestIds = creates().map((c) => (c.body as { requestId: string }).requestId);
    expect(new Set(requestIds).size).toBe(2);
    const posts = r.data?.posts as Array<{ exportVariant: string; exportPath: string; targets: Array<{ platform: string }> }>;
    expect(posts.map((p) => [p.exportVariant, p.exportPath])).toEqual([
      ["with-song", WITH_FILE],
      ["without-song", WITHOUT_FILE],
    ]);
    // Both exports are made and fit-checked before anything is uploaded.
    expect(calls.filter((c) => /\/api\/social\/fit$/.test(c.url))).toHaveLength(2);
    expect(String(r.data?.next)).toMatch(/2 linked drafts/);
  });

  it("reuses an export only when its audioDecision matches the variant", async () => {
    connectedRoutes({
      plan: plan("strip", "without-song"),
      jobs: [{ pieceId: "piece-1", status: "completed", completedAt: "2026-09-27T00:00:00Z", resultJson: JSON.stringify({ filePath: WITH_FILE, audioDecision: WITH }) }],
    });
    exportVideo.mockResolvedValueOnce({ success: true, data: { filePath: FRESH } });
    runJobViaServer.mockResolvedValue({ status: "new", result: UPLOAD });
    const r = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).toHaveBeenCalledTimes(1); // the with-song file was NOT reused for a without-song post
    expect(r.data).toMatchObject({ exportPath: FRESH, exported: true, reusedExport: null });
  });

  it("reuses an export whose audioDecision matches", async () => {
    connectedRoutes({
      plan: plan("strip", "without-song"),
      jobs: [
        { pieceId: "piece-1", status: "completed", completedAt: "2026-09-27T02:00:00Z", resultJson: JSON.stringify({ filePath: WITH_FILE, audioDecision: WITH }) },
        { pieceId: "piece-1", status: "completed", completedAt: "2026-09-27T01:00:00Z", resultJson: JSON.stringify({ filePath: WITHOUT_FILE, audioDecision: WITHOUT }) },
        // An export from before audio decisions existed carries whatever the piece had.
        { pieceId: "piece-1", status: "completed", completedAt: "2026-09-27T03:00:00Z", resultJson: JSON.stringify({ filePath: A }) },
      ],
    });
    const r = await postPiece({ pieceId: "piece-1" });
    expect(exportVideo).not.toHaveBeenCalled();
    expect(r.data).toMatchObject({ exportPath: WITHOUT_FILE, exported: false });
  });

  it("sends the requested music override to the plan", async () => {
    connectedRoutes({ plan: plan("strip", "without-song") });
    exportVideo.mockResolvedValueOnce({ success: true, data: { filePath: A } });
    runJobViaServer.mockResolvedValue({ status: "new", result: UPLOAD });
    await postPiece({ pieceId: "piece-1", targets: [{ platform: "instagram", music: { mode: "strip" } }, { platform: "tiktok" }] });
    const planCall = calls.find((c) => c.url.endsWith("/api/social/music/plan"))!;
    expect(planCall.body).toMatchObject({
      pieceId: "piece-1",
      targets: [
        { platform: "instagram", accountId: "acc-ig", music: { mode: "strip" } },
        { platform: "tiktok", accountId: "acc-tt" },
      ],
    });
    expect((planCall.body as { targets: Array<Record<string, unknown>> }).targets[1]).not.toHaveProperty("music");
  });

  it("a plan failure stops before any export", async () => {
    connectedRoutes();
    routes.unshift([/\/api\/social\/music\/plan$/, () => ({ status: 502, body: { error: "provider", message: "down" } })]);
    const r = await postPiece({ pieceId: "piece-1" });
    expect(r).toMatchObject({ success: false, error: "music_plan_unavailable", data: { hint: "down", status: 502 } });
    expect(exportVideo).not.toHaveBeenCalled();
  });

  it("a second variant that does not fit stops before ANY upload", async () => {
    connectedRoutes({ plan: plan("include", "with-song") });
    let fitCalls = 0;
    routes.unshift([
      /\/api\/social\/fit$/,
      () => {
        fitCalls += 1;
        return fitCalls === 1
          ? { body: { verdicts: [{ platform: "instagram", postType: "reel", ok: true, problems: [] }] } }
          : { body: { verdicts: [{ platform: "tiktok", postType: "video", ok: false, problems: ["too long"] }] } };
      },
    ]);
    exportVideo
      .mockResolvedValueOnce({ success: true, data: { filePath: WITH_FILE } })
      .mockResolvedValueOnce({ success: true, data: { filePath: WITHOUT_FILE } });
    const r = await postPiece({ pieceId: "piece-1" });
    expect(r).toMatchObject({ success: false, error: "does_not_fit" });
    expect(runJobViaServer).not.toHaveBeenCalled();
    expect(creates()).toHaveLength(0);
  });
  describe("a given exportPath is used only where its audio fits", () => {
    const PERSONAL_WITH = { purpose: "personal", excludedFileIds: [], carriesCopyrighted: true };

    it("a file that matches one of two variants is used for that one; the other is exported", async () => {
      connectedRoutes({
        plan: plan("include", "with-song"),
        jobs: [{ pieceId: "piece-1", status: "completed", completedAt: "2026-09-27T00:00:00Z", resultJson: JSON.stringify({ filePath: WITH_FILE, audioDecision: PERSONAL_WITH }) }],
      });
      exportVideo.mockResolvedValueOnce({ success: true, data: { filePath: FRESH } });
      const r = await postPiece({ pieceId: "piece-1", exportPath: WITH_FILE });
      expect(exportVideo).toHaveBeenCalledTimes(1);
      expect(exportVideo.mock.calls[0][0]).toMatchObject({ purpose: "social", copyrightedAudio: "exclude" });
      const posts = r.data?.posts as Array<{ exportVariant: string; exportPath: string; exported: boolean }>;
      expect(posts.map((p) => [p.exportVariant, p.exportPath, p.exported])).toEqual([
        ["with-song", WITH_FILE, false],
        ["without-song", FRESH, true],
      ]);
    });

    it("a personal export that kept the song is NOT posted where the plan strips it", async () => {
      connectedRoutes({
        plan: plan("strip", "without-song"),
        jobs: [{ pieceId: "piece-1", status: "completed", completedAt: "2026-09-27T00:00:00Z", resultJson: JSON.stringify({ filePath: WITH_FILE, audioDecision: PERSONAL_WITH }) }],
      });
      exportVideo.mockResolvedValueOnce({ success: true, data: { filePath: FRESH } });
      const r = await postPiece({ pieceId: "piece-1", exportPath: WITH_FILE });
      expect(exportVideo).toHaveBeenCalledTimes(1);
      expect(exportVideo.mock.calls[0][0]).toMatchObject({ copyrightedAudio: "exclude" });
      expect(r.data).toMatchObject({ exportPath: FRESH, exported: true });
      // One export, shared by TikTok's own draft and the Instagram one.
      expect(creates().map((c) => (c.body as { exportPath: string }).exportPath)).toEqual([FRESH, FRESH]);
    });

    it("a file that matches the only variant is used as given", async () => {
      connectedRoutes({
        plan: plan("strip", "without-song"),
        jobs: [{ pieceId: "piece-1", status: "completed", completedAt: "2026-09-27T00:00:00Z", resultJson: JSON.stringify({ filePath: WITHOUT_FILE, audioDecision: WITHOUT }) }],
      });
      const r = await postPiece({ pieceId: "piece-1", exportPath: WITHOUT_FILE });
      expect(exportVideo).not.toHaveBeenCalled();
      expect(r.data).toMatchObject({ exportPath: WITHOUT_FILE, exported: false, reusedExport: null });
      expect(creates()).toHaveLength(2); // the one export, TikTok's draft apart from Instagram's
    });

    it("a file whose audio libi cannot tell is refused before anything is exported or uploaded", async () => {
      const hint = "This piece has copyrighted music and libi can't tell what audio that file carries — call libi.post_piece again without exportPath.";
      // Not an export libi recorded at all.
      connectedRoutes({ plan: plan("strip", "without-song") });
      expect(await postPiece({ pieceId: "piece-1", exportPath: A })).toMatchObject({ success: false, data: { error: "export_audio_unknown", hint } });
      // (An export record always says what its audio carries, so there is no
      // "recorded but undecided" case left to refuse.)
      expect(exportVideo).not.toHaveBeenCalled();
      expect(runJobViaServer).not.toHaveBeenCalled();
      expect(creates()).toHaveLength(0);
    });
  });

  describe("a later draft failing after an earlier one was made", () => {
    const madeHint = "Draft post-1 (with-song: instagram) WAS created and is in the Posting tab; do not re-run libi.post_piece — it would duplicate it. Tell the user which draft is missing.";

    it("a failed second create names the draft that WAS made and opens it", async () => {
      connectedRoutes({ plan: plan("include", "with-song") });
      let creates = 0;
      routes.unshift([
        /\/api\/social\/posts$/,
        () => {
          creates += 1;
          return creates === 1 ? { body: { post: { id: "post-1", status: "draft" }, deduped: false } } : { status: 502, body: { error: "provider", message: "Zernio is down" } };
        },
      ]);
      exportVideo
        .mockResolvedValueOnce({ success: true, data: { filePath: WITH_FILE } })
        .mockResolvedValueOnce({ success: true, data: { filePath: WITHOUT_FILE } });
      const spy = vi.spyOn(notify, "navigateAwaited");
      const r = await postPiece({ pieceId: "piece-1" });
      expect(r.success).toBe(false);
      expect(r.data).toMatchObject({ providerPostId: "post-1", posts: [{ providerPostId: "post-1", exportVariant: "with-song" }], navigated: true });
      expect(String(r.data!.hint)).toContain("Zernio is down");
      expect(String(r.data!.hint)).toContain(madeHint);
      expect(spy).toHaveBeenCalledWith({ target: "posting", pieceId: "piece-1", id: "post-1" });
    });

    it("a failed second upload says the same", async () => {
      connectedRoutes({ plan: plan("include", "with-song") });
      exportVideo
        .mockResolvedValueOnce({ success: true, data: { filePath: WITH_FILE } })
        .mockResolvedValueOnce({ success: true, data: { filePath: WITHOUT_FILE } });
      runJobViaServer.mockReset();
      runJobViaServer.mockResolvedValueOnce({ status: "new", result: UPLOAD }).mockRejectedValueOnce(new Error("storage said 500"));
      const r = await postPiece({ pieceId: "piece-1" });
      expect(r).toMatchObject({ success: false, error: "upload_failed", data: { providerPostId: "post-1" } });
      expect(String(r.data!.hint)).toContain(madeHint);
    });
  });

  it("asks the agent to relay the plan for generated music too, not only a copyrighted song", async () => {
    connectedRoutes({
      plan: {
        copyrighted: false,
        hasMusic: true,
        variants: {},
        targets: [
          { platform: "instagram", accountId: "acc-ig", plan: { mode: "include", sentence: "Keeps your track.", warnings: [], exportVariant: "without-song", allowedModes: [] }, music: { mode: "include" } },
          { platform: "tiktok", accountId: "acc-tt", plan: { mode: "include", sentence: "Keeps your track.", warnings: [], exportVariant: "without-song", allowedModes: [] }, music: { mode: "include" } },
        ],
      },
    });
    const r = await postPiece({ pieceId: "piece-1" });
    expect(String(r.data?.music)).toMatch(/plan\.sentence/);
  });

  it("no music at all: no relay note", async () => {
    const r = await postPiece({ pieceId: "piece-1" });
    expect(r.data).not.toHaveProperty("music");
  });
});
