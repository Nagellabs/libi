/**
 * Replace every occurrence of each configured secret in `text` with a mask, so
 * captured subprocess output (e.g. an MCP child's stderr) can be persisted /
 * surfaced without leaking API keys. Pure + allocation-cheap; safe on empty
 * inputs.
 *
 * @param text    Arbitrary captured text (may be empty).
 * @param secrets Secret values to redact (empty / falsy entries are ignored).
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  if (!text) return text;
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    // split/join replaces ALL occurrences without regex-escaping the secret.
    out = out.split(secret).join("••••");
  }
  return out;
}

/**
 * Blanket redaction for CLI output that is about to leave the server without
 * libi knowing any secret VALUE to scrub (the `/api/providers/*` routes never
 * hold a key). Masks the two shapes a failing `claude`/`codex` call could
 * echo back: a bearer token (`Bearer <token>` → `Bearer ***`) and a long
 * `=value` (16+ non-space chars, the floor of every provider key format →
 * `=***`). Deliberately coarse — a mangled error message costs nothing, a
 * leaked key does.
 */
export function redactCliOutput(text: string): string {
  if (!text) return text;
  return text.replace(/bearer\s+\S+/gi, "Bearer ***").replace(/=\S{16,}/g, "=***");
}

/**
 * Secret VALUES this process holds right now and must never let out: today the
 * templates creator key (lib/db/settings.ts registers it whenever it reads or
 * writes one). Key-name redaction — pino's `redact`, Sentry's
 * `SECRET_KEY_PATTERN` — cannot see a secret quoted inside a message string,
 * which is exactly where a failed query puts its parameters. So the logger's
 * last write (lib/logger.ts) and the Sentry scrubbers (lib/sentry/scrub.ts)
 * both pass their text through `redactLiveSecrets` as a backstop.
 *
 * On `globalThis`, not in a module variable: under Turbopack, instrumentation
 * (where Sentry and the logger are set up) and an API route (which reads the
 * key) can load two instances of this module — see
 * lib/server/lifecycle/mcp-http-handle.ts. No `node:*` import: this file is
 * bundled into the browser and Edge runtimes too.
 */
const LIVE_SECRETS_KEY = "__libiLiveSecrets_v1";
/** Old values stay secret after a newer one arrives (an imported key replaces a live one), up to this many. */
const MAX_LIVE_SECRETS = 16;
/** Shorter values would shred unrelated text; every secret registered here is far longer. */
const MIN_LIVE_SECRET_LENGTH = 16;

function liveSecrets(): string[] {
  const slot = globalThis as unknown as { [LIVE_SECRETS_KEY]?: string[] };
  return (slot[LIVE_SECRETS_KEY] ??= []);
}

/** Remember `value` as a secret every log line and Sentry payload must mask. Idempotent. */
export function registerLiveSecret(value: string | null | undefined): void {
  if (typeof value !== "string" || value.length < MIN_LIVE_SECRET_LENGTH) return;
  const list = liveSecrets();
  if (list.includes(value)) return;
  list.push(value);
  if (list.length > MAX_LIVE_SECRETS) list.splice(0, list.length - MAX_LIVE_SECRETS);
}

/** `text` with every registered secret replaced by `[redacted]`. Returns `text` itself when none occurs. */
export function redactLiveSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of liveSecrets()) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Tests only: forget every registered secret. */
export function resetLiveSecretsForTests(): void {
  liveSecrets().length = 0;
}
