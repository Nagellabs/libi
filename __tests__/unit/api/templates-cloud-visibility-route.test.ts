import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
vi.mock("@/lib/templates/cloud/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/templates/cloud/client")>();
  return { ...real, setTemplateHidden: vi.fn() };
});
import { MODERATED_MESSAGE, setTemplateHidden, type MineTemplate } from "@/lib/templates/cloud/client";
import { getOrCreateTemplatesAuthor } from "@/lib/db/settings";
import { CREATOR_NOT_APPROVED_UNHIDE_MESSAGE, CREATOR_STATUS_REFRESH_KEY, VISIBILITY_OUTCOME_UNKNOWN_MESSAGE } from "@/lib/templates/cloud/constants";
import { navigationEmitter } from "@/lib/navigation-events";
import { PATCH } from "@/app/api/templates/cloud/visibility/route";
import { pendingOwnCatalogChanges, resetCatalogRefreshForTests } from "@/lib/templates/cloud/catalog-cache";

const ID = "abcdefghijklmnopqrst";
/** The Templates page's own same-origin request. */
const BROWSER = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" };
const patch = (body: unknown, headers: Record<string, string> = BROWSER) =>
  PATCH(new Request("http://127.0.0.1:3461/api/templates/cloud/visibility", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }));
const MINE = { id: ID, name: "Hook", version: 1, hidden: true, moderated: false, indexPending: true, usesTotal: 0, uses7d: 0, byDay: {}, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" } as MineTemplate;

beforeEach(() => {
  createTestDb();
});
afterEach(() => {
  resetCatalogRefreshForTests();
  resetTestDb();
  vi.clearAllMocks();
});

describe("PATCH /api/templates/cloud/visibility", () => {
  it("both directions refuse anything but the page's own same-origin request, and the site is never called", async () => {
    getOrCreateTemplatesAuthor();
    for (const hidden of [false, true]) {
      for (const headers of [
        {}, // curl / an agent's shell
        { host: "127.0.0.1:3461" },
        { ...BROWSER, "sec-fetch-site": "none" },
        { ...BROWSER, "sec-fetch-site": "cross-site" },
        { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin" },
        { ...BROWSER, origin: "http://127.0.0.1:9999" },
        { ...BROWSER, host: "evil.example:3461", origin: "http://evil.example:3461" },
      ] as Array<Record<string, string>>) {
        const r = await patch({ cloudId: ID, hidden }, headers);
        expect(r.status, `${hidden} ${JSON.stringify(headers)}`).toBe(403);
        expect(await r.json()).toMatchObject({ code: "browser_only" });
      }
    }
    expect(setTemplateHidden).not.toHaveBeenCalled();
  });

  it("hides with this install's key and returns the owner's entry (indexPending included, for 'Hide again')", async () => {
    const author = getOrCreateTemplatesAuthor();
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: true, template: MINE });
    const r = await patch({ cloudId: ID, hidden: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ template: MINE });
    expect(setTemplateHidden).toHaveBeenCalledWith(author.key, ID, true);
  });

  // A-F live check N1: the Public tab reflects a hide or a show made here at once, not after the cached copy's 10 minutes.
  it("a hide or a show that the site took is noted for the catalog copy to re-check; a refusal notes nothing", async () => {
    getOrCreateTemplatesAuthor();
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: true, template: MINE });
    await patch({ cloudId: ID, hidden: true });
    expect(pendingOwnCatalogChanges()).toEqual([]); // no copy lists it, so a hide is already reflected
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: true, template: { ...MINE, hidden: false, indexPending: false } });
    await patch({ cloudId: ID, hidden: false });
    expect(pendingOwnCatalogChanges()).toMatchObject([{ cloudId: ID, version: 1, kind: "shown" }]);
    resetCatalogRefreshForTests();
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: false, status: 403, code: "moderated", error: "x" });
    await patch({ cloudId: ID, hidden: false });
    expect(pendingOwnCatalogChanges()).toEqual([]);
  });

  it("a hide goes to the site alone: extra fields in the body (an edit) are never passed on", async () => {
    const author = getOrCreateTemplatesAuthor();
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: true, template: MINE });
    const r = await patch({ cloudId: ID, hidden: true, name: "Renamed", description: "d", tags: ["x"] });
    expect(r.status).toBe(200);
    // setTemplateHidden sends `{ hidden }` and nothing else (client-visibility.test.ts); nothing here can widen it.
    expect(vi.mocked(setTemplateHidden).mock.calls).toEqual([[author.key, ID, true]]);
  });

  // Review M5: the user clicked "Show again", not Publish — the words say it stays hidden, and the page re-reads the approval.
  it("a refused Show again says the template stays hidden, not that nothing was published, and re-reads the creator's approval", async () => {
    getOrCreateTemplatesAuthor();
    const emit = vi.spyOn(navigationEmitter, "emit");
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: false, status: 403, code: "creator_not_approved", error: "site words" });
    const r = await patch({ cloudId: ID, hidden: false });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body).toEqual({ error: CREATOR_NOT_APPROVED_UNHIDE_MESSAGE, code: "creator_not_approved" });
    expect(body.error).toMatch(/stays hidden/);
    expect(body.error).not.toMatch(/Nothing was published/);
    expect(emit).toHaveBeenCalledWith("refresh_query", { queryKey: CREATOR_STATUS_REFRESH_KEY });
    emit.mockClear();
    // Any other refusal leaves the approval alone.
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: false, status: 403, code: "moderated", error: "x" });
    await patch({ cloudId: ID, hidden: false });
    expect(emit).not.toHaveBeenCalledWith("refresh_query", { queryKey: CREATOR_STATUS_REFRESH_KEY });
    emit.mockRestore();
  });

  it("maps each refusal by its code, never its text; moderated gets libi's own words", async () => {
    getOrCreateTemplatesAuthor();
    const cases = [
      [{ ok: false, status: 403, code: "moderated", error: "whatever the site says" }, 403, "moderated"],
      [{ ok: false, status: 410, code: "gone", error: "x" }, 410, "gone"],
      [{ ok: false, status: 404, code: "not_found", error: "x" }, 404, "not_found"],
      [{ ok: false, status: 403, code: "forbidden", error: "x" }, 403, "forbidden"],
      // Showing a template again is publishing: invite-only, in libi's words.
      [{ ok: false, status: 403, code: "creator_not_approved", error: "site words" }, 403, "creator_not_approved"],
      [{ ok: false, status: 429, code: "rate_limited", error: "x" }, 429, "rate_limited"],
      // Site round 4: a hide sent meanwhile won; answered once, in libi's words, never replayed.
      [{ ok: false, status: 409, code: "busy", error: "site words" }, 409, "busy"],
      [{ ok: false, status: 400, code: "invalid", error: "x" }, 502, "invalid"],
      [{ ok: false, error: "the creator key is malformed" }, 502, undefined],
    ] as const;
    for (const [fail, status, code] of cases) {
      vi.mocked(setTemplateHidden).mockResolvedValueOnce(fail as never);
      const r = await patch({ cloudId: ID, hidden: false });
      expect(r.status, String(code)).toBe(status);
      const body = await r.json();
      expect(body.code).toBe(code);
      if (code === "moderated") expect(body.error).toBe(MODERATED_MESSAGE);
      if (code === "creator_not_approved") expect(body.error).toBe(CREATOR_NOT_APPROVED_UNHIDE_MESSAGE);
      if (code === "rate_limited") expect(body.error).toMatch(/Too many changes\. Try again in a minute\./);
      if (code === "busy") expect(body.error).not.toContain("site words");
    }
    // A site message that merely SAYS moderated is not the moderated code.
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: false, status: 500, error: "moderated" });
    expect((await patch({ cloudId: ID, hidden: false })).status).toBe(502);
    // The route calls the client once per request: it adds no retry of its own.
    vi.mocked(setTemplateHidden).mockClear();
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: false, status: 409, code: "busy", error: "x" });
    await patch({ cloudId: ID, hidden: false });
    expect(setTemplateHidden).toHaveBeenCalledTimes(1);
  });

  // Final review m2: no answer, a 5xx or an unreadable 2xx never reads as "didn't take the change".
  it("an outcome the client could not learn is outcome_unknown, in words that claim neither way", async () => {
    getOrCreateTemplatesAuthor();
    for (const fail of [
      { ok: false, error: "fetch failed", outcomeUnknown: true },
      { ok: false, status: 503, code: "internal", error: "x", outcomeUnknown: true },
      { ok: false, status: 200, error: "unreadable", outcomeUnknown: true },
    ]) {
      vi.mocked(setTemplateHidden).mockResolvedValueOnce(fail as never);
      const r = await patch({ cloudId: ID, hidden: false });
      expect(r.status).toBe(502);
      const body = await r.json();
      expect(body).toEqual({ error: VISIBILITY_OUTCOME_UNKNOWN_MESSAGE, code: "outcome_unknown" });
      expect(body.error).not.toMatch(/didn.t take/);
    }
    // A definite refusal the route has no words of its own for still says the change was not taken.
    vi.mocked(setTemplateHidden).mockResolvedValueOnce({ ok: false, status: 400, code: "invalid", error: "bad" });
    expect((await (await patch({ cloudId: ID, hidden: true })).json()).error).toMatch(/didn't take the change/);
  });

  it("409 no_key when nothing was ever published from here; 400 on a bad body", async () => {
    const r = await patch({ cloudId: ID, hidden: true });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("no_key");
    getOrCreateTemplatesAuthor();
    expect((await patch({ cloudId: "bad", hidden: true })).status).toBe(400);
    expect((await patch({ cloudId: ID })).status).toBe(400);
    expect(setTemplateHidden).not.toHaveBeenCalled();
  });
});
