import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
vi.mock("@/lib/templates/cloud/client", () => ({ setNickname: vi.fn(), fetchMine: vi.fn() }));
import { fetchMine, setNickname } from "@/lib/templates/cloud/client";
import { getTemplatesAuthor, importTemplatesAuthorKey, setTemplatesAuthorNickname } from "@/lib/db/settings";
import { generateCreatorKey } from "@/lib/templates/cloud/identity";
import { GET as GET_KEY, POST as CREATE_KEY, PUT as IMPORT_KEY } from "@/app/api/templates/cloud/key/route";
import { POST as REVEAL_KEY } from "@/app/api/templates/cloud/key/reveal/route";
import { GET as GET_AUTHOR, PUT as SET_AUTHOR } from "@/app/api/templates/cloud/author/route";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { makeScaffold } from "@/__tests__/helpers/templates";
import { navigationEmitter } from "@/lib/navigation-events";
import { CREATOR_NOT_APPROVED_MESSAGE, CREATOR_NOT_APPROVED_RENAME_MESSAGE, CREATOR_STATUS_REFRESH_KEY } from "@/lib/templates/cloud/constants";

/** "<Adjective> <Animal> <NNNN>" — lib/templates/cloud/default-nickname.ts. */
const DEFAULT_NICKNAME = /^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/;
const anyDefault = expect.stringMatching(DEFAULT_NICKNAME);

/** An identity stored before defaults existed: a key, no nickname. */
function legacyIdentity(): string {
  const key = generateCreatorKey();
  const value = JSON.stringify({ key, authorId: "ignored", nickname: null, createdAt: 1 });
  getDb().insert(settings).values({ id: 1, templatesAuthor: value }).onConflictDoUpdate({ target: settings.id, set: { templatesAuthor: value } }).run();
  return key;
}

/** libi's own page: a same-origin browser request (the Settings card, the Templates page). */
const BROWSER = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" };
/** What a tool call, a curl or an agent's shell sends — or a page that isn't libi's. */
const NOT_THE_PAGE: Array<Record<string, string>> = [
  {},
  { host: "127.0.0.1:3461" },
  { ...BROWSER, "sec-fetch-site": "none" },
  { ...BROWSER, "sec-fetch-site": "cross-site" },
  { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin" }, // no Origin
  { ...BROWSER, origin: "http://127.0.0.1:9999" },
  { ...BROWSER, origin: "http://evil.example" },
  { ...BROWSER, host: "evil.example:3461", origin: "http://evil.example:3461" },
];
const put = (url: string, body: unknown, headers: Record<string, string> = BROWSER) =>
  new Request(`http://127.0.0.1:3461${url}`, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const importKey = (key: unknown, replace?: boolean, headers?: Record<string, string>) =>
  IMPORT_KEY(put("/api/templates/cloud/key", { key, ...(replace === undefined ? {} : { replace }) }, headers));
const setAuthor = (nickname: unknown, headers?: Record<string, string>) => SET_AUTHOR(put("/api/templates/cloud/author", { nickname }, headers));
/** The page's own read (the Settings card, the Templates page). */
const view = (url: string, headers: Record<string, string> = { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }) =>
  new Request(`http://127.0.0.1:3461${url}`, { headers });
const getKey = (headers?: Record<string, string>) => GET_KEY(view("/api/templates/cloud/key", headers));
const getAuthor = (headers?: Record<string, string>) => GET_AUTHOR(view("/api/templates/cloud/author", headers));
const reveal = (headers: Record<string, string> = BROWSER) => REVEAL_KEY(new Request("http://127.0.0.1:3461/api/templates/cloud/key/reveal", { method: "POST", headers }));

beforeEach(() => {
  createTestDb();
});
afterEach(() => {
  resetTestDb();
  vi.clearAllMocks();
});

describe("creator key routes", () => {
  it("a fresh install's first GET creates the identity with a default nickname — never carrying the key, only its mask — and every later read (GET or POST) answers the same", async () => {
    expect(getTemplatesAuthor()).toBeNull();
    const first = await getKey();
    expect(first.headers.get("cache-control")).toBe("no-store");
    const created = await first.json();
    const key = getTemplatesAuthor()!.key;
    expect(created).toEqual({ hasKey: true, masked: `${key.slice(0, 4)}…${key.slice(-4)}`, authorId: getTemplatesAuthor()!.authorId, nickname: anyDefault, publishedHere: false });
    expect(created.nickname).toBe(getTemplatesAuthor()!.nickname);
    expect(JSON.stringify(created)).not.toContain(key);
    expect(await (await getKey()).json()).toEqual(created);
    expect(await (await CREATE_KEY()).json()).toEqual(created);
    // Nothing asked the site.
    expect(fetchMine).not.toHaveBeenCalled();
  });

  it("GET refuses a cross-site or same-site subresource request before it creates anything", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const r = await getKey({ host: "127.0.0.1:3461", "sec-fetch-site": site, "sec-fetch-mode": "no-cors" });
      expect(r.status, site).toBe(403);
      expect((await r.json()).code).toBe("cross_site_read");
    }
    expect(getTemplatesAuthor()).toBeNull();
    // A header-less internal client (curl, the MCP child) is not a web page: it passes.
    expect((await getKey({ host: "127.0.0.1:3461" })).status).toBe(200);
  });

  it("test mode's first view creates test mode's own identity (row 2), leaving the production one alone", async () => {
    const prod = (await (await getKey()).json()).authorId;
    vi.stubEnv("LIBI_TEST_MODE", "1");
    try {
      const test = await (await getAuthor()).json();
      expect(test).toEqual({ nickname: anyDefault, authorId: expect.any(String) });
      expect(test.authorId).not.toBe(prod);
      expect(getTemplatesAuthor()?.authorId).toBe(test.authorId);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(getTemplatesAuthor()?.authorId).toBe(prod);
  });

  it("the full key comes only from POST …/key/reveal: no-store, and 404 when there is no identity (reveal never creates one)", async () => {
    const none = await reveal();
    expect(none.status).toBe(404);
    expect(getTemplatesAuthor()).toBeNull();
    await CREATE_KEY();
    const r = await reveal();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ key: getTemplatesAuthor()!.key });
  });

  it("reveal refuses anything but the page's own same-origin request — a tool call, a curl, another origin — and never says the key", async () => {
    await CREATE_KEY();
    const key = getTemplatesAuthor()!.key;
    for (const headers of NOT_THE_PAGE) {
      const r = await reveal(headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      const body = await r.json();
      expect(body.code).toBe("browser_only");
      expect(JSON.stringify(body)).not.toContain(key);
    }
  });

  it("PUT refuses anything but the page's own same-origin request, and nothing changes: an agent can't swap in a key it holds", async () => {
    await CREATE_KEY();
    const before = getTemplatesAuthor();
    const agentsKey = generateCreatorKey();
    for (const headers of NOT_THE_PAGE) {
      const r = await importKey(agentsKey, true, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toMatchObject({ code: "browser_only" });
    }
    expect(getTemplatesAuthor()).toEqual(before);
    expect(fetchMine).not.toHaveBeenCalled();
  });

  it("PUT imports and refreshes the nickname from the site, answering the mask, not the key", async () => {
    const key = generateCreatorKey();
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "elsewhere", templates: [] });
    const imported = await importKey(` ${key}\n`);
    expect(imported.headers.get("cache-control")).toBe("no-store");
    const body = await imported.json();
    expect(body).toMatchObject({ hasKey: true, masked: `${key.slice(0, 4)}…${key.slice(-4)}`, nickname: "elsewhere" });
    expect(JSON.stringify(body)).not.toContain(key);
    expect(fetchMine).toHaveBeenCalledWith(key);
    expect(getTemplatesAuthor()?.nickname).toBe("elsewhere");
    expect((await importKey("junk")).status).toBe(400);
    expect((await importKey(42)).status).toBe(400);
    expect(getTemplatesAuthor()?.key).toBe(key);
  });

  it("an import stays best effort when the site can't be reached: the key is in, with a fresh default nickname", async () => {
    const key = generateCreatorKey();
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: false, error: "offline" });
    const r = await importKey(key);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ hasKey: true, nickname: anyDefault });
    expect(getTemplatesAuthor()).toMatchObject({ key, nickname: anyDefault });
  });

  it("an import whose key the site has no nickname for keeps the default; one it has replaces the default", async () => {
    const quiet = generateCreatorKey();
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: null, templates: [] });
    expect(await (await importKey(quiet)).json()).toMatchObject({ nickname: anyDefault });
    const known = generateCreatorKey();
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "elsewhere", templates: [] });
    expect(await (await importKey(known, true)).json()).toMatchObject({ nickname: "elsewhere" });
    expect(getTemplatesAuthor()).toMatchObject({ key: known, nickname: "elsewhere" });
  });

  it("GET gives an identity stored without a nickname its default (the lazy backfill), and keeps it", async () => {
    const key = legacyIdentity();
    const first = await (await getKey()).json();
    expect(first).toMatchObject({ hasKey: true, nickname: anyDefault });
    expect(getTemplatesAuthor()).toMatchObject({ key, nickname: first.nickname });
    expect((await (await getKey()).json()).nickname).toBe(first.nickname);
  });

  it("re-importing the key already in use changes nothing — its nickname stays without asking the site", async () => {
    const key = generateCreatorKey();
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "nadav", templates: [] });
    await importKey(key);
    vi.mocked(fetchMine).mockClear();
    expect(await (await importKey(key)).json()).toMatchObject({ hasKey: true, nickname: "nadav" });
    expect(fetchMine).not.toHaveBeenCalled();
  });

  // Review A10 round 2 Minor: the card used to decide "same key" from the mask.
  it("replacing a DIFFERENT, USED stored key needs `replace: true` — judged on the whole key, so a lookalike sharing the mask is refused too", async () => {
    const current = generateCreatorKey();
    importTemplatesAuthorKey(current);
    const lookalike = current.slice(0, 4) + (current[4] === "A" ? "B" : "A") + current.slice(5);
    // The site lists a template for the current key: it has been used.
    vi.mocked(fetchMine).mockImplementation(async (k) => ({ ok: true, nickname: "nadav", templates: k === current ? [{ id: "abcdefghijklmnopqrst" } as never] : [] }));
    for (const other of [generateCreatorKey(), lookalike]) {
      const r = await importKey(other);
      expect(r.status).toBe(409);
      const body = await r.json();
      expect(body.code).toBe("replace_required");
      expect(JSON.stringify(body)).not.toContain(current);
      expect(getTemplatesAuthor()?.key).toBe(current);
    }
    // Asked about the CURRENT key only; the pasted one was never spent.
    expect(new Set(vi.mocked(fetchMine).mock.calls.map(([k]) => k))).toEqual(new Set([current]));
    vi.mocked(fetchMine).mockReset();
    // A key that isn't one is still a 400, not a question about replacing.
    expect((await importKey("junk")).status).toBe(400);
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: false, error: "offline" });
    expect((await importKey(lookalike, true)).status).toBe(200);
    expect(getTemplatesAuthor()?.key).toBe(lookalike);
  });

  it("importing onto the key libi made on first view, never used, is silent: no confirmation, the key replaced, the imported key's site nickname taken", async () => {
    const auto = (await (await getKey()).json()) as { masked: string; nickname: string };
    const autoKey = getTemplatesAuthor()!.key;
    const imported = generateCreatorKey();
    // The site knows the auto key but lists nothing under it; the imported one publishes as "elsewhere".
    vi.mocked(fetchMine).mockImplementation(async (k) => (k === autoKey ? { ok: true, nickname: null, templates: [] } : { ok: true, nickname: "elsewhere", templates: [] }));
    const r = await importKey(imported);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ hasKey: true, nickname: "elsewhere" });
    expect(getTemplatesAuthor()).toMatchObject({ key: imported, nickname: "elsewhere" });
    expect(auto.nickname).toMatch(DEFAULT_NICKNAME);
    // …and when the imported key has no site nickname, it keeps a default of its own.
    const quiet = generateCreatorKey();
    vi.mocked(fetchMine).mockImplementation(async () => ({ ok: true, nickname: null, templates: [] }));
    const q = await importKey(quiet);
    expect(q.status).toBe(200);
    expect(getTemplatesAuthor()).toMatchObject({ key: quiet, nickname: anyDefault });
    vi.mocked(fetchMine).mockReset();
  });

  it("asks before replacing a key the site lists templates for that libi can't read, or holds a nickname for (renamed, never published)", async () => {
    await getKey();
    const before = getTemplatesAuthor()!.key;
    for (const site of [
      { ok: true as const, nickname: null, templates: [], dropped: 1 },
      { ok: true as const, nickname: "Nadav", templates: [] },
    ]) {
      vi.mocked(fetchMine).mockResolvedValueOnce(site);
      const r = await importKey(generateCreatorKey());
      expect(r.status, JSON.stringify(site)).toBe(409);
      expect((await r.json()).code).toBe("replace_required");
      expect(getTemplatesAuthor()?.key).toBe(before);
    }
  });

  it("a publish that starts under the current key while the usage check waits on the site makes it used: asks, replaces nothing", async () => {
    const home = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "libi-key-route-"));
    vi.stubEnv("LIBI_HOME", home);
    await getKey();
    const before = getTemplatesAuthor()!.key;
    vi.mocked(fetchMine).mockImplementationOnce(async () => {
      // A Publish clicked in another tab reaches prepare meanwhile: a pending publish now exists here.
      const { createTemplate } = await import("@/lib/templates/store");
      const { templates } = await import("@/lib/db/schema/sqlite");
      const { eq } = await import("drizzle-orm");
      const t = await createTemplate({ name: "H", description: "d", tags: ["h"], scaffold: makeScaffold({ name: "H", description: "d", tags: ["h"] }) as never, instructions: "# P\n", copies: [], writes: [] });
      getDb().update(templates).set({ publishPending: "{}" }).where(eq(templates.id, t.id)).run();
      return { ok: true, nickname: null, templates: [] };
    });
    const r = await importKey(generateCreatorKey());
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("replace_required");
    expect(getTemplatesAuthor()?.key).toBe(before);
    vi.unstubAllEnvs();
    (await import("node:fs")).rmSync(home, { recursive: true, force: true });
  });

  it("when the site can't say whether the current key was used, the import asks (a doubt counts as used)", async () => {
    await getKey();
    const before = getTemplatesAuthor()!.key;
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: false, error: "offline" });
    const r = await importKey(generateCreatorKey());
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("replace_required");
    expect(getTemplatesAuthor()?.key).toBe(before);
  });

  it("a key replaced while the usage check waited on the site is never silently overwritten: 409", async () => {
    await getKey();
    const raced = generateCreatorKey();
    vi.mocked(fetchMine).mockImplementationOnce(async () => {
      importTemplatesAuthorKey(raced); // another import lands mid-await
      return { ok: true, nickname: null, templates: [] };
    });
    const r = await importKey(generateCreatorKey());
    expect(r.status).toBe(409);
    expect(getTemplatesAuthor()?.key).toBe(raced);
  });

  // A13 fold-in (A11 re-review N1, the same gap at key import): the site's nickname is held to the site's rule first.
  it("an import never stores a nickname the site's own rule refuses", async () => {
    for (const bad of ["x", "<b>", "a\u200bb"]) {
      const key = generateCreatorKey();
      vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: bad, templates: [] });
      const r = await importKey(key, true);
      expect(r.status, bad).toBe(200);
      // The site's value is refused: the import's own default stands.
      expect((await r.json()).nickname, bad).toMatch(DEFAULT_NICKNAME);
      expect(getTemplatesAuthor(), bad).toMatchObject({ key, nickname: anyDefault });
    }
  });

  // A13 fold-in (A11 re-review N2): compare-and-set on the nickname read, at import too.
  it("an import never overwrites a nickname set for the same key while the site answered", async () => {
    const key = generateCreatorKey();
    vi.mocked(fetchMine).mockImplementationOnce(async () => {
      setTemplatesAuthorNickname(key, "typed-meanwhile");
      return { ok: true, nickname: "site-old", templates: [] };
    });
    const r = await importKey(key);
    expect(r.status).toBe(200);
    expect((await r.json()).nickname).toBe("typed-meanwhile");
    expect(getTemplatesAuthor()).toMatchObject({ key, nickname: "typed-meanwhile" });
  });

  it("a key imported while the site answered is never given the old key's nickname: 409", async () => {
    const first = generateCreatorKey();
    const second = generateCreatorKey();
    vi.mocked(fetchMine).mockImplementationOnce(async () => {
      importTemplatesAuthorKey(second); // another import lands mid-await
      return { ok: true, nickname: "first-name", templates: [] };
    });
    const r = await importKey(first);
    expect(r.status).toBe(409);
    // The second import's own default, never "first-name".
    expect(getTemplatesAuthor()).toMatchObject({ key: second, nickname: anyDefault });
  });
});

describe("author routes", () => {
  it("GET answers the stored identity's nickname — a default one gets there without a request to the site", async () => {
    const key = legacyIdentity();
    const got = await (await getAuthor()).json();
    expect(got).toEqual({ nickname: anyDefault, authorId: getTemplatesAuthor()?.authorId });
    expect(getTemplatesAuthor()).toMatchObject({ key, nickname: got.nickname });
    expect(setNickname).not.toHaveBeenCalled();
    expect(fetchMine).not.toHaveBeenCalled();
  });

  it("GET on a fresh install creates the identity and answers its default nickname", async () => {
    expect(getTemplatesAuthor()).toBeNull();
    const got = await (await getAuthor()).json();
    expect(got).toEqual({ nickname: anyDefault, authorId: getTemplatesAuthor()!.authorId });
    expect(getTemplatesAuthor()?.nickname).toBe(got.nickname);
    const refused = await getAuthor({ host: "127.0.0.1:3461", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" });
    expect(refused.status).toBe(403);
  });

  it("PUT creates the identity, sets the nickname on the site and stores it; passes a site refusal through as 400", async () => {
    vi.mocked(setNickname).mockResolvedValueOnce({ ok: true, nickname: "nadav" });
    const res = await setAuthor("nadav");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nickname: "nadav", authorId: getTemplatesAuthor()?.authorId });
    expect(setNickname).toHaveBeenCalledWith(getTemplatesAuthor()?.key, "nadav");
    expect(await (await getAuthor()).json()).toEqual({ nickname: "nadav", authorId: getTemplatesAuthor()?.authorId });
    // GET author never carries the key.
    expect(JSON.stringify(await (await getAuthor()).json())).not.toContain(getTemplatesAuthor()!.key);

    vi.mocked(setNickname).mockResolvedValueOnce({ ok: false, status: 400, code: "invalid", error: "nickname is 2 to 32 letters, digits, spaces, - or _." });
    const bad = await setAuthor("fine name");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "nickname is 2 to 32 letters, digits, spaces, - or _.", code: "invalid" });

    vi.mocked(setNickname).mockResolvedValueOnce({ ok: false, error: "offline" });
    const offline = await setAuthor("fine");
    expect(offline.status).toBe(502);
    expect((await offline.json()).error).toMatch(/^Couldn't reach the catalog/);
    // A refused key is not a reachability problem.
    for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"]] as const) {
      vi.mocked(setNickname).mockResolvedValueOnce({ ok: false, status, code, error: "no" });
      const refused = await setAuthor("fine");
      expect(refused.status, code).toBe(403);
      const body = await refused.json();
      expect(body).toMatchObject({ code });
      expect(body.error).toMatch(/didn't accept this install's creator key/);
    }
    vi.mocked(setNickname).mockResolvedValueOnce({ ok: false, status: 409, code: "contended", error: "busy" });
    const other = await setAuthor("fine");
    expect(other.status).toBe(502);
    expect((await other.json()).error).toMatch(/^The catalog didn't take the nickname/);
    vi.mocked(setNickname).mockResolvedValueOnce({ ok: false, status: 500, code: "internal", error: "Something went wrong." });
    expect((await setAuthor("fine")).status).toBe(502);
    vi.mocked(setNickname).mockResolvedValueOnce({ ok: false, status: 429, code: "rate_limited", error: "Too many requests." });
    const limited = await setAuthor("fine");
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe("rate_limited");
    // Nothing the site refused was stored.
    expect(getTemplatesAuthor()?.nickname).toBe("nadav");
  });

  // The site now refuses a rename 403 creator_not_approved while an unapproved author has a template in the catalog.
  it("a rename the site refuses as creator_not_approved says so in rename words — never 'Nothing was published' — and re-reads the approval", async () => {
    vi.mocked(setNickname).mockResolvedValueOnce({ ok: true, nickname: "nadav" });
    await setAuthor("nadav");
    const emit = vi.spyOn(navigationEmitter, "emit");
    vi.mocked(setNickname).mockResolvedValueOnce({ ok: false, status: 403, code: "creator_not_approved", error: CREATOR_NOT_APPROVED_MESSAGE });
    const r = await setAuthor("someone else");
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body).toEqual({ error: CREATOR_NOT_APPROVED_RENAME_MESSAGE, code: "creator_not_approved" });
    expect(CREATOR_NOT_APPROVED_RENAME_MESSAGE).toBe("You can't change your nickname: once you've published a template, only an approved creator can change it, even while your templates are hidden.");
    // Never the publish refusal's words, and no advice to hide: hidden templates carry the nickname too.
    expect(body.error).not.toMatch(/Nothing was published|hide your|in the catalog/i);
    expect(emit).toHaveBeenCalledWith("refresh_query", { queryKey: CREATOR_STATUS_REFRESH_KEY });
    expect(getTemplatesAuthor()?.nickname).toBe("nadav");
  });

  it("PUT refuses anything but the page's own same-origin request: the site is never called and nothing is stored", async () => {
    for (const headers of NOT_THE_PAGE) {
      const r = await setAuthor("renamed", headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(await r.json()).toMatchObject({ code: "browser_only" });
    }
    expect(setNickname).not.toHaveBeenCalled();
    expect(getTemplatesAuthor()).toBeNull();
  });

  it("holds the value to the site's nickname rule before calling the site, and sends the normalised form", async () => {
    for (const refused of ["x", "<x>", "--", "   ", "a".repeat(33), "na‮dav", "nadav​", "na\u0000dav", "\u{e0041}nadav"]) {
      const r = await setAuthor(refused);
      expect(r.status, JSON.stringify(refused)).toBe(400);
    }
    expect((await setAuthor(7)).status).toBe(400);
    expect(setNickname).not.toHaveBeenCalled();
    vi.mocked(setNickname).mockResolvedValueOnce({ ok: true, nickname: "Nadav N" });
    expect((await setAuthor("  Nadav    N ")).status).toBe(200);
    expect(vi.mocked(setNickname).mock.calls[0][1]).toBe("Nadav N");
  });

  it("a key imported while the site answered never receives the nickname: 409, and the new identity is untouched", async () => {
    const other = generateCreatorKey();
    vi.mocked(setNickname).mockImplementationOnce(async () => {
      importTemplatesAuthorKey(other);
      return { ok: true, nickname: "nadav" };
    });
    const r = await setAuthor("nadav");
    expect(r.status).toBe(409);
    expect(getTemplatesAuthor()).toMatchObject({ key: other, nickname: anyDefault });
  });
});
