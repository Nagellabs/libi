import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import type {
  redactDeep as RedactDeep,
  redactPaths as RedactPaths,
  registerSensitiveValues as RegisterSensitiveValues,
  scrubEvent as ScrubEvent,
  scrubLog as ScrubLog,
  scrubSpan as ScrubSpan,
  scrubTransaction as ScrubTransaction,
} from "@/lib/sentry/scrub";
import type { setCrashReportChoice as SetCrashReportChoice } from "@/lib/sentry/enabled";

// These tests lock down the two privacy guarantees the Sentry integration
// promises: NO user identity and NO secrets ever leave the machine.
//
// scrubEvent/scrubLog now gate on lib/sentry/enabled.ts#shouldSendCrashReports,
// which reads the build gate (lib/sentry/config.ts#SENTRY_ENABLED) at MODULE
// LOAD time from process.env.NEXT_PUBLIC_LIBI_SENTRY. That env var is unset by
// default in the test environment, so every test in this file that exercises
// "still scrubs when enabled" behavior needs the build gate on. The env var
// must be set BEFORE lib/sentry/scrub.ts is first imported (static imports are
// hoisted ahead of any beforeAll-set env), so this file loads the module under
// test dynamically, once, in beforeAll — same pattern as
// __tests__/unit/sentry/native-crash.test.ts.
//
// Restored in afterAll: safe under vitest's current per-file isolation, but
// __tests__/unit/sentry/{enabled,native-crash}.test.ts both restore via this
// same ORIGINAL_ENV pattern on principle — leaving this file as the one
// exception would silently turn the build gate on for every file sharing this
// worker if isolation config ever changed.
const ORIGINAL_ENV = { ...process.env };

let redactDeep: typeof RedactDeep;
let redactPaths: typeof RedactPaths;
let registerSensitiveValues: typeof RegisterSensitiveValues;
let scrubEvent: typeof ScrubEvent;
let scrubLog: typeof ScrubLog;
let scrubSpan: typeof ScrubSpan;
let scrubTransaction: typeof ScrubTransaction;
let setCrashReportChoice: typeof SetCrashReportChoice;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_LIBI_SENTRY = "1";
  const scrub = await import("@/lib/sentry/scrub");
  const enabled = await import("@/lib/sentry/enabled");
  ({
    redactDeep,
    redactPaths,
    registerSensitiveValues,
    scrubEvent,
    scrubLog,
    scrubSpan,
    scrubTransaction,
  } = scrub);
  ({ setCrashReportChoice } = enabled);
  // Build gate on + user preference "unset" == enabled — the out-of-the-box
  // state every pre-existing test in this file assumes.
  setCrashReportChoice("unset");
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("redactDeep", () => {
  it("redacts values of secret-looking keys (case-insensitive, nested)", () => {
    const input = {
      ANTHROPIC_API_KEY: "sk-ant-123",
      Authorization: "Bearer xyz",
      nested: { password: "hunter2", refreshToken: "r-abc", safe: "keep-me" },
      list: [{ apiKey: "k1" }, { ok: "v" }],
    };
    redactDeep(input);
    expect(input.ANTHROPIC_API_KEY).toBe("[redacted]");
    expect(input.Authorization).toBe("[redacted]");
    expect(input.nested.password).toBe("[redacted]");
    expect(input.nested.refreshToken).toBe("[redacted]");
    expect(input.nested.safe).toBe("keep-me");
    expect(input.list[0]).toEqual({ apiKey: "[redacted]" });
    expect(input.list[1]).toEqual({ ok: "v" });
  });

  it("scrubs secret-looking values even under innocent keys", () => {
    const input = {
      note: "token is Bearer abc.def.ghi here",
      jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36",
      openai: "sk-ABCDEFGHIJKLMNOP1234",
      plain: "nothing to see",
    };
    redactDeep(input);
    expect(input.note).toContain("[redacted]");
    expect(input.note).not.toContain("Bearer abc");
    expect(input.jwt).toBe("[redacted]");
    expect(input.openai).toBe("[redacted]");
    expect(input.plain).toBe("nothing to see");
  });

  it("does not blow up on null / depth", () => {
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep("plain")).toBe("plain");
  });
});

describe("scrubEvent", () => {
  it("drops user identity and request identifiers", () => {
    const event = {
      user: { id: "u1", email: "a@b.com", ip_address: "1.2.3.4" },
      server_name: "my-laptop",
      request: {
        url: "https://app/x",
        method: "POST",
        cookies: { session: "abc" },
        headers: { authorization: "Bearer t" },
        query_string: "token=secret",
        data: { apiKey: "k" },
      },
    } as never;
    const out = scrubEvent(event)! as Record<string, unknown>;
    expect(out.user).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    const req = out.request as Record<string, unknown>;
    expect(req.cookies).toBeUndefined();
    expect(req.headers).toBeUndefined();
    expect(req.query_string).toBeUndefined();
    // URL/method are non-identifying and kept; body is scrubbed.
    expect(req.url).toBe("https://app/x");
    expect(req.data).toEqual({ apiKey: "[redacted]" });
  });

  it("redacts secrets in extra / contexts / breadcrumbs", () => {
    const event = {
      extra: { dbPassword: "p" },
      contexts: { app: { secret: "s", build: "1.0" } },
      breadcrumbs: [{ message: "logged in with Bearer abc123", data: { token: "t" } }],
    } as never;
    const out = scrubEvent(event)! as Record<string, unknown>;
    expect((out.extra as Record<string, unknown>).dbPassword).toBe("[redacted]");
    const app = (out.contexts as Record<string, Record<string, unknown>>).app;
    expect(app.secret).toBe("[redacted]");
    expect(app.build).toBe("1.0");
    const crumb = (out.breadcrumbs as Array<Record<string, unknown>>)[0];
    expect(crumb.message).not.toContain("Bearer abc123");
    expect((crumb.data as Record<string, unknown>).token).toBe("[redacted]");
  });
});

describe("scrubLog", () => {
  it("redacts secret attributes and message tokens", () => {
    const log = {
      level: "info",
      message: "starting with sk-ABCDEFGHIJKLMNOP1234",
      attributes: { apiKey: "k", userId: 100 },
    } as never;
    const out = scrubLog(log)! as Record<string, unknown>;
    expect(out.message).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
    const attrs = out.attributes as Record<string, unknown>;
    expect(attrs.apiKey).toBe("[redacted]");
    expect(attrs.userId).toBe(100);
  });

  it("strips the OS user name and media file names from log messages", () => {
    const log = {
      level: "info",
      message:
        "ffmpeg.start proxy_gen /Users/jane/.libi/storage/p1/Family Trip 2026.mp4",
      attributes: {},
    } as never;
    const out = scrubLog(log)! as Record<string, unknown>;
    expect(out.message).not.toContain("jane");
    expect(out.message).not.toContain("Family Trip 2026");
  });
});

// These are the sections redactDeep never reaches, and they are exactly where
// desktop crashes leak the OS user name and the user's own media file names.
describe("path redaction (identity + user content)", () => {
  it("rewrites home directories on macOS, Linux and Windows", () => {
    expect(redactPaths("/Users/jane/dev/libi/lib/x.ts")).toBe(
      "/Users/[user]/dev/libi/lib/x.ts",
    );
    expect(redactPaths("/home/jane/dev/x.ts")).toBe("/home/[user]/dev/x.ts");
    expect(redactPaths("C:\\Users\\jane\\dev\\x.ts")).toBe(
      "C:\\Users\\[user]\\dev\\x.ts",
    );
  });

  it("keeps the path useful for debugging (only the user segment goes)", () => {
    const out = redactPaths("/Users/jane/dev/libi/lib/engine/renderer.ts");
    expect(out).toContain("lib/engine/renderer.ts");
    expect(out).not.toContain("jane");
  });

  it("redacts user media file names under the libi storage dir", () => {
    const out = redactPaths("/Users/jane/.libi/storage/piece-1/Wedding Speech.mp4");
    expect(out).not.toContain("Wedding Speech");
    expect(out).not.toContain("jane");
  });

  it("leaves ordinary strings alone", () => {
    expect(redactPaths("nothing to see here")).toBe("nothing to see here");
  });

  // Regression: live QA on a real machine caught what the patterns alone miss.
  // The canonical `/Users/x/` patterns cannot recognise a re-encoded home path,
  // and macOS temp dirs carry a per-user token with no username in them at all.
  describe("registered literal values", () => {
    afterEach(() => registerSensitiveValues({ paths: [], userNames: [] }));

    it("censors a slugified home path the patterns cannot match", () => {
      registerSensitiveValues({ userNames: ["jane"] });
      const out = redactPaths("/private/tmp/-Users-jane-Documents-dev/x.ts");
      expect(out).not.toContain("jane");
    });

    it("censors the macOS per-user temp token", () => {
      const tmp = "/var/folders/66/ab_cd1234ef567ghijklmnop0000gn/T";
      registerSensitiveValues({ paths: [tmp] });
      expect(redactPaths(`${tmp}/libi-render/frame.png`)).toBe(
        "[path]/libi-render/frame.png",
      );
    });

    it("censors the longest registered path first", () => {
      // Deliberately NOT under /Users or /home: the canonical-pattern pass runs
      // before the literal pass, so a path it already rewrote would never reach
      // the literals. Either way the identity is removed — this test is about
      // ordering *among literals*, so it uses a prefix the patterns ignore.
      registerSensitiveValues({ paths: ["/srv/box", "/srv/box/libi"] });
      expect(redactPaths("/srv/box/libi/x")).toBe("[path]/x");
    });

    it("only matches a user name as a delimited token", () => {
      registerSensitiveValues({ userNames: ["sam"] });
      // Real occurrence → censored.
      expect(redactPaths("/data/sam/notes")).not.toContain("/sam/");
      // Substring of an unrelated word → left alone, so traces stay readable.
      expect(redactPaths("the same sample")).toBe("the same sample");
    });

    it("ignores absurdly short user names that would shred text", () => {
      registerSensitiveValues({ userNames: ["j"] });
      expect(redactPaths("j is a letter")).toBe("j is a letter");
    });
  });

  it("scrubs event.message, exception values and stack frames", () => {
    const event = {
      message: "failed reading /Users/jane/.libi/storage/p1/Secret Project.mov",
      exception: {
        values: [
          {
            value: "ENOENT: /Users/jane/.libi/storage/p1/Secret Project.mov",
            stacktrace: {
              frames: [
                {
                  filename: "/Users/jane/dev/libi/lib/ffmpeg/exec.ts",
                  abs_path: "/Users/jane/dev/libi/lib/ffmpeg/exec.ts",
                },
              ],
            },
          },
        ],
      },
    } as never;

    const out = scrubEvent(event)! as Record<string, never>;
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("jane");
    expect(serialised).not.toContain("Secret Project");
    // …but the frame is still attributable to a file in the repo.
    expect(serialised).toContain("lib/ffmpeg/exec.ts");
  });
});

// The crash-report opt-out gate (lib/sentry/enabled.ts). Full precedence
// (kill-switch / build-gate / "unset" defaults to enabled) is covered in
// __tests__/unit/sentry/enabled.test.ts; these tests are about the two
// beforeSend/beforeSendLog CALL SITES specifically: the gate check must run
// FIRST (an event dropped for privacy reasons should do zero redaction work),
// and — the critical privacy invariant — it must never short-circuit the
// scrubber when reporting IS allowed.
describe("crash-report gate (scrubEvent / scrubLog)", () => {
  afterEach(() => {
    // Restore the file's default "enabled" state for every other test.
    setCrashReportChoice("unset");
  });

  it("scrubEvent returns null once the user has explicitly opted out", () => {
    setCrashReportChoice("off");
    const event = { message: "boom" } as never;
    expect(scrubEvent(event)).toBeNull();
  });

  it("scrubLog returns null once the user has explicitly opted out", () => {
    setCrashReportChoice("off");
    const log = { level: "info", message: "boom", attributes: {} } as never;
    expect(scrubLog(log)).toBeNull();
  });

  it("scrubEvent still fully scrubs when reporting is enabled — the gate cannot bypass the scrubber", () => {
    setCrashReportChoice("on");
    const event = {
      message: "failed reading /Users/jane/.libi/storage/p1/Secret Project.mov",
      extra: { apiKey: "sk-ABCDEFGHIJKLMNOP1234" },
    } as never;
    const out = scrubEvent(event);
    expect(out).not.toBeNull();
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("jane");
    expect(serialised).not.toContain("Secret Project");
    expect(serialised).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
    expect(serialised).toContain("[redacted]");
  });

  it("scrubLog still fully scrubs when reporting is enabled — the gate cannot bypass the scrubber", () => {
    setCrashReportChoice("on");
    const log = {
      level: "info",
      message: "ffmpeg.start proxy_gen /Users/jane/.libi/storage/p1/Family Trip 2026.mp4",
      attributes: { apiKey: "sk-ABCDEFGHIJKLMNOP1234" },
    } as never;
    const out = scrubLog(log);
    expect(out).not.toBeNull();
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("jane");
    expect(serialised).not.toContain("Family Trip 2026");
    expect(serialised).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
  });

  it("unset (no user choice made yet) still allows reporting, unchanged", () => {
    setCrashReportChoice("unset");
    const event = { message: "boom" } as never;
    expect(scrubEvent(event)).not.toBeNull();
  });
});

// The performance-tracing half of the privacy surface. `beforeSend` /
// `beforeSendLog` never see transactions or spans, so these two hooks are the
// only thing standing between tracing data and Sentry.
//
// The asymmetry between them is deliberate and load-bearing (see
// lib/sentry/scrub.ts): `scrubTransaction` CAN drop (it returns null when the
// user has opted out), `scrubSpan` structurally CANNOT — @sentry/core treats a
// falsy `beforeSendSpan` return as "keep the original span and warn", so
// returning null there would suppress nothing and spam the console. The
// opt-out for spans is enforced at the transport instead
// (lib/sentry/gated-transport.ts, covered in gated-transport.test.ts).
describe("scrubTransaction", () => {
  afterEach(() => {
    setCrashReportChoice("unset");
  });

  it("returns null once the user has explicitly opted out", () => {
    setCrashReportChoice("off");
    const event = { type: "transaction", transaction: "GET /api/pieces" } as never;
    expect(scrubTransaction(event)).toBeNull();
  });

  it("strips identity (user / server_name / request headers) when reporting is enabled", () => {
    setCrashReportChoice("on");
    const event = {
      type: "transaction",
      transaction: "GET /api/pieces",
      user: { id: "u-1", email: "jane@example.com", ip_address: "203.0.113.7" },
      server_name: "janes-macbook.local",
      request: {
        url: "http://localhost:3000/api/pieces",
        method: "GET",
        headers: { cookie: "session=abc", authorization: "Bearer tok" },
        cookies: { session: "abc" },
        query_string: "q=secret",
        env: { REMOTE_ADDR: "203.0.113.7" },
      },
    } as never;

    const out = scrubTransaction(event)! as unknown as Record<string, unknown>;
    expect(out.user).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    const request = out.request as Record<string, unknown>;
    expect(request.headers).toBeUndefined();
    expect(request.cookies).toBeUndefined();
    expect(request.query_string).toBeUndefined();
    expect(request.env).toBeUndefined();
    // Non-identifying, genuinely useful fields survive.
    expect(request.url).toBe("http://localhost:3000/api/pieces");
    expect(request.method).toBe("GET");

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("jane@example.com");
    expect(serialised).not.toContain("janes-macbook");
    expect(serialised).not.toContain("203.0.113.7");
  });

  it("redacts a home path in `transaction` and a secret inside spans[].data", () => {
    setCrashReportChoice("on");
    const event = {
      type: "transaction",
      transaction: "export /Users/jane/.libi/storage/p1/Secret Project.mov",
      spans: [
        {
          description: "ffmpeg /Users/jane/.libi/storage/p1/Secret Project.mov",
          data: { apiKey: "sk-ABCDEFGHIJKLMNOP1234", op: "export_overlay_render" },
        },
      ],
    } as never;

    const out = scrubTransaction(event)! as unknown as Record<string, unknown>;
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("jane");
    expect(serialised).not.toContain("Secret Project");
    expect(serialised).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
    // Still attributable — the op name is untouched.
    expect(serialised).toContain("export_overlay_render");
  });

  it("uses redactString (not just path redaction) on `transaction`, so secrets in a span name go too", () => {
    setCrashReportChoice("on");
    const event = {
      type: "transaction",
      transaction: "POST /hook?auth=Bearer abcDEF123456",
    } as never;
    const out = scrubTransaction(event)! as unknown as Record<string, unknown>;
    expect(out.transaction).not.toContain("abcDEF123456");
    expect(out.transaction).toContain("[redacted]");
  });
});

describe("scrubSpan", () => {
  afterEach(() => {
    setCrashReportChoice("unset");
  });

  it("never returns null — it structurally cannot gate (see lib/sentry/scrub.ts)", () => {
    setCrashReportChoice("off");
    const span = { description: "ui.interaction.click body > div#app", data: {} } as never;
    const out = scrubSpan(span);
    expect(out).not.toBeNull();
    expect(out).toBe(span);
  });

  it("redacts description and data when reporting is enabled", () => {
    setCrashReportChoice("on");
    const span = {
      description: "ffmpeg /Users/jane/.libi/storage/p1/Family Trip 2026.mp4",
      data: {
        authorization: "Bearer tok-123",
        "http.url": "/Users/jane/dev/libi/out.mp4",
        op: "proxy_gen",
      },
    } as never;

    const out = scrubSpan(span) as unknown as Record<string, unknown>;
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("jane");
    expect(serialised).not.toContain("Family Trip 2026");
    expect(serialised).not.toContain("tok-123");
    expect(serialised).toContain("proxy_gen");
  });
});

// Drift guard for the finding that motivated these tests: `scrubTransaction`
// used to hand-duplicate ~35 lines of `scrubEvent`'s identity/secret logic, so
// a field newly redacted in one could silently stay un-redacted in the other.
// Both now delegate to one shared `scrubCommonEventFields`; this asserts they
// treat the shared sections identically, which fails if either grows its own
// private copy again.
describe("scrubEvent / scrubTransaction share one identity+secret pass", () => {
  afterEach(() => {
    setCrashReportChoice("unset");
  });

  it("treats the common sections identically for an otherwise-identical payload", () => {
    setCrashReportChoice("on");
    const payload = () =>
      ({
        message: "boom /Users/jane/.libi/storage/p1/Clip.mov",
        user: { id: "u-1", email: "jane@example.com" },
        server_name: "janes-macbook.local",
        request: {
          url: "/x",
          method: "GET",
          headers: { cookie: "c" },
          cookies: { c: "1" },
          query_string: "q=1",
          env: { REMOTE_ADDR: "1.2.3.4" },
          data: { password: "hunter2" },
        },
        contexts: { app: { token: "t-1" } },
        extra: { apiKey: "sk-ABCDEFGHIJKLMNOP1234" },
        tags: { secret: "s-1" },
        breadcrumbs: [
          { message: "read /Users/jane/.libi/storage/p1/Clip.mov", data: { authorization: "a" } },
        ],
      }) as never;

    const fromEvent = scrubEvent(payload())! as unknown as Record<string, unknown>;
    const fromTransaction = scrubTransaction(payload())! as unknown as Record<string, unknown>;

    // Compared WHOLE rather than field-by-field on purpose: a hardcoded field
    // list would not notice a newly redacted field added to only one hook.
    // Scope, honestly: this only detects drift on sections the fixture below
    // actually carries (message/request/contexts/extra/tags/breadcrumbs/user/
    // server_name). A hook gaining divergent handling of a field absent from
    // this payload passes unnoticed — extend the fixture when scrub.ts learns
    // a new section. Only the two genuinely kind-specific sections are
    // excluded — `exception` (errors only) and `transaction`/`spans`/`type`
    // (transactions only).
    const KIND_SPECIFIC = new Set(["exception", "transaction", "spans", "type"]);
    const common = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).filter(([k]) => !KIND_SPECIFIC.has(k)));

    expect(common(fromTransaction)).toEqual(common(fromEvent));
    // Sanity: the payload really did carry the shared sections, so an
    // accidentally-empty comparison can't pass vacuously.
    expect(Object.keys(common(fromEvent)).sort()).toEqual([
      "breadcrumbs",
      "contexts",
      "extra",
      "message",
      "request",
      "tags",
    ]);
  });
});
