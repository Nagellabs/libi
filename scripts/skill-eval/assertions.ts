import type { Matcher, OrderedNeedle, TraceCall, AssertionResult, TranscriptView } from "./types";

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

/**
 * Every value a dotted path reaches. A plain path reaches exactly one (possibly
 * `undefined`). A `*` segment fans out over the elements of an array — so
 * `input.platforms.*.accountId` reaches each platform row's `accountId` — and
 * reaches nothing on a non-array or an empty array. Callers treat the path as
 * satisfied when ANY reached value satisfies the predicate, which is what makes
 * an assertion independent of the order the agent listed the elements in.
 */
function getPathValues(obj: unknown, dotted: string): unknown[] {
  return dotted.split(".").reduce<unknown[]>((values, key) => {
    const next: unknown[] = [];
    for (const acc of values) {
      if (key === "*") {
        if (Array.isArray(acc)) next.push(...acc);
      } else if (acc && typeof acc === "object") {
        next.push((acc as Record<string, unknown>)[key]);
      } else {
        next.push(undefined);
      }
    }
    return next;
  }, [obj]);
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

/**
 * Evaluate a single predicate against a call: either `input.<path> <op>
 * <literal>` or the unary `input.<path> exists`. A `*` path segment matches any
 * element of an array; the predicate holds when any element satisfies it.
 *
 * `exists` is not sugar. There is no literal that means "absent" here —
 * `parseLiteral` turns `null` into the STRING "null", so `input.a.b != null`
 * reads as `undefined !== "null"` and matches every call in the trace,
 * including the ones that never carried the field. A scenario asserting that a
 * stamp (`input.metadata.libi.pieceId`) was actually sent needs a predicate
 * that fails when the path is missing, and that is this one.
 */
function evalWhere(call: TraceCall, where: string): boolean {
  const unary = /^\s*(input\.[^\s]+)\s+exists\s*$/.exec(where);
  if (unary) return getPathValues({ input: call.input }, unary[1]).some((v) => v !== undefined);
  const op = OPS.find((o) => where.includes(o));
  if (!op) throw new Error(`Invalid where predicate (no operator): "${where}"`);
  const idx = where.indexOf(op);
  const lhs = where.slice(0, idx).trim();
  const rhsRaw = where.slice(idx + op.length);
  if (!lhs.startsWith("input.")) {
    throw new Error(`Invalid where predicate (must start with "input."): "${where}"`);
  }
  const expected = parseLiteral(rhsRaw);
  return getPathValues({ input: call.input }, lhs).some((actual) => compare(actual, expected, op));
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

/**
 * Compile a `transcript_matches` source, refusing what could never fail: an empty pattern,
 * an invalid one, or one that matches the empty string — with the `g` flag it would "match"
 * at every position of any transcript, so a `present` assertion could not fail. Exported so
 * `parseScenario` can reject a bad pattern BEFORE a paid run, not after it.
 */
export function compileTranscriptPattern(source: string): RegExp {
  if (source === "") throw new Error("transcript_matches must not be empty");
  let re: RegExp;
  try {
    re = new RegExp(source, "g");
  } catch (err) {
    throw new Error(`transcript_matches is not a valid regular expression: ${(err as Error).message}`);
  }
  if (new RegExp(source).test("")) {
    throw new Error(`transcript_matches must not match the empty string: /${source}/`);
  }
  return re;
}

/**
 * Non-overlapping matches of the regex `source` in `haystack`. Also refuses a pattern that
 * matches zero-width anywhere in THIS transcript (the parse-time check sees only "").
 */
function regexMatches(haystack: string, source: string): string[] {
  const matches = [...haystack.matchAll(compileTranscriptPattern(source))].map((m) => m[0]);
  if (matches.some((m) => m === "")) {
    throw new Error(`transcript_matches must not match the empty string: /${source}/`);
  }
  return matches;
}

/** A failing regex has no trace call to show, so its reason quotes what it matched. */
function firstMatchNote(matches: string[]): string {
  if (!matches.length) return "";
  const m = matches[0];
  // Both ends: an absent tool call shows at its head, an anchored pattern's hit at its tail.
  return `; first: ${JSON.stringify(m.length > 200 ? `${m.slice(0, 100)}…${m.slice(-100)}` : m)}`;
}

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

/**
 * The text one `transcript_contains` or `transcript_matches` is matched against: the whole transcript, or the slice
 * its `turn` / `scope` narrow it to. A plain string transcript (a one-turn run, or a unit
 * test) has no turns and no separated agent text, so a narrowed matcher against one throws
 * rather than silently matching the whole thing.
 */
function haystackFor(view: string | TranscriptView, m: Matcher): string {
  const agentOnly = m.scope === "agent_text";
  if (typeof view === "string") {
    if (m.turn !== undefined || agentOnly) {
      throw new Error(`turn / scope need the harness's per-turn transcript, not a plain string: ${JSON.stringify(m)}`);
    }
    return view;
  }
  if (m.turn === undefined) return agentOnly ? view.agentText : view.full;
  const [from, to] = Array.isArray(m.turn) ? m.turn : [m.turn, m.turn];
  // A turn that never ran (the run ended early) is empty: `present` fails, `absent` passes.
  return view.turns
    .slice(from - 1, to)
    .map((t) => (agentOnly ? t.agentText : t.all))
    .join("\n");
}

/** The 1-based turn a needle first matches in, or null when it never does. */
function firstTurn(view: TranscriptView, n: OrderedNeedle): number | null {
  const needles = Array.isArray(n.transcript_contains) ? n.transcript_contains : [n.transcript_contains];
  for (let i = 0; i < view.turns.length; i++) {
    const text = n.scope === "agent_text" ? view.turns[i].agentText : view.turns[i].all;
    if (needles.some((x) => text.includes(x))) return i + 1;
  }
  return null;
}

/** An `ordered` matcher: does every `before` needle first match in an earlier turn than `then`? */
function evaluateOrdered(view: string | TranscriptView, m: Matcher): AssertionResult {
  if (typeof view === "string") {
    throw new Error(`ordered needs the harness's per-turn transcript, not a plain string: ${JSON.stringify(m)}`);
  }
  const { before, then } = m.ordered!;
  const thenTurn = firstTurn(view, then);
  const late: string[] = [];
  for (const b of before) {
    const t = firstTurn(view, b);
    if (t === null || thenTurn === null || t >= thenTurn) {
      late.push(`${JSON.stringify(b.transcript_contains)} first in ${t === null ? "no turn" : `turn ${t}`}`);
    }
  }
  const pass = thenTurn !== null && late.length === 0;
  return {
    matcher: m,
    pass,
    matchedCount: pass ? 1 : 0,
    reason: pass
      ? undefined
      : thenTurn === null
        ? `${JSON.stringify(then.transcript_contains)} never matched`
        : `not strictly before turn ${thenTurn} (${JSON.stringify(then.transcript_contains)}): ${late.join("; ")}`,
  };
}

/** How a matcher's turn narrowing reads in a report line. */
export function describeTurn(turn: Matcher["turn"]): string {
  if (turn === undefined) return "";
  return Array.isArray(turn) ? `turns ${turn[0]}-${turn[1]}` : `turn ${turn}`;
}

export function evaluate(
  trace: TraceCall[],
  matchers: Matcher[],
  transcript: string | TranscriptView = "",
): AssertionResult[] {
  return matchers.map((m) => {
    const hasExpect = m.expect !== undefined;
    const hasCount = m.count !== undefined;
    if (hasExpect === hasCount) {
      throw new Error(`Matcher must set exactly one of "expect" or "count": ${JSON.stringify(m)}`);
    }

    if (m.ordered !== undefined) {
      if (m.expect !== "present") throw new Error(`ordered takes expect: present only: ${JSON.stringify(m)}`);
      return evaluateOrdered(transcript, m);
    }

    let n: number;
    let matched: TraceCall[] = [];
    let note = "";
    if (m.transcript_matches !== undefined) {
      const clash = [
        ...TRACE_SELECTORS.filter((k) => m[k] !== undefined),
        ...(m.transcript_contains !== undefined ? ["transcript_contains"] : []),
      ];
      if (clash.length) {
        throw new Error(
          `transcript_matches cannot be combined with ${clash.join(", ")}: ${JSON.stringify(m)}`,
        );
      }
      const found = regexMatches(haystackFor(transcript, m), m.transcript_matches);
      n = found.length;
      note = firstMatchNote(found);
    } else if (m.transcript_contains !== undefined) {
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
      const haystack = haystackFor(transcript, m);
      n = needles.reduce((sum, needle) => sum + occurrences(haystack, needle), 0);
    } else {
      if (m.turn !== undefined || m.scope !== undefined) {
        throw new Error(`turn / scope narrow a transcript_contains or transcript_matches, not a trace selector: ${JSON.stringify(m)}`);
      }
      matched = selectCalls(trace, m);
      n = matched.length;
    }

    const where = [describeTurn(m.turn), m.scope === "agent_text" ? "agent text" : ""].filter(Boolean).join(", ");
    const narrowed = where ? ` (${where})` : "";
    const subject =
      m.transcript_matches !== undefined
        ? `transcript regex matches${narrowed}`
        : m.transcript_contains !== undefined
          ? `transcript occurrences${narrowed}`
          : "matching call";

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
            : `expected 0 ${subject}, found ${n}${note}`,
      };
    }

    const pass = evalCount(n, m.count!);
    return {
      matcher: m,
      pass,
      matchedCount: n,
      offendingCalls: pass ? undefined : matched,
      reason: pass ? undefined : `${subject} count ${n} does not satisfy "${m.count}"${note}`,
    };
  });
}
