import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import type { GET as GetType, PUT as PutType } from "@/app/api/settings/crash-reports/route";
import type {
  shouldSendCrashReports as ShouldSendCrashReportsType,
  getCrashReportChoice as GetCrashReportChoiceType,
  setCrashReportChoice as SetCrashReportChoiceType,
} from "@/lib/sentry/enabled";

// lib/sentry/config.ts#SENTRY_ENABLED is a module-load-time const derived
// from process.env.NEXT_PUBLIC_LIBI_SENTRY, so the build gate must be set
// BEFORE lib/sentry/enabled (and the route, which imports it) is first
// imported — same dance as __tests__/unit/sentry/gated-transport.test.ts.
// Without this, shouldSendCrashReports() would be hard-false regardless of
// the user's choice, and the "live gate moves" assertions below would be
// vacuous.
const ORIGINAL_ENV = { ...process.env };

let GET: typeof GetType;
let PUT: typeof PutType;
let shouldSendCrashReports: typeof ShouldSendCrashReportsType;
let getCrashReportChoice: typeof GetCrashReportChoiceType;
let setCrashReportChoice: typeof SetCrashReportChoiceType;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_LIBI_SENTRY = "1";
  ({ GET, PUT } = await import("@/app/api/settings/crash-reports/route"));
  ({ shouldSendCrashReports, getCrashReportChoice, setCrashReportChoice } = await import(
    "@/lib/sentry/enabled"
  ));
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

function putReq(body: unknown) {
  return new Request("http://x/api/settings/crash-reports", {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/api/settings/crash-reports", () => {
  beforeEach(() => {
    createTestDb();
    // The in-process gate cache (lib/sentry/enabled.ts) is a module-level
    // singleton independent of the DB — reset it so tests don't leak state
    // into each other.
    setCrashReportChoice("unset");
  });
  afterEach(() => resetTestDb());

  it("GET returns the default (unset, no decidedAt) on a fresh DB", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    // `killSwitched` is the RUNTIME view of LIBI_SENTRY_DISABLED, which a
    // prebuilt browser bundle cannot read for itself (Next inlines
    // NEXT_PUBLIC_* at build time). The route is the only place it can learn it.
    expect(json).toEqual({ choice: "unset", decidedAt: null, killSwitched: false });
  });

  it("PUT { choice: off } persists, returns choice off with a non-null decidedAt, and a following GET reflects it", async () => {
    const res = await PUT(putReq({ choice: "off" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choice).toBe("off");
    expect(typeof json.decidedAt).toBe("number");

    const get = await (await GET()).json();
    expect(get).toEqual({ choice: "off", decidedAt: json.decidedAt, killSwitched: false });
  });

  it("PUT { choice: on } round-trips the same way", async () => {
    const res = await PUT(putReq({ choice: "on" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choice).toBe("on");
    expect(typeof json.decidedAt).toBe("number");

    const get = await (await GET()).json();
    expect(get).toEqual({ choice: "on", decidedAt: json.decidedAt, killSwitched: false });
  });

  it("PUT { choice: unset } is rejected with 400 — not settable over HTTP", async () => {
    const res = await PUT(putReq({ choice: "unset" }));
    expect(res.status).toBe(400);
  });

  it("PUT with a bogus choice is rejected with 400", async () => {
    const res = await PUT(putReq({ choice: "maybe" }));
    expect(res.status).toBe(400);
  });

  it("PUT with malformed JSON is rejected with 400", async () => {
    const res = await PUT(putReq("{not json"));
    expect(res.status).toBe(400);
  });

  it("a successful PUT moves the live in-process gate immediately, with no restart", async () => {
    // Precondition: cache starts at "unset" (reset in beforeEach), which the
    // gate treats as enabled.
    expect(getCrashReportChoice()).toBe("unset");
    expect(shouldSendCrashReports()).toBe(true);

    await PUT(putReq({ choice: "off" }));

    // This is the core requirement of Task 3: the route must call
    // setCrashReportChoice so the module-level cache — and therefore the
    // live gate read by lib/sentry/scrub.ts's beforeSend hook — reflects the
    // new choice immediately. Persisting to the DB alone would leave this
    // cache (and shouldSendCrashReports()) unchanged until the next boot.
    expect(getCrashReportChoice()).toBe("off");
    expect(shouldSendCrashReports()).toBe(false);

    await PUT(putReq({ choice: "on" }));
    expect(getCrashReportChoice()).toBe("on");
    expect(shouldSendCrashReports()).toBe(true);
  });

  it("a 400 (invalid) PUT does NOT move the live gate", async () => {
    setCrashReportChoice("on");

    await PUT(putReq({ choice: "unset" }));
    expect(getCrashReportChoice()).toBe("on");

    await PUT(putReq({ choice: "bogus" }));
    expect(getCrashReportChoice()).toBe("on");

    await PUT(putReq("{not json"));
    expect(getCrashReportChoice()).toBe("on");
  });
});
