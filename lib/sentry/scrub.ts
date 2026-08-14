// Shared, runtime-agnostic privacy scrubbers for Sentry (client, server, edge).
//
// Two hard guarantees enforced here, BEFORE any event leaves the machine:
//   1. No user identification — user context is dropped and request-level
//      identifiers (cookies, headers, query strings, IPs) are removed.
//   2. No keys/secrets — any object key that looks like a credential has its
//      value redacted, recursively, across the whole event/log payload.
//
// This is defense-in-depth. It runs IN ADDITION to:
//   - `sendDefaultPii: false` (SDK never attaches IP/headers/cookies),
//   - never calling `Sentry.setUser()`,
//   - `includeLocalVariables: false` (server stack frames omit locals),
//   - Sentry's own server-side data scrubbing,
//   - pino's `redact` paths at the logging source.
//
// Pure TypeScript with no Node/DOM APIs so it is safe to bundle into the
// client and Edge runtimes as well as Node — but NOT dependency-free: it
// reads process-wide gate state via `./enabled`'s `shouldSendCrashReports()`
// (an in-memory cache seeded at boot, no I/O), so every export below can
// drop its payload when the user has opted out. (Type-only Sentry imports
// are erased at compile time and don't affect this.)
import type { ErrorEvent, EventHint, Log } from "@sentry/nextjs";
import type * as Sentry from "@sentry/nextjs";

import { shouldSendCrashReports } from "./enabled";

// `SpanJSON` and `TransactionEvent` are real types in @sentry/core, but
// @sentry/nextjs's public `.d.ts` only re-exports a curated subset of
// @sentry/core's types (verified against node_modules — neither name is in
// it), so `import type { SpanJSON, TransactionEvent } from "@sentry/nextjs"`
// does not resolve. Rather than reach into the undeclared `@sentry/core`
// transitive dependency directly, derive the two shapes structurally from
// `Sentry.init`'s own (fully public) options type — the same technique,
// applied to the two hooks these types belong to.
type InitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
type TransactionEvent = Parameters<NonNullable<InitOptions["beforeSendTransaction"]>>[0];
type SpanJSON = Parameters<NonNullable<InitOptions["beforeSendSpan"]>>[0];

const REDACTED = "[redacted]";

// Object keys whose VALUES must never be sent. Matched case-insensitively as a
// substring, so `apiKey`, `X-Api-Key`, `ANTHROPIC_API_KEY`, `set-cookie`, etc.
// all match. Keep this list conservative-but-broad — over-redacting a value is
// always safer than leaking a secret.
const SECRET_KEY_PATTERN =
  /(authorization|api[-_]?key|token|secret|password|passwd|credential|cookie|session[-_]?id|set-cookie|bearer|private[-_]?key|client[-_]?secret|dsn|sentry[-_]?auth|x-api-key|webhook|signature|salt|otp|mfa)/i;

// Value patterns that look like a secret even when the key name is innocent
// (e.g. a token pasted into a free-text message). Conservative on purpose so we
// don't shred useful stack traces.
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._\-]+/gi, // Authorization: Bearer <jwt>
  /\bsntrys_[A-Za-z0-9._\-]+/g, // Sentry auth tokens
  /\bsk-[A-Za-z0-9]{16,}/g, // OpenAI-style secret keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];

// Absolute filesystem paths are personal data on a desktop machine, in two
// distinct ways, and BOTH used to travel to Sentry:
//
//   1. The home directory carries the OS user name — `/Users/jane/...`. It
//      appears in every stack frame (`filename` / `abs_path`) of every crash.
//   2. Anything under the libi storage dir is USER CONTENT — the tail is the
//      file name the user chose for their own media. These reach us via
//      ffmpeg argv in structured logs (`lib/ffmpeg/exec.ts` summarises args by
//      TRUNCATING long ones, which does not redact them).
//
// We rewrite rather than drop, so a stack trace stays useful for debugging:
// `/Users/jane/dev/libi/lib/x.ts` → `/Users/[user]/dev/libi/lib/x.ts`.
const HOME_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/(\/Users\/)[^/\\\s:"']+/g, "$1[user]"], // macOS
  [/(\/home\/)[^/\\\s:"']+/g, "$1[user]"], // Linux
  [/([A-Za-z]:\\Users\\)[^\\/\s:"']+/g, "$1[user]"], // Windows
];

// The user's own media file names live under `<libi home>/storage/...`.
const STORAGE_PATH_PATTERN = /((?:\.libi|libi)[/\\]storage[/\\])[^\s:"'`)]+/gi;

// …and they appear a SECOND way, with no filesystem path anywhere in sight:
// libi serves media at `/api/files/{pieceId}/{filename}` and
// `/api/files/global/{filename}`, so the URL itself carries the name the user
// chose for their own video. None of the path patterns above can see it.
//
// That matters because `scrubCommonEventFields` deliberately KEEPS
// `request.url` (it is genuinely useful and normally non-identifying), and
// Next also copies the same value into `contexts.nextjs.request_path`. The
// carrier is the 10%-sampled server transaction. The Privacy tab states
// plainly that "your media file names are removed", so scrubbing is the fix
// rather than rewording the promise.
//
// `by-id` is excluded on purpose: `/api/files/by-id/{uuid}/content` is an
// opaque identifier with no user content in it, and keeping those URLs intact
// is what makes a 500 on that route debuggable at all.
const FILE_URL_PATTERN =
  /(\/api\/files\/)(?!by-id(?:\/|$))([^/?#\s"'`]+)\/([^/?#\s"'`]+)/gi;

// Pattern matching alone is not enough, and live QA against a real machine is
// what proved it: the patterns above only recognise the CANONICAL `/Users/x/`
// shape, so a path where the home directory has been slugified or re-encoded
// (seen in a real tool's temp path) sails straight through. macOS temp dirs
// are a second case — `/var/folders/66/ab_cd…/T` contains no username but
// does contain a stable PER-USER token, and that is exactly where the export
// backends do their work.
//
// So Node runtimes additionally register the literal values to censor. This
// module stays free of Node APIs (it is bundled into the browser and Edge too),
// hence injection rather than importing `os` here.
let literalHomePaths: string[] = [];
let literalUserNames: string[] = [];

/**
 * Register machine-specific values that must never leave the device. Call from
 * a Node runtime with `os.homedir()`, `os.tmpdir()` and `os.userInfo().username`.
 * Safe to call repeatedly; last call wins.
 */
export function registerSensitiveValues(input: {
  paths?: Array<string | undefined | null>;
  userNames?: Array<string | undefined | null>;
}): void {
  const clean = (xs: Array<string | undefined | null> | undefined, min: number) =>
    (xs ?? [])
      .filter((x): x is string => typeof x === "string" && x.trim().length >= min)
      // Longest first, so `/Users/jane/.libi` is censored before `/Users/jane`.
      .sort((a, b) => b.length - a.length);

  literalHomePaths = clean(input.paths, 4);
  // Guard against absurdly short usernames ("j") shredding unrelated text.
  literalUserNames = clean(input.userNames, 3);
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip identity and user content out of filesystem paths embedded in any
 * string. Exported for unit testing.
 */
export function redactPaths(value: string): string {
  let out = value;

  // 1. Canonical home-directory shapes (works in every runtime, no registration).
  for (const [pattern, replacement] of HOME_PATH_PATTERNS) {
    out = out.replace(pattern, replacement);
  }

  // 2. Literal machine paths registered by the Node runtime — catches re-encoded
  //    forms and the per-user macOS temp token that no pattern can anticipate.
  for (const p of literalHomePaths) {
    out = out.split(p).join("[path]");
  }

  // 3. The bare user name, but ONLY as a delimited token, so a username that
  //    happens to be a common word cannot shred unrelated text.
  for (const name of literalUserNames) {
    out = out.replace(
      new RegExp(`(^|[^A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, "g"),
      "$1[user]",
    );
  }

  // 4. Anything under the libi storage dir is the user's own media.
  out = out.replace(STORAGE_PATH_PATTERN, "$1[redacted]");

  // 5. …and so is the last segment of a media-serving URL.
  return out.replace(FILE_URL_PATTERN, "$1$2/[redacted]");
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return redactPaths(out);
}

const MAX_DEPTH = 8;

/**
 * Recursively redact secret-looking keys and scrub secret-looking values from
 * an arbitrary JSON-ish structure. Returns the same reference for objects so it
 * can mutate in place on the Sentry payload.
 */
export function redactDeep<T>(input: T, depth = 0): T {
  if (depth > MAX_DEPTH || input == null) return input;

  if (typeof input === "string") {
    return redactString(input) as unknown as T;
  }

  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      input[i] = redactDeep(input[i], depth + 1);
    }
    return input;
  }

  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        obj[key] = REDACTED;
      } else {
        obj[key] = redactDeep(obj[key], depth + 1);
      }
    }
    return input;
  }

  return input;
}

/**
 * The identity + secret scrubbing that is IDENTICAL for error events and
 * transaction events. Both shapes carry the same identifying/secret-bearing
 * sections (`user`, `server_name`, `request`, `contexts`, `extra`, `tags`,
 * `breadcrumbs`, `message`), so this lives in exactly one place — the two
 * public hooks below used to hand-duplicate ~35 lines of it, which meant a
 * newly-redacted field could silently be added to one and not the other.
 *
 * Generic (rather than taking a union) so each caller gets its own event type
 * back unchanged. Mutates in place and returns the same reference.
 */
function scrubCommonEventFields<T extends ErrorEvent | TransactionEvent>(event: T): T {
  // 1. Identity: drop anything that could identify the user.
  delete event.user;
  delete event.server_name;

  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers; // may carry auth/cookies/UA
    delete event.request.query_string;
    delete event.request.env; // can carry REMOTE_ADDR
    // Keep request.url/method — genuinely useful, and normally
    // non-identifying — but SCRUB the url, because libi serves user media at
    // `/api/files/{pieceId}/{filename}` and the last segment is the name the
    // user gave their own video. `redactDeep` never reaches this field (it
    // covers `contexts` / `extra` / `tags`, not `request.url`), so it has to
    // be named explicitly, exactly like `event.message` below.
    if (typeof event.request.url === "string") {
      event.request.url = redactString(event.request.url);
    }
    if (event.request.data !== undefined) {
      event.request.data = redactDeep(event.request.data);
    }
  }

  // 2. Secrets: redact across the free-form payload sections.
  if (event.contexts) redactDeep(event.contexts);
  if (event.extra) redactDeep(event.extra);
  if (event.tags) redactDeep(event.tags);
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (crumb.data) crumb.data = redactDeep(crumb.data);
      if (typeof crumb.message === "string") {
        crumb.message = redactString(crumb.message);
      }
    }
  }

  // 3. redactDeep above never reaches the message — and on a desktop crash it
  //    is one of the sections that actually carries the OS user name and user
  //    media file names, so it is scrubbed explicitly.
  if (typeof event.message === "string") {
    event.message = redactString(event.message);
  }

  return event;
}

/**
 * `beforeSend` hook — strips identity and scrubs secrets from an error event.
 * Wired into every runtime's `Sentry.init`. Mutates and returns the event, or
 * returns `null` (Sentry's "drop this event" signal) when the crash-report
 * gate (`lib/sentry/enabled.ts#shouldSendCrashReports`) is closed — checked
 * FIRST, before any scrubbing, so a disabled event does no redaction work at
 * all. When the gate is open, everything below runs exactly as before.
 *
 * Note the gate here is belt-and-braces since `lib/sentry/gated-transport.ts`
 * now refuses the network request for EVERY envelope type while opted out;
 * this hook remains the cheaper, earlier stop for error events specifically,
 * and the only one that also skips the scrubbing work.
 */
export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  if (!shouldSendCrashReports()) return null;

  scrubCommonEventFields(event);

  // The error itself — same reasoning as the message above: redactDeep never
  // reaches stack frames, and they are exactly where the OS user name lives.
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === "string") {
      value.value = redactString(value.value);
    }
    for (const frame of value.stacktrace?.frames ?? []) {
      if (typeof frame.filename === "string") {
        frame.filename = redactPaths(frame.filename);
      }
      if (typeof frame.abs_path === "string") {
        frame.abs_path = redactPaths(frame.abs_path);
      }
      if (typeof frame.module === "string") {
        frame.module = redactPaths(frame.module);
      }
    }
  }

  return event;
}

/**
 * `beforeSendLog` hook — scrubs structured-log attributes and message before a
 * Sentry log is shipped. Mutates and returns the log, or returns `null`
 * ("drop this log") when the crash-report gate is closed — checked FIRST, see
 * `scrubEvent` above for the full rationale.
 */
export function scrubLog(log: Log): Log | null {
  if (!shouldSendCrashReports()) return null;

  if (log.attributes) redactDeep(log.attributes);
  if (typeof log.message === "string") {
    log.message = redactString(log.message) as Log["message"];
  }
  return log;
}

/**
 * `beforeSendTransaction` hook — the gate + scrubber for performance-tracing
 * data. `beforeSend`/`beforeSendLog` above only ever see error events and
 * structured logs; transactions (and, in the SDK's default non-streamed
 * trace lifecycle, every span nested under them via `event.spans[]`) travel
 * through THIS hook instead, so without it a user who opted out still shipped
 * transaction names, URLs, and span descriptions at `tracesSampleRate`.
 * `TransactionEvent` shares the same identity/secret-bearing shape as
 * `ErrorEvent` (`user`, `server_name`, `request`, `contexts`, `extra`,
 * `tags`, `breadcrumbs`), so the shared `scrubCommonEventFields` above covers
 * those; this adds `transaction` (the route/span name) and each nested span.
 * Checked FIRST, before any scrubbing, same rationale as `scrubEvent`.
 *
 * Standalone spans — accurately. A "standalone" span (the SDK's term for a span
 * emitted outside any transaction — e.g. the browser INP Web Vital, whose span
 * name is a DOM tree path from `htmlTreeAsString(entry.target)`) does NOT reach
 * this hook: it is not a transaction event, and it ships via
 * `sendSpanEnvelope()` → `client.sendEnvelope()`
 * (@sentry/core/build/cjs/tracing/sentrySpan.js:234, 326-341). Two consequences,
 * neither more nor less:
 *   - SCRUBBED: yes. `createSpanEnvelope` applies `beforeSendSpan` while
 *     serializing each span (@sentry/core/build/cjs/envelope.js:69-77), so
 *     `scrubSpan` below does redact standalone spans in the enabled state.
 *     (Exception: with span streaming enabled — `spanStreamingIntegration`,
 *     not installed here — that call is skipped for streamed callbacks.)
 *   - GATED: not by any `beforeSend*` hook. `beforeSendSpan` structurally
 *     cannot drop a span (see `scrubSpan`). The opt-out is enforced for these
 *     at the transport instead — `lib/sentry/gated-transport.ts`, which sits on
 *     `Client.sendEnvelope`'s single `_transport.send` call and so covers
 *     standalone spans, release-health sessions, and every other envelope type.
 */
export function scrubTransaction(
  event: TransactionEvent,
  _hint?: EventHint,
): TransactionEvent | null {
  if (!shouldSendCrashReports()) return null;

  scrubCommonEventFields(event);

  // `redactString` (not `redactPaths`) so the route/span name gets the secret
  // patterns too — same treatment as `event.message` and `span.description`.
  if (typeof event.transaction === "string") {
    event.transaction = redactString(event.transaction);
  }

  for (const span of event.spans ?? []) {
    scrubSpanFields(span);
  }

  return event;
}

/**
 * `beforeSendSpan` hook. Unlike every hook above, this one CANNOT drop a
 * span: verified against @sentry/core's `processBeforeSend` (`client.js`) —
 * a falsy return is treated as "keep the original span, just warn"
 * (`if (!processedSpan) { showSpanDropWarning(); processedSpans.push(span);
 * }`), so returning `null` here would fail to suppress anything AND spam a
 * console warning on every span. This hook is therefore scrub-only, never a
 * gate — deliberately, not an oversight. The actual off-switch for
 * transaction-nested spans is `scrubTransaction` above, which drops the
 * whole event (spans included, in the SDK's default non-streamed trace
 * lifecycle); for STANDALONE spans, which no hook can drop, it is
 * `lib/sentry/gated-transport.ts`. This hook is reached for both kinds
 * (transaction-nested via `beforeSendTransaction`'s event, standalone via
 * `createSpanEnvelope` — see `scrubTransaction`'s note), so it is where
 * standalone spans actually get redacted.
 */
export function scrubSpan(span: SpanJSON): SpanJSON {
  if (!shouldSendCrashReports()) return span;
  return scrubSpanFields(span);
}

function scrubSpanFields(span: SpanJSON): SpanJSON {
  if (typeof span.description === "string") {
    span.description = redactString(span.description);
  }
  if (span.data) redactDeep(span.data);
  return span;
}
