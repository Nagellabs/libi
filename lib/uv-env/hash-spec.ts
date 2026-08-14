import { createHash } from "crypto";

/** Deterministic signature for a `uv run --python X --with A --with B …`
 *  invocation. We hash the python version + the (sorted) list of pinned
 *  dependency specs so any change to either triggers a marker mismatch on
 *  the next call. Sorting means a refactor that reorders --with flags
 *  WITHOUT semantic change does NOT churn the signature.
 *
 *  Output is 16 hex chars (64 bits) — collision-resistant for our scale
 *  and short enough to embed in a token filename or log line. */
export function hashSpec(pythonVersion: string, withSpecs: readonly string[]): string {
  const parts = [`python:${pythonVersion}`, ...[...withSpecs].sort()];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}
