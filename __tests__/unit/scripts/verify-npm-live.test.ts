// `scripts/verify-npm-live.js` — the local half of "a slow registry never turns
// a good publish red". When the release run gives up waiting (0.1.16 sat ~56
// min in npm "processing"), it goes green with a warning naming this script;
// the maintainer runs it and it finishes the check on a budget the CI job
// can't afford: version document → packument → tarball integrity.
//
// The registry is faked through the injected fetch, and time through an
// injected clock, so these run in milliseconds.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import { verifyLive, parseArgs } from "@/scripts/verify-npm-live.js";

const PKG = "@nagellabs/libi";
const V = "0.1.17";
const DOC_URL = `https://registry.npmjs.org/${encodeURIComponent(PKG)}/${V}`;
const PACK_URL = `https://registry.npmjs.org/${encodeURIComponent(PKG)}`;
const TARBALL_URL = `https://registry.npmjs.org/${PKG}/-/libi-${V}.tgz`;

const BYTES = Buffer.from("the real tarball");
const integrityOf = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

type Reply = { status: number; body?: unknown };
const res = ({ status, body }: Reply) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  arrayBuffer: async (): Promise<ArrayBuffer> => {
    const b = body as Buffer;
    const ab = new ArrayBuffer(b.byteLength);
    new Uint8Array(ab).set(b);
    return ab;
  },
});

/** A registry whose three endpoints answer from queues (last answer repeats). */
function fakeRegistry(opts: { doc: Reply[]; pack: Reply[]; tarball: Reply[] }) {
  const calls: string[] = [];
  const next = (q: Reply[]) => (q.length > 1 ? q.shift()! : q[0]);
  const fetch = async (url: string) => {
    calls.push(url);
    if (url === DOC_URL) return res(next(opts.doc));
    if (url === PACK_URL) return res(next(opts.pack));
    if (url === TARBALL_URL) return res(next(opts.tarball));
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetch, calls };
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function logs() {
  const out: string[] = [];
  return { out, log: (s: string) => out.push(s), error: (s: string) => out.push(s) };
}

const docBody = (integrity = integrityOf(BYTES)) => ({
  version: V,
  dist: { tarball: TARBALL_URL, integrity },
});
const packBody = (latest = V) => ({
  "dist-tags": { latest },
  versions: { "0.1.16": {}, [V]: {} },
});

describe("verifyLive", () => {
  it("doc 404 × 3 then 200, packument equal, tarball matches → exit 0 after 4 polls", async () => {
    const reg = fakeRegistry({
      doc: [{ status: 404 }, { status: 404 }, { status: 404 }, { status: 200, body: docBody() }],
      pack: [{ status: 200, body: packBody() }],
      tarball: [{ status: 200, body: BYTES }],
    });
    const clock = fakeClock();
    const l = logs();
    const code = await verifyLive({ version: V, minutes: 90, fetch: reg.fetch, ...clock, ...l });
    expect(code).toBe(0);
    expect(reg.calls.filter((u) => u === DOC_URL)).toHaveLength(4);
    expect(l.out.join("\n")).toMatch(/is live/);
    expect(l.out.join("\n")).toContain(integrityOf(BYTES));
  });

  it("keeps waiting while the packument still shows the previous release", async () => {
    const reg = fakeRegistry({
      doc: [{ status: 200, body: docBody() }],
      pack: [{ status: 200, body: packBody("0.1.16") }, { status: 200, body: packBody() }],
      tarball: [{ status: 200, body: BYTES }],
    });
    const code = await verifyLive({ version: V, minutes: 90, fetch: reg.fetch, ...fakeClock(), ...logs() });
    expect(code).toBe(0);
    expect(reg.calls.filter((u) => u === PACK_URL)).toHaveLength(2);
  });

  it("a tarball digest mismatch → exit 1 immediately, never retried into a pass", async () => {
    const reg = fakeRegistry({
      doc: [{ status: 200, body: docBody(integrityOf(Buffer.from("what npm declared"))) }],
      pack: [{ status: 200, body: packBody() }],
      tarball: [{ status: 200, body: BYTES }],
    });
    const l = logs();
    const code = await verifyLive({ version: V, minutes: 90, fetch: reg.fetch, ...fakeClock(), ...l });
    expect(code).toBe(1);
    expect(reg.calls.filter((u) => u === TARBALL_URL)).toHaveLength(1);
    expect(l.out.join("\n")).toMatch(/does not match/);
    expect(l.out.join("\n")).toMatch(/real corruption signal/);
  });

  it("a FAILED tarball GET is not a mismatch — it is retried", async () => {
    const reg = fakeRegistry({
      doc: [{ status: 200, body: docBody() }],
      pack: [{ status: 200, body: packBody() }],
      tarball: [{ status: 404, body: Buffer.from('{"error":"Not found"}') }, { status: 200, body: BYTES }],
    });
    const code = await verifyLive({ version: V, minutes: 90, fetch: reg.fetch, ...fakeClock(), ...logs() });
    expect(code).toBe(0);
    expect(reg.calls.filter((u) => u === TARBALL_URL)).toHaveLength(2);
  });

  it("a network error is a failed attempt, not a verdict", async () => {
    let first = true;
    const reg = fakeRegistry({
      doc: [{ status: 200, body: docBody() }],
      pack: [{ status: 200, body: packBody() }],
      tarball: [{ status: 200, body: BYTES }],
    });
    const flaky = async (url: string) => {
      if (first) {
        first = false;
        throw new Error("ECONNRESET");
      }
      return reg.fetch(url);
    };
    const code = await verifyLive({ version: V, minutes: 90, fetch: flaky, ...fakeClock(), ...logs() });
    expect(code).toBe(0);
  });

  it("bounds each request with an abort signal — a stalled registry socket doesn't hang past the budget", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    // Never resolves or rejects on its own — only when the caller's signal aborts.
    const stallingFetch = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<ReturnType<typeof res>>((_resolve, reject) => {
        signals.push(init?.signal);
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const code = await verifyLive({
      version: V,
      minutes: 0.001,
      requestTimeoutMs: 20,
      fetch: stallingFetch,
      ...fakeClock(),
      ...logs(),
    });
    expect(code).toBe(2);
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });

  it("gives the tarball its own, longer bound — a body slower than one request's bound still verifies", async () => {
    const reg = fakeRegistry({
      doc: [{ status: 200, body: docBody() }],
      pack: [{ status: 200, body: packBody() }],
      tarball: [{ status: 200, body: BYTES }],
    });
    // The tarball's body takes 100 ms: past the 20 ms request bound, well inside the tarball's.
    const slowBody = async (url: string, init?: { signal?: AbortSignal }) => {
      const r = await reg.fetch(url);
      if (url !== TARBALL_URL) return r;
      return {
        ...r,
        arrayBuffer: () =>
          new Promise<ArrayBuffer>((resolve, reject) => {
            if (init?.signal?.aborted) return reject(new Error("aborted"));
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            setTimeout(() => resolve(r.arrayBuffer()), 100);
          }),
      };
    };
    const code = await verifyLive({
      version: V,
      minutes: 0.001,
      requestTimeoutMs: 20,
      tarballTimeoutMs: 2_000,
      fetch: slowBody,
      ...fakeClock(),
      ...logs(),
    });
    expect(code).toBe(0);
  });

  it("never served within --minutes 0.05 → exit 2 with 'still not served'", async () => {
    const reg = fakeRegistry({
      doc: [{ status: 404 }],
      pack: [{ status: 404 }],
      tarball: [{ status: 404 }],
    });
    const l = logs();
    const code = await verifyLive({ version: V, minutes: 0.05, fetch: reg.fetch, ...fakeClock(), ...l });
    expect(code).toBe(2);
    expect(l.out.join("\n")).toMatch(/still not served/);
    // Not a corruption verdict and not a publish failure.
    expect(l.out.join("\n")).not.toMatch(/corruption signal/);
  });
});

describe("parseArgs", () => {
  it("takes a version and defaults to 90 minutes", () => {
    expect(parseArgs(["0.1.17"])).toEqual({ version: "0.1.17", minutes: 90 });
  });

  it("takes --minutes N and --minutes=N", () => {
    expect(parseArgs(["0.1.17", "--minutes", "5"])).toEqual({ version: "0.1.17", minutes: 5 });
    expect(parseArgs(["--minutes=0.5", "0.1.17"])).toEqual({ version: "0.1.17", minutes: 0.5 });
  });

  it("refuses a missing or malformed version, and a bad budget", () => {
    expect(() => parseArgs([])).toThrow(/usage/i);
    expect(() => parseArgs(["latest"])).toThrow(/version/i);
    expect(() => parseArgs(["0.1.17", "--minutes", "soon"])).toThrow(/minutes/i);
    expect(() => parseArgs(["0.1.17", "--minutes", "-1"])).toThrow(/minutes/i);
  });
});
