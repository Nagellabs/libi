import crypto from "node:crypto";

/**
 * Compute a stable SHA-256 hex digest of `params`. Used as the idempotency
 * key in the jobs table.
 *
 * Rules:
 * - Object keys are sorted before serialization.
 * - Arrays preserve order.
 * - `undefined` is stripped (matches JSON semantics).
 * - Non-finite numbers (`NaN`, `Infinity`, `-Infinity`) throw — they would
 *   otherwise silently collide with each other and with `null`/missing keys.
 * - `Date`/`Map`/`Set`/`BigInt`/`RegExp`/functions are NOT supported; inputs
 *   must be JSON-shaped (primitives, plain objects, arrays).
 */
export function canonicalHash(params: unknown): string {
  const json = JSON.stringify(canonicalize(params));
  return crypto.createHash("sha256").update(json).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`canonicalHash: non-finite number ${value} cannot be hashed`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    out[key] = canonicalize(obj[key]);
  }
  return out;
}
