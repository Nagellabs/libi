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
