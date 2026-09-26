import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
vi.mock("@/lib/templates/cloud/client", () => ({ fetchMine: vi.fn(), reportTemplate: vi.fn() }));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
import { trackServerEvent } from "@/lib/analytics/server";
import { getOrCreateTemplatesAuthor, getTemplatesAuthor, setTemplatesAuthorNickname } from "@/lib/db/settings";
import { fetchMine, reportTemplate, type MineTemplate } from "@/lib/templates/cloud/client";
import { GET as GET_MINE } from "@/app/api/templates/cloud/mine/route";
import { POST as REPORT } from "@/app/api/templates/cloud/report/route";

const ID = "abcdefghijklmnopqrst";
/** "<Adjective> <Animal> <NNNN>" — lib/templates/cloud/default-nickname.ts. */
const DEFAULT_NICKNAME = /^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/;
const ENTRY: MineTemplate = {
  id: ID, name: "H", version: 1, hidden: false, moderated: false, indexPending: false,
  usesTotal: 3, uses7d: 1, byDay: { "20260923": 1 }, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
};
// The studio's own fetch, and the shape of a header-less internal client (the MCP child, curl).
const MINE_URL = "http://127.0.0.1:3461/api/templates/cloud/mine";
const mineReq = (h: Record<string, string> = {}) => new Request(MINE_URL, { headers: { host: "127.0.0.1:3461", ...h } });
const MINE = (req: Request = mineReq({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" })) => GET_MINE(req);
// The Templates page's Report click: a same-origin browser fetch. A report takes the
// browser-only checks, so a header-less caller is refused (user-only-routes.test.ts).
const PAGE = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" };
const post = (body: unknown, headers: Record<string, string> = PAGE) =>
  REPORT(new Request("http://127.0.0.1:3461/api/templates/cloud/report", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }));

beforeEach(() => createTestDb());
afterEach(() => {
  resetTestDb();
  vi.clearAllMocks();
});

describe("GET /api/templates/cloud/mine", () => {
  it("is empty without a key (and asks nobody), otherwise proxies the site with this install's key, and never 5xx", async () => {
    expect(await (await MINE()).json()).toEqual({ nickname: null, templates: [] });
    expect(fetchMine).not.toHaveBeenCalled();
    const author = getOrCreateTemplatesAuthor();
    // (A nickname the site's rule accepts: one letter is not one — see the A13 test below.)
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "nadav", templates: [ENTRY] });
    expect(await (await MINE()).json()).toEqual({ nickname: "nadav", templates: [ENTRY] });
    expect(fetchMine).toHaveBeenCalledWith(author.key);
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: false, error: "offline" });
    const res = await MINE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nickname: null, templates: [], error: "unreachable" });
  });

  // A11 fix round 1: a code, never the site's words — and "can't reach" only when nothing answered.
  it("answers a failure as a fixed code, never the site's text", async () => {
    getOrCreateTemplatesAuthor();
    const cases = [
      [{ ok: false, error: "fetch failed SITE TEXT" }, "unreachable"],
      [{ ok: false, status: 401, code: "unauthorized", error: "SITE TEXT" }, "unauthorized"],
      [{ ok: false, status: 403, error: "SITE TEXT" }, "unauthorized"],
      [{ ok: false, status: 500, code: "internal", error: "SITE TEXT" }, "unavailable"],
      [{ ok: false, status: 200, error: "the catalog sent an answer libi could not read" }, "unavailable"],
    ] as const;
    for (const [fail, code] of cases) {
      vi.mocked(fetchMine).mockResolvedValueOnce(fail);
      const res = await MINE();
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ nickname: null, templates: [], error: code });
      expect(text).not.toContain("SITE TEXT");
    }
  });

  // A11 fix round 1: the site holds the nickname; a stale local copy must not make "Publishing as" ask for a new one.
  it("writes the site's nickname back over a stale local one — the default included — for the key that asked", async () => {
    const { nickname: dflt } = getOrCreateTemplatesAuthor();
    expect(dflt).toMatch(DEFAULT_NICKNAME);
    // The site has none yet (nothing published): the local default stands, and /mine says the site has none.
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: null, templates: [] });
    expect((await (await MINE()).json()).nickname).toBeNull();
    expect(getTemplatesAuthor()?.nickname).toBe(dflt);
    // A key the site already knows by another name (imported, or renamed elsewhere): the site's replaces the default.
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "site-nick", templates: [] });
    await MINE();
    expect(getTemplatesAuthor()?.nickname).toBe("site-nick");
    // No nickname on the site, or a failure: the local value is left alone.
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: null, templates: [] });
    await MINE();
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: false, error: "offline" });
    await MINE();
    expect(getTemplatesAuthor()?.nickname).toBe("site-nick");
  });

  // A13 fold-in (A11 re-review N1): the site's answer is held to the site's own nickname rule before it is stored.
  it("never writes back, or answers, a nickname the site's own rule refuses", async () => {
    const { nickname: dflt } = getOrCreateTemplatesAuthor();
    for (const bad of ["x", "<script>", "--", "a\u200bb", "n".repeat(33)]) {
      vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: bad, templates: [] });
      const body = await (await MINE()).json();
      // The valid local one — the default — is answered instead.
      expect(body.nickname, bad).toBe(dflt);
      expect(getTemplatesAuthor()?.nickname, bad).toBe(dflt);
    }
    // A valid one is stored in the rule's normalised form.
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "Nadav  N", templates: [] });
    expect((await (await MINE()).json()).nickname).toBe("Nadav N");
    expect(getTemplatesAuthor()?.nickname).toBe("Nadav N");
    // A13 review Minor 4: a refused site value answers the valid local one, not null.
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "<script>", templates: [] });
    expect((await (await MINE()).json()).nickname).toBe("Nadav N");
    expect(getTemplatesAuthor()?.nickname).toBe("Nadav N");
  });

  // A13 fold-in (A11 re-review N2): a nickname set while the site answered is never overwritten by the older one it read.
  it("the write-back is compare-and-set on the nickname it read — no lost update", async () => {
    const author = getOrCreateTemplatesAuthor();
    vi.mocked(fetchMine).mockImplementationOnce(async () => {
      // The user's PUT /author lands while /mine is still waiting on the site.
      setTemplatesAuthorNickname(author.key, "chosen-now");
      return { ok: true, nickname: "stale-site", templates: [] };
    });
    // A13 review Minor 4: the answer is the nickname that stands, not the older one the site read.
    expect((await (await MINE()).json()).nickname).toBe("chosen-now");
    expect(getTemplatesAuthor()?.nickname).toBe("chosen-now");
  });

  it("passes on how many of the site's entries libi couldn't read — they are still the key's (the Settings card counts them as use)", async () => {
    getOrCreateTemplatesAuthor();
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: null, templates: [ENTRY], dropped: 2 });
    expect(await (await MINE()).json()).toEqual({ nickname: null, templates: [ENTRY], dropped: 2 });
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: null, templates: [] });
    expect(await (await MINE()).json()).toEqual({ nickname: null, templates: [] });
  });

  it("never puts the creator key in its answer", async () => {
    const author = getOrCreateTemplatesAuthor();
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "n", templates: [ENTRY] });
    expect(await (await MINE()).text()).not.toContain(author.key);
  });

  // T1 (follow-ups 2026-09-24): the one GET that spends the creator key against the site.
  it("refuses a cross-site or same-site subresource request before it reads the key or calls the site", async () => {
    const author = getOrCreateTemplatesAuthor();
    for (const site of ["cross-site", "same-site"]) {
      const res = await MINE(mineReq({ "sec-fetch-site": site, "sec-fetch-mode": "no-cors" }));
      expect(res.status, site).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).code).toBe("cross_site_read");
      expect(text).not.toContain(author.key);
    }
    expect(fetchMine).not.toHaveBeenCalled();
    expect(getTemplatesAuthor()?.nickname).toBe(author.nickname);
  });

  it("answers the studio's own fetch and a header-less internal client as before", async () => {
    const author = getOrCreateTemplatesAuthor();
    for (const req of [mineReq({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }), mineReq()]) {
      vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "nadav", templates: [ENTRY] });
      const res = await MINE(req);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ nickname: "nadav", templates: [ENTRY] });
    }
    expect(fetchMine).toHaveBeenCalledTimes(2);
    expect(fetchMine).toHaveBeenCalledWith(author.key);
  });
});

describe("POST /api/templates/cloud/report", () => {
  it("validates, forwards, and tracks the reason only once the catalog took it", async () => {
    vi.mocked(reportTemplate).mockResolvedValueOnce({ ok: true, hidden: false });
    const res = await post({ cloudId: ID, reason: "spam" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hidden: false });
    expect(reportTemplate).toHaveBeenCalledWith(ID, "spam", undefined);
    expect(trackServerEvent).toHaveBeenCalledWith("template_reported", { reason: "spam" });

    for (const bad of [{ cloudId: ID, reason: "rude" }, { cloudId: "not-an-id", reason: "spam" }, { reason: "spam" }, "{nope"]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(reportTemplate).toHaveBeenCalledTimes(1);
    expect(trackServerEvent).toHaveBeenCalledTimes(1);
  });

  it("forwards the reporter's details to the catalog, and never into analytics", async () => {
    vi.mocked(reportTemplate).mockResolvedValueOnce({ ok: true, hidden: false });
    const res = await post({ cloudId: ID, reason: "copyright", details: "This is my clip from my channel." });
    expect(res.status).toBe(200);
    expect(reportTemplate).toHaveBeenCalledWith(ID, "copyright", "This is my clip from my channel.");
    expect(trackServerEvent).toHaveBeenCalledWith("template_reported", { reason: "copyright" });
  });

  it("refuses details that aren't text, run over 2000 characters, or carry control/bidi characters — nothing is sent", async () => {
    for (const details of [5, null, ["x"], "x".repeat(2001), "a\u202Eb"]) {
      const res = await post({ cloudId: ID, reason: "other", details });
      expect(res.status, JSON.stringify(details)).toBe(400);
      expect((await res.json()).error).toMatch(/details/i);
    }
    expect(reportTemplate).not.toHaveBeenCalled();
    // Exactly 2000 is fine.
    vi.mocked(reportTemplate).mockResolvedValueOnce({ ok: true, hidden: false });
    expect((await post({ cloudId: ID, reason: "other", details: "x".repeat(2000) })).status).toBe(200);
  });

  it("answers a refusal in libi's own words by its code — never the site's text — and tracks nothing", async () => {
    const cases = [
      [{ ok: false, status: 429, code: "rate_limited", error: "SITE TEXT" }, 429],
      [{ ok: false, status: 503, code: "contended", error: "SITE TEXT" }, 503],
      [{ ok: false, status: 500, code: "internal", error: "SITE TEXT" }, 502],
      [{ ok: false, error: "fetch failed SITE TEXT" }, 502],
    ] as const;
    for (const [fail, status] of cases) {
      vi.mocked(reportTemplate).mockResolvedValueOnce(fail);
      const res = await post({ cloudId: ID, reason: "broken" });
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).not.toContain("SITE TEXT");
      expect(body.error.length).toBeGreaterThan(10);
    }
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  // A11 fix round 1: "check your connection" only when nothing answered.
  it("tells a refusal the catalog answered apart from one that never reached it", async () => {
    for (const fail of [
      { ok: false, status: 403, code: "moderated", error: "SITE TEXT" },
      { ok: false, status: 401, code: "unauthorized", error: "SITE TEXT" },
      { ok: false, status: 400, code: "invalid", error: "SITE TEXT" },
      { ok: false, status: 500, code: "internal", error: "SITE TEXT" },
    ] as const) {
      vi.mocked(reportTemplate).mockResolvedValueOnce(fail);
      const body = await (await post({ cloudId: ID, reason: "broken" })).json();
      expect(body.error).toBe("The catalog didn't take the report. Try again later.");
    }
    vi.mocked(reportTemplate).mockResolvedValueOnce({ ok: false, error: "fetch failed" });
    const offline = await (await post({ cloudId: ID, reason: "broken" })).json();
    expect(offline.error).toMatch(/Couldn't reach the catalog.*Check your connection/);
  });
});
