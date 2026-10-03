/**
 * A static outline of a code overlay's body — what an agent needs to reuse or
 * restyle a body without reading all of it (the Dreams session read 100–300
 * line style kits whole, ~22% of its cache-read).
 *
 * PARSED, NEVER RUN. A body is untrusted text (templates ship bodies, a
 * `composition.json` arrives by routes no tool call saw): this module hands it
 * to acorn and walks the tree. No `eval`, no `new Function`, no import of the
 * runtime. Every string it returns is body-derived and the tool marks it so
 * (`textSource`), exactly as `renderDiagnostics` does for an error message.
 *
 * Line numbers are the body FILE's own (line 1 = first line), the same numbers
 * `renderDiagnostics` reports and `includeSource` ranges read.
 *
 * Bounded on every axis: a hostile or merely huge body cannot make the result
 * large — entry counts, string lengths and the source range are all capped.
 */
import { parse, type Node } from "acorn";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";

/** What a result may carry, so one call stays small whatever the body is. */
export const OUTLINE_LIMITS = {
  functions: 120,
  constants: 120,
  fonts: 16,
  helpers: 40,
  /** A name or a parameter list is cut to this many characters. */
  nameChars: 80,
  paramChars: 120,
  /** A literal value is shown when it fits, otherwise summarised. */
  valueChars: 120,
  /** `includeSource`: the most lines and characters one call returns. */
  sourceLines: 300,
  sourceChars: 24_000,
} as const;

export interface OutlineFunction {
  name: string;
  /** The parameter list as written, e.g. `(ctx, x, y, size = 1)`. */
  params: string;
  /** 1-based, the file's own. */
  line: number;
  endLine: number;
  async?: true;
  /** `const draw = (…) =>` rather than a `function` declaration. */
  via?: "const" | "let" | "var";
}

export interface OutlineConstant {
  /** The binding, or `{a, b}` / `[a, b]` for a destructuring. */
  name: string;
  kind: "const" | "let" | "var";
  line: number;
  endLine: number;
  /** A literal initializer, compact: `8.3`, `"#f4e8d0"`, `["#111", "#fa0"]`, `{ ink: "#111", … }`.
   *  Absent when the initializer is not a literal (a call, an expression). */
  value?: string;
  /** What a non-literal initializer is, in a word: `call`, `expression`, `new`, … */
  init?: string;
  /** A destructuring's source, `context` in `const { ctx } = context`. */
  from?: string;
}

export interface CodeOutline {
  totalLines: number;
  totalChars: number;
  functions: OutlineFunction[];
  constants: OutlineConstant[];
  /** Font families the body names (a `ctx.font` shorthand, a `fontFamily` field). */
  fonts: string[];
  /** Documented helpers (`interpolate`, `drawRoundedRect`, …) the body calls or reads. */
  helpersUsed: string[];
  /** Entries dropped by the caps, per list — present only when something was cut. */
  truncated?: { functions?: number; constants?: number; fonts?: number; helpersUsed?: number };
}

export interface OutlineParseError {
  message: string;
  line?: number;
  column?: number;
}

export type OutlineResult =
  | { ok: true; outline: CodeOutline }
  | { ok: false; error: OutlineParseError; totalLines: number; totalChars: number };

// ── a minimal ESTree view (acorn emits ESTree; only what is read is typed) ──
export type N = Node & Record<string, unknown> & { type: string };

export const isNode = (v: unknown): v is N => typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

let helperNames: Set<string> | null = null;
function documentedHelpers(): Set<string> {
  if (!helperNames) helperNames = new Set(Object.keys(DRAW_HELPERS));
  return helperNames;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Whitespace-collapsed source of a node. */
function snippet(src: string, n: Node, max: number): string {
  return clip(src.slice(n.start, n.end).replace(/\s+/g, " ").trim(), max);
}

export function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** `(a, b = 2, {c}, ...rest)` as written, collapsed to one line. */
function paramsOf(src: string, fn: N): string {
  const params = fn.params as N[];
  if (params.length === 0) return "()";
  const first = params[0]!;
  const last = params[params.length - 1]!;
  return clip(`(${src.slice(first.start, last.end).replace(/\s+/g, " ").trim()})`, OUTLINE_LIMITS.paramChars);
}

function isFunctionNode(n: unknown): n is N {
  return isNode(n) && (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression");
}

/**
 * A literal initializer, rendered compactly, or null. Numbers, strings,
 * booleans, `null`, a signed number, a template with no substitutions, and an
 * array or object made only of those (nested). Anything that would need
 * evaluating — a call, an identifier, arithmetic — is NOT a literal here.
 */
function literalText(src: string, n: unknown): string | null {
  if (!isNode(n)) return null;
  switch (n.type) {
    case "Literal":
      if ((n as { regex?: unknown }).regex) return null;
      return snippet(src, n, OUTLINE_LIMITS.valueChars);
    case "UnaryExpression": {
      const arg = n.argument;
      const op = n.operator as string;
      return (op === "-" || op === "+") && isNode(arg) && arg.type === "Literal" && typeof (arg as { value?: unknown }).value === "number"
        ? snippet(src, n, OUTLINE_LIMITS.valueChars)
        : null;
    }
    case "TemplateLiteral":
      return (n.expressions as unknown[]).length === 0 ? snippet(src, n, OUTLINE_LIMITS.valueChars) : null;
    case "ArrayExpression":
    case "ObjectExpression":
      return allLiteral(n) ? "container" : null;
    default:
      return null;
  }
}

function allLiteral(n: N): boolean {
  if (n.type === "ArrayExpression") {
    return (n.elements as unknown[]).every((e) => e !== null && (isNode(e) && (e.type === "ArrayExpression" || e.type === "ObjectExpression") ? allLiteral(e) : literalText("", e) !== null));
  }
  if (n.type === "ObjectExpression") {
    return (n.properties as N[]).every(
      (p) => p.type === "Property" && !p.computed && !p.method && p.kind === "init" && (isNode(p.value) && (p.value.type === "ArrayExpression" || p.value.type === "ObjectExpression") ? allLiteral(p.value) : literalText("", p.value) !== null),
    );
  }
  return false;
}

/** A compact value for a literal initializer: its own text when short, else a summary. */
function valueOf(src: string, n: N): string | undefined {
  const lit = literalText(src, n);
  if (lit === null) return undefined;
  if (lit !== "container") return lit;
  const text = src.slice(n.start, n.end).replace(/\s+/g, " ").trim();
  if (text.length <= OUTLINE_LIMITS.valueChars) return text;
  if (n.type === "ArrayExpression") return `[${(n.elements as unknown[]).length} items]`;
  const keys = (n.properties as N[]).map((p) => keyName(p)).filter((k): k is string => k !== null);
  const shown = keys.slice(0, 8).join(", ");
  return `{ ${shown}${keys.length > 8 ? `, … ${keys.length} keys` : ""} }`;
}

function keyName(p: N): string | null {
  const k = p.key;
  if (!isNode(k)) return null;
  if (k.type === "Identifier") return String(k.name);
  if (k.type === "Literal") return String((k as { value?: unknown }).value);
  return null;
}

/** `{ a, b: c, ...d }` / `[x, , y]` → the names it binds, in order. */
export function boundNames(pattern: unknown, out: string[]): void {
  if (!isNode(pattern)) return;
  switch (pattern.type) {
    case "Identifier":
      out.push(String(pattern.name));
      return;
    case "ObjectPattern":
      for (const p of pattern.properties as N[]) boundNames(p.type === "RestElement" ? p.argument : p.value, out);
      return;
    case "ArrayPattern":
      for (const e of pattern.elements as unknown[]) boundNames(e, out);
      return;
    case "AssignmentPattern":
      boundNames(pattern.left, out);
      return;
    case "RestElement":
      boundNames(pattern.argument, out);
      return;
    default:
  }
}

function initKind(n: N | null): string | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case "CallExpression":
      return "call";
    case "NewExpression":
      return "new";
    case "Identifier":
    case "MemberExpression":
      return "reference";
    case "ArrayExpression":
      return "array";
    case "ObjectExpression":
      return "object";
    case "ClassExpression":
      return "class";
    default:
      return "expression";
  }
}

// ── fonts ──────────────────────────────────────────────────────────────────

const FONT_SHORTHAND = /(?:^|\s)\d+(?:\.\d+)?(?:px|pt|em|rem)(?:\s*\/\s*[\d.]+(?:px|pt|em|rem)?)?\s+([^;]+)$/i;
const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "inherit", "initial"]);

function familiesFrom(text: string): string[] {
  const m = FONT_SHORTHAND.exec(text.trim());
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, "").trim())
    .filter((f) => f.length > 0 && f.length <= 60 && !GENERIC_FAMILIES.has(f.toLowerCase()));
}

/**
 * String text of a literal, a template or a `+` chain of those, with every
 * substitution (and every operand that is not a string) read as `0`. A named
 * top-level string const stands in for itself, so `ctx.font = TITLE_FONT` is
 * read as the const's text. Null when there is no text at all.
 */
function textOf(n: unknown, consts: ReadonlyMap<string, string>): string | null {
  if (!isNode(n)) return null;
  if (n.type === "Literal") return typeof (n as unknown as { value?: unknown }).value === "string" ? (n as unknown as { value: string }).value : "0";
  if (n.type === "TemplateLiteral") {
    const quasis = n.quasis as Array<{ value: { cooked?: string | null; raw: string } }>;
    return quasis.map((q) => q.value.cooked ?? q.value.raw).join("0");
  }
  if (n.type === "Identifier") return consts.get(String(n.name)) ?? null;
  if (n.type === "BinaryExpression" && n.operator === "+") {
    const l = textOf(n.left, consts);
    const r = textOf(n.right, consts);
    if (l === null && r === null) return null;
    return (l ?? "0") + (r ?? "0");
  }
  return null;
}

const FAMILY_KEY = /^(?:font-?family|family|fontFamily)$/i;

// ── the walk ───────────────────────────────────────────────────────────────

/** Children of a node, in source order, without pulling in a walker dependency. */
export function children(n: N): N[] {
  const out: N[] = [];
  for (const key of Object.keys(n)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const v = (n as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) out.push(c);
    } else if (isNode(v)) {
      out.push(v);
    }
  }
  return out;
}

/** Visit every node under `root` (iterative: a deeply nested body cannot overflow the stack). */
function visit(root: N, fn: (n: N, parent: N | null) => void): void {
  const stack: Array<[N, N | null]> = [[root, null]];
  while (stack.length > 0) {
    const [n, parent] = stack.pop()!;
    fn(n, parent);
    const kids = children(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, n]);
  }
}

/** Parse a body the way the outline does: a function body, `return` allowed at the top level. Throws acorn's error. */
export function parseBody(source: string): N {
  return parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowHashBang: true,
    locations: true,
  }) as unknown as N;
}

/**
 * Outline a body. `source` is the FILE's text (a function body, with `return`
 * allowed at the top level the way `new Function` allows it).
 */
export function outlineCode(source: string): OutlineResult {
  const totalChars = source.length;
  const starts = lineStarts(source);
  // A trailing newline does not start another line.
  const totalLines = source.length === 0 ? 0 : source.endsWith("\n") ? starts.length - 1 : starts.length;

  let program: N;
  try {
    program = parseBody(source);
  } catch (err) {
    const e = err as { message?: string; loc?: { line: number; column: number } };
    return {
      ok: false,
      totalLines,
      totalChars,
      error: {
        // acorn appends " (line:col)" to its message; the position is carried apart.
        message: clip(String(e.message ?? "syntax error").replace(/\s*\(\d+:\d+\)\s*$/, ""), 200),
        ...(e.loc ? { line: e.loc.line, column: e.loc.column + 1 } : {}),
      },
    };
  }

  const fns: OutlineFunction[] = [];
  const consts: OutlineConstant[] = [];
  const declared = new Set<string>();
  let droppedFns = 0;
  let droppedConsts = 0;

  const pushFn = (f: OutlineFunction) => (fns.length < OUTLINE_LIMITS.functions ? void fns.push(f) : void droppedFns++);
  const pushConst = (c: OutlineConstant) => (consts.length < OUTLINE_LIMITS.constants ? void consts.push(c) : void droppedConsts++);
  const span = (n: Node) => ({ line: lineOf(starts, n.start), endLine: lineOf(starts, Math.max(n.start, n.end - 1)) });

  for (const stmt of program.body as N[]) {
    if (stmt.type === "FunctionDeclaration" && isNode(stmt.id)) {
      const name = String(stmt.id.name);
      declared.add(name);
      pushFn({
        name: clip(name, OUTLINE_LIMITS.nameChars),
        params: paramsOf(source, stmt),
        ...span(stmt),
        ...(stmt.async ? { async: true as const } : {}),
      });
    } else if (stmt.type === "VariableDeclaration") {
      const kind = stmt.kind as "const" | "let" | "var";
      for (const d of stmt.declarations as N[]) {
        const id = d.id as N;
        const init = isNode(d.init) ? (d.init as N) : null;
        const names: string[] = [];
        boundNames(id, names);
        for (const nm of names) declared.add(nm);
        if (id.type === "Identifier" && isFunctionNode(init)) {
          pushFn({
            name: clip(String(id.name), OUTLINE_LIMITS.nameChars),
            params: paramsOf(source, init),
            ...span(d),
            ...(init.async ? { async: true as const } : {}),
            via: kind,
          });
          continue;
        }
        if (id.type === "Identifier") {
          const value = init ? valueOf(source, init) : undefined;
          pushConst({
            name: clip(String(id.name), OUTLINE_LIMITS.nameChars),
            kind,
            ...span(d),
            ...(value !== undefined ? { value } : { init: initKind(init) ?? "uninitialized" }),
          });
        } else {
          // A destructuring: one entry for the pattern, not one per name.
          pushConst({
            name: clip(snippet(source, id, OUTLINE_LIMITS.paramChars), OUTLINE_LIMITS.paramChars),
            kind,
            ...span(d),
            ...(init ? { from: snippet(source, init, 60) } : {}),
          });
        }
      }
    }
  }

  // Top-level string consts, so `ctx.font = TITLE_FONT` reads as the string it holds.
  const strings = new Map<string, string>();
  for (const stmt of program.body as N[]) {
    if (stmt.type !== "VariableDeclaration" || stmt.kind !== "const") continue;
    for (const d of stmt.declarations as N[]) {
      const id = d.id as N;
      if (id.type === "Identifier" && isNode(d.init) && (d.init.type === "Literal" || d.init.type === "TemplateLiteral")) {
        const t = textOf(d.init, strings);
        if (t !== null) strings.set(String(id.name), t);
      }
    }
  }

  // Fonts and helpers need the whole tree, nested code included.
  const fontSet = new Set<string>();
  const helperSet = new Set<string>();
  const documented = documentedHelpers();
  visit(program, (n, parent) => {
    if (n.type === "Identifier") {
      const name = String(n.name);
      if (!documented.has(name) || declared.has(name) || !parent) return;
      // `obj.interpolate` and `{ interpolate: 1 }` name a property, not the helper.
      if (parent.type === "MemberExpression" && parent.property === n && !parent.computed) return;
      if (parent.type === "Property" && parent.key === n && !parent.computed && !parent.shorthand) return;
      helperSet.add(name);
      return;
    }
    if (n.type === "AssignmentExpression" && isNode(n.left) && n.left.type === "MemberExpression" && isNode(n.left.property)) {
      if (n.left.property.type === "Identifier" && n.left.property.name === "font" && !n.left.computed) {
        const t = textOf(n.right, strings);
        if (t !== null) for (const f of familiesFrom(t)) fontSet.add(f);
      }
      return;
    }
    if (n.type === "Property" && !n.computed) {
      const key = keyName(n);
      if (key && (key === "font" || FAMILY_KEY.test(key))) {
        const t = textOf(n.value, strings);
        if (t !== null) {
          const fams = key === "font" ? familiesFrom(t) : t.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").trim());
          for (const f of fams) if (f.length > 0 && f.length <= 60 && !GENERIC_FAMILIES.has(f.toLowerCase())) fontSet.add(f);
        }
      }
    }
  });

  const fonts = [...fontSet];
  const helpers = [...helperSet].sort();
  const truncated: NonNullable<CodeOutline["truncated"]> = {};
  if (droppedFns) truncated.functions = droppedFns;
  if (droppedConsts) truncated.constants = droppedConsts;
  if (fonts.length > OUTLINE_LIMITS.fonts) truncated.fonts = fonts.length - OUTLINE_LIMITS.fonts;
  if (helpers.length > OUTLINE_LIMITS.helpers) truncated.helpersUsed = helpers.length - OUTLINE_LIMITS.helpers;

  return {
    ok: true,
    outline: {
      totalLines,
      totalChars,
      functions: fns,
      constants: consts,
      fonts: fonts.slice(0, OUTLINE_LIMITS.fonts),
      helpersUsed: helpers.slice(0, OUTLINE_LIMITS.helpers),
      ...(Object.keys(truncated).length ? { truncated } : {}),
    },
  };
}

/** One `includeSource` window: the 1-based inclusive lines `from..to`, capped. */
export interface SourceRange {
  from: number;
  to: number;
  /** The lines, `\n`-joined, exactly as in the file. */
  text: string;
  /** Set when the cap shortened the window the caller asked for. */
  clamped?: { askedTo: number; reason: "lines" | "chars" | "end-of-file" };
}

/**
 * Lines `from..to` of the file, 1-based and inclusive. `from` below 1 reads
 * from 1; `to` past the end stops at the end. At most `OUTLINE_LIMITS.sourceLines`
 * lines and `sourceChars` characters come back, and `clamped` says so — a range
 * read is meant to be a window, not a copy of the file.
 */
export function readSourceRange(source: string, from: number, to: number): SourceRange | { error: string } {
  const lines = source.split("\n");
  // A trailing newline is not a line of its own.
  const total = source.endsWith("\n") ? lines.length - 1 : lines.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return { error: "includeSource wants whole line numbers with to >= from" };
  if (from > total) return { error: `the file has ${total} line${total === 1 ? "" : "s"}; from ${from} is past the end` };
  const start = Math.max(1, from);
  let end = Math.min(to, total);
  let clamped: SourceRange["clamped"];
  if (to > total) clamped = { askedTo: to, reason: "end-of-file" };
  if (end - start + 1 > OUTLINE_LIMITS.sourceLines) {
    end = start + OUTLINE_LIMITS.sourceLines - 1;
    clamped = { askedTo: to, reason: "lines" };
  }
  let text = lines.slice(start - 1, end).join("\n");
  if (text.length > OUTLINE_LIMITS.sourceChars) {
    // Cut at a line boundary so the window never ends mid-line.
    const cut = text.lastIndexOf("\n", OUTLINE_LIMITS.sourceChars);
    text = text.slice(0, cut > 0 ? cut : OUTLINE_LIMITS.sourceChars);
    end = start + text.split("\n").length - 1;
    clamped = { askedTo: to, reason: "chars" };
  }
  return { from: start, to: end, text, ...(clamped ? { clamped } : {}) };
}
