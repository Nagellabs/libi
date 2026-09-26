import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { VISIBILITY_TIMEOUT_MS, setTemplateHidden } from "@/lib/templates/cloud/client";

const KEY = "k".repeat(43);
const ID = "abcdefghijklmnopqrst";
const MINE = {
  id: ID, name: "Hook", description: "", tags: [], nickname: "nadav", authorId: "a", version: 1, hasCode: false,
  canvas: { width: 1080, height: 1920 }, duration: 3, slotCount: 1,
  poster: `templates/${ID}/v1/poster.jpg`, video: `templates/${ID}/v1/example.mp4`,
  hidden: true, moderated: false, indexPending: false, usesTotal: 0, uses7d: 0, byDay: {},
  createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
};
const ok = (template: unknown = MINE) => new Response(JSON.stringify({ ok: true, template }), { status: 200 });
const fail = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ ok: false, error: `site says ${code}`, code }), { status, headers });

function queue(...answers: Array<Response | Error>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const a of answers) {
    if (a instanceof Error) spy.mockRejectedValueOnce(a);
    else spy.mockResolvedValueOnce(a);
  }
  return spy;
}

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("setTemplateHidden", () => {
  it("PATCHes { hidden } with the bearer key and returns the owner's entry", async () => {
    const spy = queue(ok());
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    expect(await setTemplateHidden(KEY, ID, true, { sleep })).toMatchObject({ ok: true, template: { id: ID, hidden: true } });
    expect(spy.mock.calls[0][0]).toBe(`https://libi.nagellabs.com/api/templates/${ID}`);
    expect(spy.mock.calls[0][1]).toMatchObject({ method: "PATCH", body: '{"hidden":true}', headers: { Authorization: `Bearer ${KEY}` } });
    expect(sleep).not.toHaveBeenCalled();
  });

  // Site review: the site gates a PATCH that carries an edit (name/description/tags) on creator approval, and
  // never gates a hide. A hide combined with an edit would be refused for an unapproved creator — so a hide
  // always goes alone, on every attempt, and nothing else in libi sends the site a PATCH.
  it("sends a hide alone — exactly { hidden: true } on every attempt — and is the client's only PATCH", async () => {
    const spy = queue(fail(500, "internal"), new TypeError("fetch failed"), ok());
    await setTemplateHidden(KEY, ID, true, { sleep: async () => {} });
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [, init] of spy.mock.calls) {
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toStrictEqual({ hidden: true });
    }
    const src = readFileSync(path.resolve("lib/templates/cloud/client.ts"), "utf8");
    expect(src.match(/method:\s*"PATCH"/g)).toHaveLength(1);
    expect(src).toMatch(/method: "PATCH", headers: authHeaders\(key\), body: JSON\.stringify\(\{ hidden \}\)/);
  });

  // Site fix round 3: PATCH declares maxDuration = 60, and an unhide moves files back before it answers.
  it("waits up to the site's own 60 s bound for each attempt — not the 15 s other calls get", async () => {
    expect(VISIBILITY_TIMEOUT_MS).toBe(60_000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    queue(ok());
    await setTemplateHidden(KEY, ID, false, { sleep: async () => {} });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(60_000);
  });

  it("retries a 5xx or a request that got no answer, with backoff, and succeeds", async () => {
    const spy = queue(fail(500, "internal"), new TypeError("fetch failed"), ok());
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    expect(await setTemplateHidden(KEY, ID, true, { sleep })).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1_000, 3_000]);
  });

  it("honours the site's Retry-After on a 503, capped at 10 s", async () => {
    queue(fail(503, "internal", { "retry-after": "4" }), fail(503, "internal", { "retry-after": "600" }), ok());
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    await setTemplateHidden(KEY, ID, true, { sleep });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([4_000, 10_000]);
  });

  it("gives up after three transient failures with the last one", async () => {
    const spy = queue(fail(500, "internal"), fail(502, "internal"), fail(503, "internal"));
    const r = await setTemplateHidden(KEY, ID, true, { sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, status: 503, code: "internal" });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("never retries a refusal: moderated, gone, not_found, forbidden, rate_limited come back once, with their code", async () => {
    for (const [status, code] of [[403, "moderated"], [410, "gone"], [404, "not_found"], [403, "forbidden"], [429, "rate_limited"], [400, "invalid"]] as const) {
      vi.restoreAllMocks();
      const spy = queue(fail(status, code));
      expect(await setTemplateHidden(KEY, ID, false, { sleep: async () => {} })).toMatchObject({ ok: false, status, code });
      expect(spy, code).toHaveBeenCalledTimes(1);
    }
  });

  // Site round 4: a hide sent while an unhide is still running wins; the unhide answers 409 busy.
  it("never re-sends an unhide: not after busy, not after a 5xx, not after no answer", async () => {
    for (const answer of [fail(409, "busy"), fail(503, "internal"), new TypeError("fetch failed")]) {
      vi.restoreAllMocks();
      const spy = queue(answer, ok({ ...MINE, hidden: false }));
      const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
      const r = await setTemplateHidden(KEY, ID, false, { sleep });
      expect(r.ok).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("a hide that meets busy is not retried either (a refusal), and comes back with its code", async () => {
    const spy = queue(fail(409, "busy"), ok());
    expect(await setTemplateHidden(KEY, ID, true, { sleep: async () => {} })).toMatchObject({ ok: false, status: 409, code: "busy" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed key or id without calling the site, and an unreadable entry is a failure", async () => {
    const spy = queue(ok({ ...MINE, hidden: "yes" }));
    expect(await setTemplateHidden("short", ID, true)).toMatchObject({ ok: false });
    expect(await setTemplateHidden(KEY, "NOT-AN-ID", true)).toMatchObject({ ok: false });
    expect(spy).not.toHaveBeenCalled();
    expect(await setTemplateHidden(KEY, ID, true)).toMatchObject({ ok: false });
  });

  // Final review m2: after a request that went out, no answer or a 5xx leaves the outcome unknown —
  // an unhide is sent once, and a hide's lost answer may have been applied. A refusal is definite.
  it("marks an unanswered, 5xx or unreadable-2xx result as outcomeUnknown, and a refusal or local check as definite", async () => {
    for (const [hidden, answers] of [
      [false, [new TypeError("fetch failed")]],
      [false, [fail(503, "internal")]],
      [true, [fail(500, "internal"), new TypeError("fetch failed"), fail(503, "internal")]],
      [true, [new TypeError("a"), new TypeError("b"), new TypeError("c")]],
      [false, [ok({ ...MINE, hidden: "yes" })]],
      [true, [new Response("not json", { status: 200 })]],
    ] as const) {
      vi.restoreAllMocks();
      queue(...answers);
      expect(await setTemplateHidden(KEY, ID, hidden, { sleep: async () => {} })).toMatchObject({ ok: false, outcomeUnknown: true });
    }
    for (const answer of [fail(409, "busy"), fail(403, "moderated"), fail(429, "rate_limited"), fail(400, "invalid")]) {
      vi.restoreAllMocks();
      queue(answer);
      const r = await setTemplateHidden(KEY, ID, false, { sleep: async () => {} });
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty("outcomeUnknown");
    }
    // Nothing was sent (a malformed key or id): nothing changed, and libi knows it.
    vi.restoreAllMocks();
    const spy = queue(ok());
    expect(await setTemplateHidden("short", ID, true)).not.toHaveProperty("outcomeUnknown");
    expect(await setTemplateHidden(KEY, "NOT-AN-ID", false)).not.toHaveProperty("outcomeUnknown");
    expect(spy).not.toHaveBeenCalled();
  });

  it("never lets the key into an error", async () => {
    queue(new TypeError(`connect failed for Bearer ${KEY}`), new TypeError(`again ${KEY}`), new TypeError(`still ${KEY}`));
    const r = await setTemplateHidden(KEY, ID, true, { sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
