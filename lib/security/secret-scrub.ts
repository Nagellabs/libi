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
