/**
 * Include on write: copy the top-level declarations of one code overlay's body
 * into another body, instead of an agent slicing a sibling's file with a shell
 * command (Dreams session: six end cards each assembled from 200–300 line
 * slices; one slice missed a helper and the render failed).
 *
 * PARSED, NEVER RUN. The source body is read with acorn (`code-scope.ts`,
 * `code-outline.ts`); nothing here evaluates a body. The assembled text is
 * validated by the caller with the ordinary validator before anything is
 * written.
 *
 * What is copied: the top-level `function`, `class`, and each `const` / `let` /
 * `var` declarator the new body needs, closed over what THEY need, in source
 * order, under a banner naming the source overlay. A name the new body already
 * declares wins (the source's copy is skipped and reported). Top-level
 * statements that are not declarations are never copied — the result counts
 * them, so an agent whose kit sets state in a statement knows to copy those
 * lines itself (`libi.code_outline` with `includeSource`).
 */
import { analyzeBody, type TopLevelDecl } from "./code-scope";
import { isBuiltinName, type BodyFamily } from "./body-scope";

/** The assembled body may not exceed this (the 20 000-character cap is on the `body` PARAMETER only). */
export const MAX_ASSEMBLED_BODY_CHARS = 128 * 1024;

/** Entries one result lists per category, so a large kit cannot make the result large. */
const MAX_LISTED = 60;

export interface IncludeRequest {
  fromOverlayId: string;
  names?: string[];
}

export interface IncludedName {
  name: string;
  /** 1-based, in the SOURCE overlay's file. */
  sourceLine: number;
}

export interface IncludeReport {
  from: string;
  /** Declarations copied, one entry per name. */
  included: IncludedName[];
  /** Names not copied, and why. */
  skipped: Array<{ name: string; reason: string }>;
  /** Names the include was asked for, or needs, that the source does not declare. */
  unresolved: string[];
  /** Top-level statements of the source that are not declarations (never copied). */
  statementsLeftOut: number;
  /** 1-based line of the body's own first line in the assembled file. */
  bodyStartsAtLine: number;
  /** Set when a list above was cut. */
  truncated?: true;
}

export type IncludeOutcome =
  | { ok: true; body: string; report: IncludeReport }
  | { ok: false; error: string; hint?: string };

const BANNER_END = "// ── end include ──";

function banner(sourceId: string, count: number): string {
  return `// ── included by libi from overlay ${sourceId} (${count} declaration${count === 1 ? "" : "s"}). A COPY: editing it changes only this overlay. ──`;
}

/**
 * Assemble `newBody` with the declarations it needs from `sourceBody`.
 * `names` picks the roots; without it the roots are the new body's free names
 * (read, declared nowhere, not injected, not a global).
 */
export function assembleInclude(opts: {
  family: BodyFamily;
  newBody: string;
  sourceBody: string;
  sourceOverlayId: string;
  names?: readonly string[];
}): IncludeOutcome {
  const { family, newBody, sourceBody, sourceOverlayId } = opts;

  const src = analyzeBody(sourceBody);
  if (!src.ok) {
    return {
      ok: false,
      error: `overlay ${sourceOverlayId}'s body does not parse${src.error.line ? ` (line ${src.error.line}): ${src.error.message}` : `: ${src.error.message}`}`,
      hint: "Fix the source overlay first, or include from another overlay.",
    };
  }
  const dst = analyzeBody(newBody);
  if (!dst.ok) {
    return {
      ok: false,
      error: `the body does not parse${dst.error.line ? ` (line ${dst.error.line}): ${dst.error.message}` : `: ${dst.error.message}`}`,
      hint: "Nothing was written. Fix the syntax, then send it again with the same include.",
    };
  }
  const source = src.analysis;
  const mine = dst.analysis.topLevelNames;

  // Source declarations by every name they bind.
  const byName = new Map<string, TopLevelDecl>();
  for (const d of source.decls) for (const n of d.names) if (!byName.has(n)) byName.set(n, d);

  const skipped = new Map<string, string>();
  const unresolved = new Set<string>();
  const picked = new Set<TopLevelDecl>();
  const queue: string[] = [];

  const roots =
    opts.names && opts.names.length > 0
      ? [...new Set(opts.names)]
      : [...new Set(dst.analysis.free.map((r) => r.name))].filter((n) => !isBuiltinName(n, family));

  const want = (name: string, requested: boolean): void => {
    if (mine.has(name)) {
      // The new body's own version wins; only a name the caller asked for needs saying.
      if (requested || !skipped.has(name)) skipped.set(name, "the new body declares it; its version is kept");
      return;
    }
    const decl = byName.get(name);
    if (!decl) {
      if (source.topLevelNames.has(name)) {
        skipped.set(name, "the source sets it in a top-level statement that is not a declaration (not copied)");
      } else if (!isBuiltinName(name, family)) {
        unresolved.add(name);
      }
      return;
    }
    if (picked.has(decl)) return;
    // A destructuring that shares a name with the new body cannot be copied whole.
    const clash = decl.names.find((n) => mine.has(n));
    if (clash !== undefined) {
      for (const n of decl.names) {
        skipped.set(n, mine.has(n) ? "the new body declares it; its version is kept" : `declared together with \`${clash}\`, which the new body declares (not copied)`);
      }
      return;
    }
    picked.add(decl);
    queue.push(name);
  };

  for (const r of roots) want(r, true);
  while (queue.length > 0) {
    const decl = byName.get(queue.shift()!)!;
    for (const dep of decl.deps) want(dep, false);
    for (const f of decl.free) if (!mine.has(f.name) && !isBuiltinName(f.name, family)) unresolved.add(f.name);
  }
  // A requested name that resolved to a collision is only "skipped"; one that is both is not unresolved.
  for (const n of skipped.keys()) unresolved.delete(n);

  const ordered = [...picked].sort((a, b) => a.start - b.start);
  const left = source.nonDeclarationStatements;

  if (ordered.length === 0) {
    return {
      ok: true,
      body: newBody,
      report: finish({ sourceOverlayId, ordered, skipped, unresolved, left, startsAt: 1 }),
    };
  }

  const head = [banner(sourceOverlayId, ordered.length), ...ordered.map((d) => d.text), BANNER_END].join("\n");
  const body = `${head}\n${newBody}`;
  if (body.length > MAX_ASSEMBLED_BODY_CHARS) {
    return {
      ok: false,
      error: `the assembled body would be ${body.length} characters, over the ${MAX_ASSEMBLED_BODY_CHARS} limit`,
      hint: "Pass `names` to include only the helpers this body uses.",
    };
  }
  const startsAt = head.split("\n").length + 1;
  return { ok: true, body, report: finish({ sourceOverlayId, ordered, skipped, unresolved, left, startsAt }) };
}

function finish(a: {
  sourceOverlayId: string;
  ordered: TopLevelDecl[];
  skipped: Map<string, string>;
  unresolved: Set<string>;
  left: number;
  startsAt: number;
}): IncludeReport {
  const included: IncludedName[] = a.ordered.flatMap((d) => d.names.map((name) => ({ name: name.slice(0, 80), sourceLine: d.line })));
  const skipped = [...a.skipped].map(([name, reason]) => ({ name: name.slice(0, 80), reason }));
  const unresolved = [...a.unresolved].map((n) => n.slice(0, 80));
  const cut = included.length > MAX_LISTED || skipped.length > MAX_LISTED || unresolved.length > MAX_LISTED;
  return {
    from: a.sourceOverlayId,
    included: included.slice(0, MAX_LISTED),
    skipped: skipped.slice(0, MAX_LISTED),
    unresolved: unresolved.slice(0, MAX_LISTED),
    statementsLeftOut: a.left,
    bodyStartsAtLine: a.startsAt,
    ...(cut ? { truncated: true as const } : {}),
  };
}
