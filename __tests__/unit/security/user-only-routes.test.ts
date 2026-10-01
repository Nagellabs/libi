/**
 * The user-only actions take the browser-only checks
 * (`lib/security/request-guard.ts#browserOnlyRefusal`): answering an approval
 * card, publishing / scheduling / editing / deleting / retrying a social post
 * as the user, connecting or disconnecting the social accounts, and reporting
 * a catalog template — and the two settings that decide whether a card
 * appears at all: the approval mode and an extension's "Require approval" —
 * and the social settings (provider, and the defaults a new post is seeded from, and a TikTok account's type),
 * and restarting a chat (it cancels the chat's running turn). A header-less loopback caller — an agent's own shell
 * running curl — gets `403 { code: "browser_only" }` from each; libi's own
 * page (a same-origin browser fetch) passes and lands in the mocks below.
 *
 * An agent's social DRAFT (`createdBy: "agent"`, the only thing
 * `libi.post_piece` can send) is not a user-only action and still passes.
 *
 * Every mock stands behind the check, so a status other than 403 on a
 * positive control proves the check did not over-refuse, and a 403 on a
 * negative one proves it was the check (the logged `op`) that refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const logSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

const approval = vi.hoisted(() => ({ resolve: vi.fn(), emit: vi.fn(), restart: vi.fn(async () => ({ agentId: "claude-code", processRestarted: false })) }));
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => ({
    getSession: () => ({
      pendingApprovals: new Map([
        ["p1", { pendingId: "p1", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], resolve: approval.resolve, createdAt: 0 }],
      ]),
    }),
    emitForSession: approval.emit,
    applyApprovalModeToActiveSessions: vi.fn(async () => {}),
    restartSession: approval.restart,
  }),
}));
const modes = vi.hoisted(() => ({ setApprovalMode: vi.fn(), getAllApprovalModes: vi.fn(() => ({})) }));
vi.mock("@/lib/approval/settings", () => modes);
// PATCH /api/settings/mcp-servers/:id past the check: an empty table, so it answers 404.
const noRow = { select: () => ({ from: () => ({ where: () => ({ limit: () => ({ all: () => [] }) }) }) }) };
vi.mock("@/lib/db/client", () => ({ getDb: () => noRow }));
vi.mock("@/lib/mcp-config", () => ({ invalidateMcpConfig: vi.fn() }));

vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
const socialSettings = vi.hoisted(() => ({ setSocialSettings: vi.fn() }));
vi.mock("@/lib/db/settings", () => ({ getSocialSettings: () => ({ providerId: "zernio" }), setSocialSettings: socialSettings.setSocialSettings }));
const socialPost = { id: "x", status: "draft" };
const adapter = vi.hoisted(() => ({
  createPost: vi.fn(),
  updatePost: vi.fn(),
  deletePost: vi.fn(),
  retryPost: vi.fn(),
}));
const socialService = vi.hoisted(() => ({ disconnect: vi.fn(), reset: vi.fn() }));
vi.mock("@/lib/social/service", () => ({
  withAdapter: (fn: (a: typeof adapter) => unknown) => fn(adapter),
  getSocialService: () => socialService,
}));
vi.mock("@/lib/social/links", () => ({ insertLink: vi.fn(), touchLinkStatus: vi.fn(), linkForPost: vi.fn(() => null) }));
const oauth = vi.hoisted(() => ({ startSignIn: vi.fn(), disconnect: vi.fn() }));
vi.mock("@/lib/social/oauth/flow", () => oauth);
const cloud = vi.hoisted(() => ({ reportTemplate: vi.fn() }));
vi.mock("@/lib/templates/cloud/client", () => cloud);
const musicFacts = vi.hoisted(() => ({ setUserTikTokKind: vi.fn(() => ({ tiktokKind: { value: "personal", source: "user", checkedAt: "t" } })), resolveAccountFacts: vi.fn() }));
vi.mock("@/lib/social/music-facts", () => musicFacts);
vi.mock("@/lib/audio-rights/write", () => ({
  updateAudioRights: vi.fn(() => ({ ok: true, rights: { class: "owned" }, pieceId: null })),
  OWNED_REFUSAL: "x",
}));

import { POST as permission } from "@/app/api/sessions/[sessionId]/permission/route";
import { POST as createPost } from "@/app/api/social/posts/route";
import { PATCH as patchPost, DELETE as deletePost } from "@/app/api/social/posts/[postId]/route";
import { POST as retryPost } from "@/app/api/social/posts/[postId]/retry/route";
import { POST as oauthStart } from "@/app/api/social/oauth/start/route";
import { POST as oauthDisconnect } from "@/app/api/social/oauth/disconnect/route";
import { POST as report } from "@/app/api/templates/cloud/report/route";
import { PATCH as patchModes } from "@/app/api/sessions/permission-modes/route";
import { POST as restartSession } from "@/app/api/sessions/[sessionId]/restart/route";
import { PATCH as patchMcpServer } from "@/app/api/settings/mcp-servers/[id]/route";
import { PUT as putSocialSettings } from "@/app/api/social/settings/route";
import { PATCH as patchAudioRights } from "@/app/api/files/by-id/[fileId]/audio-rights/route";
import { PUT as putMusicFacts } from "@/app/api/social/music/facts/route";

/** What an agent's shell sends: a loopback Host, a JSON body, nothing a browser adds. */
const CURL = { host: "127.0.0.1:3461", "content-type": "application/json" };
/** libi's own page: a same-origin browser fetch. */
const BROWSER = { ...CURL, origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" };
/** The same page opened at `localhost` — Origin equals its own Host, whichever spelling. */
const BROWSER_LOCALHOST = { host: "localhost:3461", "content-type": "application/json", origin: "http://localhost:3461", "sec-fetch-site": "same-origin" };
/** Near misses a local caller or another page could send — each still refused. */
const NOT_THE_PAGE: Array<[string, Record<string, string>]> = [
  ["no headers at all", CURL],
  ["Sec-Fetch-Site none (typed URL)", { ...BROWSER, "sec-fetch-site": "none" }],
  ["cross-site", { ...BROWSER, "sec-fetch-site": "cross-site" }],
  ["same-origin with no Origin", { ...CURL, "sec-fetch-site": "same-origin" }],
  ["another loopback port", { ...BROWSER, origin: "http://127.0.0.1:9999" }],
];

const req = (path: string, method: string, body: unknown, headers: Record<string, string> = CURL) =>
  new Request(`http://127.0.0.1:3461${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
/** A SCHEMA-VALID post body: an invalid one is refused 400 by the parser before the check runs. */
const postBody = (createdBy: "ui" | "agent", mode: "now" | "draft") => ({
  requestId: "00000000-0000-4000-8000-000000000001",
  content: "hi",
  media: [],
  targets: [],
  when: { mode },
  libi: { pieceId: "p1" },
  createdBy,
});

type Call = (headers: Record<string, string>) => Promise<Response>;
/** Routes with their status once past the check (with the mocks above). */
const ROUTES: Array<[string, string, Call, number?]> = [
  ["approval card", "permission_refused", (h) => permission(req("/api/sessions/s1/permission", "POST", { pendingId: "p1", optionId: "allow" }, h), params({ sessionId: "s1" }))],
  ["publish a social post as the user", "posts.create_refused", (h) => createPost(req("/api/social/posts", "POST", postBody("ui", "now"), h))],
  ["save a draft as the user", "posts.create_refused", (h) => createPost(req("/api/social/posts", "POST", postBody("ui", "draft"), h))],
  ["edit a social post", "posts.update_refused", (h) => patchPost(req("/api/social/posts/x", "PATCH", { requestId: "00000000-0000-4000-8000-000000000002", createdBy: "ui", content: "edited" }, h), params({ postId: "x" }))],
  ["delete a social post", "posts.delete_refused", (h) => deletePost(req("/api/social/posts/x", "DELETE", undefined, h), params({ postId: "x" }))],
  ["retry a social post", "posts.retry_refused", (h) => retryPost(req("/api/social/posts/x/retry", "POST", {}, h), params({ postId: "x" }))],
  ["connect social accounts", "oauth.start_refused", (h) => oauthStart(req("/api/social/oauth/start", "POST", {}, h))],
  ["disconnect social accounts", "oauth.disconnect_refused", (h) => oauthDisconnect(req("/api/social/oauth/disconnect", "POST", {}, h))],
  ["report a catalog template", "report_refused", (h) => report(req("/api/templates/cloud/report", "POST", { cloudId: "abcdefghijklmnopqrst", reason: "spam" }, h))],
  ["restart a chat (it cancels the running turn)", "session_restart_refused", (h) => restartSession(req("/api/sessions/s1/restart", "POST", undefined, h), params({ sessionId: "s1" }))],
  ["change the approval mode", "permission_modes_refused", (h) => patchModes(req("/api/sessions/permission-modes", "PATCH", { agentId: "claude-code", mode: "auto-with-generations" }, h))],
  ["change the social settings (provider, post defaults)", "settings.put_refused", (h) => putSocialSettings(req("/api/social/settings", "PUT", { providerId: "zernio", timezone: "UTC", defaults: { instagramType: "reel", aiLabel: false }, pollSeconds: 30 }, h))],
  ["switch an extension's approval off", "mcp_server_update_refused", (h) => patchMcpServer(req("/api/settings/mcp-servers/libi-tracking", "PATCH", { requireApproval: false }, h), params({ id: "libi-tracking" })), 404],
  ["mark a track as the user's own", "owned_refused", (h) => patchAudioRights(req("/api/files/by-id/f1/audio-rights", "PATCH", { class: "owned" }, h), params({ fileId: "f1" }))],
  ["set a TikTok account's type (a music setting)", "facts_put_refused", (h) => putMusicFacts(req("/api/social/music/facts", "PUT", { accountId: "tt", tiktokKind: "personal" }, h))],
];

beforeEach(() => {
  vi.clearAllMocks();
  adapter.createPost.mockResolvedValue({ post: socialPost, deduped: false });
  adapter.updatePost.mockResolvedValue({ post: socialPost, deduped: false });
  adapter.deletePost.mockResolvedValue(undefined);
  adapter.retryPost.mockResolvedValue({ post: socialPost, deduped: false });
  oauth.startSignIn.mockResolvedValue({ url: "https://provider.example/authorize" });
  cloud.reportTemplate.mockResolvedValue({ ok: true, hidden: false });
});

describe("user-only actions refuse a header-less loopback caller", () => {
  it.each(ROUTES)("%s → 403 browser_only, logged as %s", async (_name, op, call) => {
    const res = await call(CURL);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("browser_only");
    expect(logSpies.warn).toHaveBeenCalledWith(expect.objectContaining({ op, reason: "not_same_origin_fetch" }), expect.any(String));
    // Nothing behind the check ran.
    expect(approval.resolve).not.toHaveBeenCalled();
    expect(approval.restart).not.toHaveBeenCalled();
    expect(adapter.createPost).not.toHaveBeenCalled();
    expect(adapter.updatePost).not.toHaveBeenCalled();
    expect(adapter.deletePost).not.toHaveBeenCalled();
    expect(adapter.retryPost).not.toHaveBeenCalled();
    expect(oauth.startSignIn).not.toHaveBeenCalled();
    expect(oauth.disconnect).not.toHaveBeenCalled();
    expect(cloud.reportTemplate).not.toHaveBeenCalled();
    expect(modes.setApprovalMode).not.toHaveBeenCalled();
    expect(socialSettings.setSocialSettings).not.toHaveBeenCalled();
    expect(musicFacts.setUserTikTokKind).not.toHaveBeenCalled();
  });

  it.each(NOT_THE_PAGE)("near miss (%s) is refused on every route", async (_label, headers) => {
    for (const [name, , call] of ROUTES) {
      const res = await call(headers);
      expect(res.status, name).toBe(403);
      expect((await res.json()).code, name).toBe("browser_only");
    }
  });

  it("an agent's DRAFT (createdBy agent) still passes the check (libi.post_piece)", async () => {
    const res = await createPost(req("/api/social/posts", "POST", postBody("agent", "draft")));
    expect(res.status).toBe(200);
    expect(adapter.createPost).toHaveBeenCalledOnce();
  });

  it("an agent's publish is still refused by the draft-only rule, not the browser check", async () => {
    const res = await createPost(req("/api/social/posts", "POST", postBody("agent", "now")));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("agent_draft_only");
    expect(adapter.createPost).not.toHaveBeenCalled();
  });
});

describe("the page's own request passes every check (positive control)", () => {
  it.each(ROUTES)("%s → not 403", async (name, _op, call, passed = 200) => {
    const res = await call(BROWSER);
    expect(res.status, name).toBe(passed);
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it("the page opened at localhost passes every route too", async () => {
    for (const [name, , call, passed = 200] of ROUTES) {
      expect((await call(BROWSER_LOCALHOST)).status, name).toBe(passed);
    }
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it("the approval card from the page resolves the held promise", async () => {
    await ROUTES[0][2](BROWSER);
    expect(approval.resolve).toHaveBeenCalledWith({ outcome: { outcome: "selected", optionId: "allow" } });
  });
});
