/**
 * Static name resolution for a code overlay's body: which names it declares at
 * the top level (and what each declaration needs), and which names it reads
 * that nothing declares. The two static checks built on it are the
 * `include` assembler (`code-include.ts`) and the missing-name warning
 * (`body-warnings.ts`).
 *
 * PARSED, NEVER RUN — same rule as `code-outline.ts`, whose acorn parse and
 * tree utilities this reuses. A body is untrusted text; this module reads its
 * syntax tree and nothing else. Every name and line it returns is body-derived
 * and the tools that surface it label it (`textSource`).
 *
 * The scope model is real but small: a scope per Program / function / block /
 * `for` head / `catch` / `switch` / class expression, `var` and function
 * declarations hoisted to their function, `let` / `const` / `class` to their
 * block, parameters and destructuring patterns bound, `arguments` implicit.
 * It leans toward NOT reporting: a name written with a plain `x = …` anywhere
 * is treated as an implicit global the body declared, and `typeof x` never
 * counts as a read. Anything it cannot place it leaves alone — a wrong warning
 * costs the agent a look, a missed one costs a render.
 */
import { boundNames, isNode, lineOf, lineStarts, parseBody, type N } from "./code-outline";

/** A name read at a position in the body. */
export interface NameRef {
  name: string;
  /** 1-based, the body file's own. */
  line: number;
  /** Offset into the source. */
  offset: number;
}

/** One top-level declaration that can be copied on its own. */
export interface TopLevelDecl {
  kind: "function" | "class" | "const" | "let" | "var";
  /** Every name it binds (several for a destructuring). */
  names: string[];
  /** Source offsets of the text to copy: the whole statement for a function / class, the declarator for a variable. */
  start: number;
  end: number;
  /** 1-based, the file's own. */
  line: number;
  endLine: number;
  /** The text to emit: the node's source, `const ` + declarator + `;` for a variable. */
  text: string;
  /** Names this declaration reads that are declared at the top level of the same body (its own names excluded). */
  deps: string[];
  /** Names this declaration reads that nothing in the body declares anywhere. */
  free: NameRef[];
}

export interface BodyAnalysis {
  decls: TopLevelDecl[];
  /** Every name bound at the top level of the body, copyable or not (a hoisted `var` in a block counts). */
  topLevelNames: Set<string>;
  /** Names read anywhere in the body that no scope in it declares, in source order. */
  free: NameRef[];
  /** Top-level statements that are not declarations (calls, loops, `return`, …): never copied by an include. */
  nonDeclarationStatements: number;
  totalLines: number;
}

export type BodyAnalysisResult =
  | { ok: true; analysis: BodyAnalysis }
  | { ok: false; error: { message: string; line?: number; column?: number } };

interface Scope {
  names: Set<string>;
  parent: Scope | null;
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

const newScope = (parent: Scope | null): Scope => ({ names: new Set(), parent });

/** Declarations a statement list makes in ITS OWN block scope (`var` is hoisted separately). */
function declareLexical(stmts: readonly N[], scope: Scope): void {
  for (const stmt of stmts) {
    if (stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") {
      if (isNode(stmt.id)) scope.names.add(String(stmt.id.name));
    } else if (stmt.type === "VariableDeclaration" && stmt.kind !== "var") {
      const names: string[] = [];
      for (const d of stmt.declarations as N[]) boundNames(d.id, names);
      for (const n of names) scope.names.add(n);
    }
  }
}

/** `var`s (and block-level function declarations, which sloppy mode hoists) under `root`, without entering nested functions. */
function hoistVars(root: N, fnScope: Scope): void {
  const stack: N[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "VariableDeclaration" && n.kind === "var") {
      const names: string[] = [];
      for (const d of n.declarations as N[]) boundNames(d.id, names);
      for (const nm of names) fnScope.names.add(nm);
    }
    if (n !== root && n.type === "FunctionDeclaration") {
      if (isNode(n.id)) fnScope.names.add(String(n.id.name));
      continue;
    }
    if (n !== root && FUNCTION_TYPES.has(n.type)) continue;
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
      const v = n[key];
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) stack.push(c);
      } else if (isNode(v)) {
        stack.push(v);
      }
    }
  }
}

/** Plain `x = …` targets nothing declares: sloppy-mode implicit globals, which later reads may legitimately see. */
function collectImplicitGlobals(root: N, out: Set<string>): void {
  const stack: N[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "AssignmentExpression" && n.operator === "=") {
      const names: string[] = [];
      if (isNode(n.left) && (n.left.type === "Identifier" || n.left.type === "ObjectPattern" || n.left.type === "ArrayPattern")) boundNames(n.left, names);
      for (const nm of names) out.add(nm);
    }
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
      const v = n[key];
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) stack.push(c);
      } else if (isNode(v)) {
        stack.push(v);
      }
    }
  }
}

/** Analyse a body. Never throws: a body that does not parse (or nests past the stack) comes back `ok: false`. */
export function analyzeBody(source: string): BodyAnalysisResult {
  const starts = lineStarts(source);
  const totalLines = source.length === 0 ? 0 : source.endsWith("\n") ? starts.length - 1 : starts.length;
  let program: N;
  try {
    program = parseBody(source);
  } catch (err) {
    const e = err as { message?: string; loc?: { line: number; column: number } };
    return {
      ok: false,
      error: {
        message: String(e.message ?? "syntax error").replace(/\s*\(\d+:\d+\)\s*$/, "").slice(0, 200),
        ...(e.loc ? { line: e.loc.line, column: e.loc.column + 1 } : {}),
      },
    };
  }

  const programScope = newScope(null);
  const body = program.body as N[];
  declareLexical(body, programScope);
  hoistVars(program, programScope);
  const implicit = new Set<string>();
  collectImplicitGlobals(program, implicit);

  const free: NameRef[] = [];
  // Per top-level statement: the program-scope names it reads, and the names nothing declares.
  const depsOf: Array<Set<string>> = body.map(() => new Set());
  const freeOf: NameRef[][] = body.map(() => []);
  let current = -1;

  const ref = (name: string, n: N, scope: Scope): void => {
    for (let s: Scope | null = scope; s; s = s.parent) {
      if (s.names.has(name)) {
        if (s === programScope && current >= 0) depsOf[current]!.add(name);
        return;
      }
    }
    if (implicit.has(name)) return;
    const r: NameRef = { name, offset: n.start, line: lineOf(starts, n.start) };
    free.push(r);
    if (current >= 0) freeOf[current]!.push(r);
  };

  /** A binding pattern: the names are declarations (already in scope); defaults and computed keys are expressions. */
  const walkPattern = (p: unknown, scope: Scope, mode: "bind" | "assign"): void => {
    if (!isNode(p)) return;
    switch (p.type) {
      case "Identifier":
        // A `bind` identifier is a declaration. An `assign` one is a write: never a read.
        return;
      case "ObjectPattern":
        for (const prop of p.properties as N[]) {
          if (prop.type === "RestElement") {
            walkPattern(prop.argument, scope, mode);
          } else {
            if (prop.computed) walk(prop.key, scope);
            walkPattern(prop.value, scope, mode);
          }
        }
        return;
      case "ArrayPattern":
        for (const e of p.elements as unknown[]) walkPattern(e, scope, mode);
        return;
      case "AssignmentPattern":
        walkPattern(p.left, scope, mode);
        walk(p.right, scope);
        return;
      case "RestElement":
        walkPattern(p.argument, scope, mode);
        return;
      case "MemberExpression":
        // `[a.b] = …`: a member target reads its object.
        walk(p, scope);
        return;
      default:
        walk(p, scope);
    }
  };

  const walkFunction = (fn: N, scope: Scope): void => {
    const s = newScope(scope);
    s.names.add("arguments");
    if (fn.type === "FunctionExpression" && isNode(fn.id)) s.names.add(String(fn.id.name));
    const names: string[] = [];
    for (const p of fn.params as N[]) boundNames(p, names);
    for (const n of names) s.names.add(n);
    const fnBody = fn.body as N;
    if (fnBody.type === "BlockStatement") {
      declareLexical(fnBody.body as N[], s);
      hoistVars(fnBody, s);
    }
    for (const p of fn.params as N[]) walkPattern(p, s, "bind");
    if (fnBody.type === "BlockStatement") {
      for (const st of fnBody.body as N[]) walk(st, s);
    } else {
      walk(fnBody, s);
    }
  };

  const walkClass = (cls: N, scope: Scope): void => {
    let s = scope;
    if (cls.type === "ClassExpression" && isNode(cls.id)) {
      s = newScope(scope);
      s.names.add(String(cls.id.name));
    }
    if (isNode(cls.superClass)) walk(cls.superClass, s);
    const classBody = cls.body as N;
    for (const member of classBody.body as N[]) {
      if (member.type === "StaticBlock") {
        const bs = newScope(s);
        declareLexical(member.body as N[], bs);
        hoistVars(member, bs);
        for (const st of member.body as N[]) walk(st, bs);
        continue;
      }
      if (member.computed && isNode(member.key)) walk(member.key, s);
      if (isNode(member.value)) walk(member.value, s);
    }
  };

  const walk = (n: unknown, scope: Scope): void => {
    if (!isNode(n)) return;
    switch (n.type) {
      case "Identifier":
        ref(String(n.name), n, scope);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        walkFunction(n, scope);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        walkClass(n, scope);
        return;
      case "BlockStatement": {
        const s = newScope(scope);
        declareLexical(n.body as N[], s);
        for (const st of n.body as N[]) walk(st, s);
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const s = newScope(scope);
        const head = (n.type === "ForStatement" ? n.init : n.left) as N | null;
        if (isNode(head) && head.type === "VariableDeclaration" && head.kind !== "var") declareLexical([head], s);
        if (n.type === "ForStatement") {
          if (isNode(n.init)) walk(n.init, s);
          if (isNode(n.test)) walk(n.test, s);
          if (isNode(n.update)) walk(n.update, s);
        } else {
          if (isNode(n.left) && n.left.type !== "VariableDeclaration") walkPattern(n.left, s, "assign");
          else walk(n.left, s);
          walk(n.right, s);
        }
        walk(n.body, s);
        return;
      }
      case "SwitchStatement": {
        walk(n.discriminant, scope);
        const s = newScope(scope);
        for (const c of n.cases as N[]) declareLexical(c.consequent as N[], s);
        for (const c of n.cases as N[]) {
          if (isNode(c.test)) walk(c.test, s);
          for (const st of c.consequent as N[]) walk(st, s);
        }
        return;
      }
      case "CatchClause": {
        const s = newScope(scope);
        const names: string[] = [];
        if (isNode(n.param)) boundNames(n.param, names);
        for (const nm of names) s.names.add(nm);
        if (isNode(n.param)) walkPattern(n.param, s, "bind");
        walk(n.body, s);
        return;
      }
      case "VariableDeclaration":
        for (const d of n.declarations as N[]) {
          walkPattern(d.id, scope, "bind");
          if (isNode(d.init)) walk(d.init, scope);
        }
        return;
      case "MemberExpression":
        walk(n.object, scope);
        if (n.computed) walk(n.property, scope);
        return;
      case "Property":
        if (n.computed) walk(n.key, scope);
        walk(n.value, scope);
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
        if (n.computed && isNode(n.key)) walk(n.key, scope);
        if (isNode(n.value)) walk(n.value, scope);
        return;
      case "LabeledStatement":
        walk(n.body, scope);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
      case "ThisExpression":
      case "Super":
        return;
      case "UnaryExpression":
        // `typeof missing` is the safe probe; it never throws.
        if (n.operator === "typeof" && isNode(n.argument) && n.argument.type === "Identifier") return;
        walk(n.argument, scope);
        return;
      case "AssignmentExpression":
        if (isNode(n.left) && (n.left.type === "Identifier" || n.left.type === "ObjectPattern" || n.left.type === "ArrayPattern")) {
          if (n.left.type === "Identifier") {
            // `x += 1` reads x; `x = 1` only writes it.
            if (n.operator !== "=") walk(n.left, scope);
          } else {
            walkPattern(n.left, scope, "assign");
          }
        } else {
          walk(n.left, scope);
        }
        walk(n.right, scope);
        return;
      default:
        break;
    }
    // Everything else: its children, in source order.
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
      const v = n[key];
      if (Array.isArray(v)) {
        for (const c of v) walk(c, scope);
      } else if (isNode(v)) {
        walk(v, scope);
      }
    }
  };

  const decls: TopLevelDecl[] = [];
  let nonDeclarationStatements = 0;
  try {
    body.forEach((stmt, i) => {
      current = i;
      walk(stmt, programScope);
      const span = (a: number, b: number) => ({ line: lineOf(starts, a), endLine: lineOf(starts, Math.max(a, b - 1)) });
      const pushDecl = (kind: TopLevelDecl["kind"], names: string[], start: number, end: number, text: string): void => {
        decls.push({
          kind,
          names,
          start,
          end,
          ...span(start, end),
          text,
          deps: [...depsOf[i]!].filter((d) => !names.includes(d)),
          free: freeOf[i]!,
        });
      };
      if ((stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") && isNode(stmt.id)) {
        pushDecl(stmt.type === "FunctionDeclaration" ? "function" : "class", [String(stmt.id.name)], stmt.start, stmt.end, source.slice(stmt.start, stmt.end));
      } else if (stmt.type === "VariableDeclaration") {
        const kind = stmt.kind as "const" | "let" | "var";
        const declarators = stmt.declarations as N[];
        for (const d of declarators) {
          const names: string[] = [];
          boundNames(d.id, names);
          // One declarator alone: its own dependencies, not its siblings'.
          pushDecl(kind, names, d.start, d.end, `${kind} ${source.slice(d.start, d.end)};`);
        }
        // A statement with several declarators shares one dependency set in `depsOf`; narrow it per declarator.
        if (declarators.length > 1) {
          const start = decls.length - declarators.length;
          declarators.forEach((d, k) => {
            const own = decls[start + k]!;
            const sub = analyzeDeclaratorDeps(d, source, starts, programScope, implicit);
            own.deps = sub.deps.filter((x) => !own.names.includes(x));
            own.free = sub.free;
          });
        }
      } else if (stmt.type !== "EmptyStatement") {
        nonDeclarationStatements++;
      }
    });
  } catch {
    // A body nested past the stack (hostile or generated): no analysis rather than a crash.
    return { ok: false, error: { message: "the body is nested too deeply to analyse" } };
  }

  return {
    ok: true,
    analysis: {
      decls,
      topLevelNames: new Set(programScope.names),
      free,
      nonDeclarationStatements,
      totalLines,
    },
  };
}

/** Dependencies of ONE declarator of a multi-declarator statement: re-walked on its own against the program scope. */
function analyzeDeclaratorDeps(
  d: N,
  source: string,
  starts: number[],
  programScope: Scope,
  implicit: ReadonlySet<string>,
): { deps: string[]; free: NameRef[] } {
  // Wrap the declarator as its own statement so the main walker's rules apply unchanged.
  const text = `var ${source.slice(d.start, d.end)};`;
  const shift = d.start - 4;
  const sub = analyzeBodyWith(text, programScope, implicit);
  return {
    deps: sub.deps,
    free: sub.free.map((r) => ({ ...r, offset: r.offset + shift, line: lineOf(starts, r.offset + shift) })),
  };
}

/** Walk `text` (one statement) with `outer` as the program scope and report what it reads from it. */
function analyzeBodyWith(text: string, outer: Scope, implicit: ReadonlySet<string>): { deps: string[]; free: NameRef[] } {
  const res = analyzeBody(text);
  if (!res.ok) return { deps: [], free: [] };
  const names = new Set<string>();
  const free: NameRef[] = [];
  for (const r of res.analysis.free) {
    if (outer.names.has(r.name)) names.add(r.name);
    else if (!implicit.has(r.name)) free.push(r);
  }
  return { deps: [...names], free };
}
