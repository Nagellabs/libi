import type { Matcher, TraceCall, AssertionResult } from "./types";

/** Glob match with a single `*` wildcard semantics (matches any run of chars). */
function globMatch(value: string | undefined, pattern: string): boolean {
  if (value === undefined) return false;
  if (!pattern.includes("*")) return value === pattern;
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
  return re.test(value);
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** Parse a literal token into string | number | boolean. */
function parseLiteral(raw: string): string | number | boolean {
  const t = raw.trim().replace(/^["']|["']$/g, "");
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t)) && /^-?\d/.test(t)) return Number(t);
  return t;
}

const OPS = ["==", "!=", ">=", "<=", ">", "<"] as const;
type Op = (typeof OPS)[number];

/** Evaluate a single `input.<path> <op> <literal>` predicate against a call. */
function evalWhere(call: TraceCall, where: string): boolean {
  const op = OPS.find((o) => where.includes(o));
  if (!op) throw new Error(`Invalid where predicate (no operator): "${where}"`);
  const idx = where.indexOf(op);
  const lhs = where.slice(0, idx).trim();
  const rhsRaw = where.slice(idx + op.length);
  if (!lhs.startsWith("input.")) {
    throw new Error(`Invalid where predicate (must start with "input."): "${where}"`);
  }
  const actual = getPath({ input: call.input }, lhs);
  const expected = parseLiteral(rhsRaw);
  return compare(actual, expected, op);
}

function compare(actual: unknown, expected: string | number | boolean, op: Op): boolean {
  switch (op) {
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    case ">": return Number(actual) > Number(expected);
    case ">=": return Number(actual) >= Number(expected);
    case "<": return Number(actual) < Number(expected);
    case "<=": return Number(actual) <= Number(expected);
  }
}

function selectCalls(trace: TraceCall[], m: Matcher): TraceCall[] {
  return trace.filter((c) => {
    if (m.tool !== undefined && c.tool !== m.tool) return false;
    if (m.endpoint_id !== undefined) {
      // Prefer the canonical id (so a matcher keyed on the canonical string
      // matches even when the agent reached it via an alias), fall back to the
      // literal id the agent used.
      const id = c.canonical_endpoint_id ?? c.endpoint_id;
      if (!globMatch(id, m.endpoint_id)) return false;
    }
    if (m.unknown_endpoint !== undefined && (c.unknown_endpoint ?? false) !== m.unknown_endpoint) return false;
    if (m.provider !== undefined && c.provider !== m.provider) return false;
    if (m.voice_id !== undefined && !globMatch(c.voice_id, m.voice_id)) return false;
    if (m.model_id !== undefined && !globMatch(c.model_id, m.model_id)) return false;
    if (m.where !== undefined && !evalWhere(c, m.where)) return false;
    return true;
  });
}

/** Evaluate a "<op><n>" count expression, e.g. ">=1", "==2". */
function evalCount(n: number, expr: string): boolean {
  const op = OPS.find((o) => expr.startsWith(o));
  if (!op) throw new Error(`Invalid count expression: "${expr}"`);
  const target = Number(expr.slice(op.length).trim());
  if (Number.isNaN(target)) throw new Error(`Invalid count target: "${expr}"`);
  return compare(n, target, op);
}

const TRACE_SELECTORS = [
  "tool",
  "endpoint_id",
  "where",
  "provider",
  "voice_id",
  "model_id",
  "unknown_endpoint",
] as const;

/** Number of non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  if (needle === "") throw new Error("transcript_contains must not be empty");
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

export function evaluate(
  trace: TraceCall[],
  matchers: Matcher[],
  transcript = "",
): AssertionResult[] {
  return matchers.map((m) => {
    const hasExpect = m.expect !== undefined;
    const hasCount = m.count !== undefined;
    if (hasExpect === hasCount) {
      throw new Error(`Matcher must set exactly one of "expect" or "count": ${JSON.stringify(m)}`);
    }

    let n: number;
    let matched: TraceCall[] = [];
    if (m.transcript_contains !== undefined) {
      const clash = TRACE_SELECTORS.filter((k) => m[k] !== undefined);
      if (clash.length) {
        throw new Error(
          `transcript_contains cannot be combined with trace selectors (${clash.join(", ")}): ${JSON.stringify(m)}`,
        );
      }
      const needles = Array.isArray(m.transcript_contains)
        ? m.transcript_contains
        : [m.transcript_contains];
      if (needles.length === 0) {
        throw new Error(`transcript_contains must not be an empty list: ${JSON.stringify(m)}`);
      }
      n = needles.reduce((sum, needle) => sum + occurrences(transcript, needle), 0);
    } else {
      matched = selectCalls(trace, m);
      n = matched.length;
    }

    const subject = m.transcript_contains !== undefined ? "transcript occurrences" : "matching call";

    if (hasExpect) {
      const pass = m.expect === "present" ? n >= 1 : n === 0;
      return {
        matcher: m,
        pass,
        matchedCount: n,
        offendingCalls: pass ? undefined : m.expect === "absent" ? matched : [],
        reason: pass
          ? undefined
          : m.expect === "present"
            ? `expected ≥1 ${subject}, found 0`
            : `expected 0 ${subject}, found ${n}`,
      };
    }

    const pass = evalCount(n, m.count!);
    return {
      matcher: m,
      pass,
      matchedCount: n,
      offendingCalls: pass ? undefined : matched,
      reason: pass ? undefined : `${subject} count ${n} does not satisfy "${m.count}"`,
    };
  });
}
