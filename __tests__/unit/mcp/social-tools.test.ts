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

vi.mock("@/mcp/tools/export-tools", () => ({ exportVideo }));
vi.mock("@/mcp/jobs-client", () => ({
  runJobViaServer,
  LibiServerUnavailableError: class extends Error {},
}));

import { socialStatus, postPiece, socialLinkPost } from "@/mcp/tools/social-tools";
import { notify } from "@/mcp/notify";

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
let routes: Array<[RegExp, () => { status?: number; body: unknown }]> = [];

function respond(url: string): Response {
  const route = routes.find(([re]) => re.test(url));
  const answer = route ? route[1]() : { status: 404, body: { error: "no route in test" } };
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

/** The default happy path: connected, one IG + one TikTok, everything fits. */
function connectedRoutes(over: Partial<{ accounts: unknown[]; verdicts: unknown[]; jobs: unknown[] }> = {}) {
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
    [/\/api\/jobs\?kind=export/, () => ({ body: { jobs: over.jobs ?? [] } })],
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
    [/\/api\/social\/request-id/, () => ({ body: { requestId: "11111111-2222-3333-4444-555555555555", source: "fresh" } })],
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

const postBody = () => calls.find((c) => /\/api\/social\/posts$/.test(c.url) && c.method === "POST")?.body ?? null;
const called = (re: RegExp) => calls.some((c) => re.test(c.url));

beforeEach(() => {
  calls = [];
  fetchMock.mockClear();
  exportVideo.mockReset();
  runJobViaServer.mockReset();
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
    expect(String(res.data!.hint)).toMatch(/libi\.social_link_post/);
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
    const targets = postBody()!.targets as Array<{ platform: string; accountId: string; options: Record<string, never> }>;
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
    expect(exportVideo.mock.calls[0][0]).toEqual({ pieceId: "piece-1", quality: "source" });
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
    const existing = `${process.cwd()}/package.json`; // a file that really exists
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
    expect(String((res.data as { hint: string }).hint)).toMatch(/Connect libi on the Social page/);
    expect(String((res.data as { hint: string }).hint)).toMatch(/libi\.social_link_post/);
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
    expect(String(refused.data!.next)).toContain("publish or schedule only on their explicit yes");
  });
});

describe("libi.social_link_post", () => {
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
