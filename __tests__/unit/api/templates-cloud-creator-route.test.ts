/**
 * The creator's approval to publish, libi's side
 * (app/api/templates/cloud/creator/route.ts): GET reads the status for the
 * Templates page without creating anything; POST files an application with
 * the site, only from libi's own page, and answers in libi's words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
vi.mock("@/lib/templates/cloud/client", () => ({ creatorStatus: vi.fn(), applyAsCreator: vi.fn() }));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
import { applyAsCreator, creatorStatus } from "@/lib/templates/cloud/client";
import { trackServerEvent } from "@/lib/analytics/server";
import { getOrCreateTemplatesAuthor, getTemplatesAuthor } from "@/lib/db/settings";
import { CREATOR_REQUEST_CLOSED_MESSAGE } from "@/lib/templates/cloud/constants";
import { serverLogger } from "@/lib/logger";
import { GET, POST } from "@/app/api/templates/cloud/creator/route";

/** libi's own page: a same-origin browser request. */
const BROWSER = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" };
const view = (headers: Record<string, string> = { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }) =>
  GET(new Request("http://127.0.0.1:3461/api/templates/cloud/creator", { headers }));
const apply = (body: unknown, headers: Record<string, string> = BROWSER) =>
  POST(new Request("http://127.0.0.1:3461/api/templates/cloud/creator", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }));

beforeEach(() => {
  createTestDb();
});
afterEach(() => {
  resetTestDb();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/templates/cloud/creator", () => {
  it("with no identity yet: none, without asking the site or creating one", async () => {
    const r = await view();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "none" });
    expect(creatorStatus).not.toHaveBeenCalled();
    expect(getTemplatesAuthor()).toBeNull();
  });

  it("with an identity: the site's word for its key", async () => {
    const a = getOrCreateTemplatesAuthor();
    vi.mocked(creatorStatus).mockResolvedValue({ ok: true, status: "approved" });
    expect(await (await view()).json()).toEqual({ status: "approved" });
    expect(creatorStatus).toHaveBeenCalledWith(a.key);
  });

  it("never 5xx: a site that can't be reached is status null with why", async () => {
    getOrCreateTemplatesAuthor();
    vi.mocked(creatorStatus).mockResolvedValueOnce({ ok: false, error: "socket hang up" });
    const unreachable = await view();
    expect(unreachable.status).toBe(200);
    expect(await unreachable.json()).toEqual({ status: null, error: "unreachable" });
    vi.mocked(creatorStatus).mockResolvedValueOnce({ ok: false, status: 500, error: "x", code: "internal" });
    expect(await (await view()).json()).toEqual({ status: null, error: "unavailable" });
  });

  it("refuses a cross-site read before the key is used", async () => {
    getOrCreateTemplatesAuthor();
    const r = await view({ host: "127.0.0.1:3461", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" });
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("cross_site_read");
    expect(creatorStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/templates/cloud/creator", () => {
  it("only from libi's own page: nothing is sent otherwise", async () => {
    const notThePage: Array<Record<string, string>> = [{}, { host: "127.0.0.1:3461" }, { ...BROWSER, "sec-fetch-site": "cross-site" }, { ...BROWSER, origin: "http://evil.example" }];
    for (const headers of notThePage) {
      const r = await apply({ email: "a@b.co" }, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect((await r.json()).code).toBe("browser_only");
    }
    expect(applyAsCreator).not.toHaveBeenCalled();
    expect(getTemplatesAuthor()).toBeNull();
  });

  it("refuses bad input in libi's words, sending nothing", async () => {
    for (const body of [{ email: "nope" }, { email: "a@b.co", note: "x".repeat(501) }, { email: "a@b.co", note: "a‮b" }, { email: "a@b.co", admin: true }, []]) {
      const r = await apply(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(typeof (await r.json()).error).toBe("string");
    }
    const notJson = await POST(new Request("http://127.0.0.1:3461/api/templates/cloud/creator", { method: "POST", body: "{", headers: { "content-type": "application/json", ...BROWSER } }));
    expect(notJson.status).toBe(400);
    expect(applyAsCreator).not.toHaveBeenCalled();
  });

  it("applies under this install's key (creating the identity if needed), and never logs the email", async () => {
    const info = vi.spyOn(serverLogger, "info");
    const warn = vi.spyOn(serverLogger, "warn");
    vi.mocked(applyAsCreator).mockResolvedValue({ ok: true, status: "pending" });
    const r = await apply({ email: " A@B.co ", note: " hooks " });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "pending" });
    const key = getTemplatesAuthor()!.key;
    const [sentKey, sent] = vi.mocked(applyAsCreator).mock.calls[0];
    expect(sentKey).toBe(key);
    expect({ email: sent.email, note: sent.note }).toEqual({ email: "a@b.co", note: "hooks" });
    expect(sent.appVersion === null || typeof sent.appVersion === "string").toBe(true);
    expect(trackServerEvent).toHaveBeenCalledWith("template_creator_applied");
    for (const call of [...info.mock.calls, ...warn.mock.calls]) expect(JSON.stringify(call)).not.toMatch(/a@b\.co/i);
  });

  it("a decided application: 409 with libi's words and the code", async () => {
    getOrCreateTemplatesAuthor();
    vi.mocked(applyAsCreator).mockResolvedValue({ ok: false, status: 409, code: "creator_request_closed", error: "site words" });
    const r = await apply({ email: "a@b.co" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: CREATOR_REQUEST_CLOSED_MESSAGE, code: "creator_request_closed" });
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("an unreachable site is 502, a speed bump 429, each in libi's words", async () => {
    getOrCreateTemplatesAuthor();
    vi.mocked(applyAsCreator).mockResolvedValueOnce({ ok: false, error: "socket hang up" });
    const down = await apply({ email: "a@b.co" });
    expect(down.status).toBe(502);
    expect((await down.json()).error).toBe("Couldn't reach the catalog. Check your connection and try again.");
    vi.mocked(applyAsCreator).mockResolvedValueOnce({ ok: false, status: 429, code: "rate_limited", error: "x" });
    const slow = await apply({ email: "a@b.co" });
    expect(slow.status).toBe(429);
    expect((await slow.json()).error).toBe("Too many tries. Wait a minute and try again.");
    vi.mocked(applyAsCreator).mockResolvedValueOnce({ ok: false, status: 503, code: "internal", error: "site words" });
    const failed = await apply({ email: "a@b.co" });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("The catalog couldn't take the application right now. Try again later.");
  });
});
