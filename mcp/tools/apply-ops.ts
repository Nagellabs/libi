/**
 * `libi.apply_ops`: one op list, many pieces, one call.
 *
 * An op is an EXISTING editing tool (`update_overlay`, `audio_clip` + `action`, …) with its usual
 * arguments minus `pieceId`. There is no second implementation of any edit here: each op runs through
 * the registered tool's own validation and handler (`OpInvoker`, built from the server's registry), so a
 * rule the single tool enforces is enforced here, and a tool that changes its schema changes the op.
 *
 * Per piece the ops run in order inside a draft transaction (lib/composition/manifest-transaction.ts):
 * every handler reads and writes an in-memory copy of the manifest, and the piece is saved ONCE, only if
 * every op succeeded. A failed op therefore leaves that piece's draft exactly as it was, with no cleanup
 * to get wrong, and `dryRun` is the same run without the final save. Other pieces carry on.
 *
 * What may run is data (lib/agents/apply-ops-allowlist.ts). Everything is validated up front, across all
 * ops and all pieces, before the first write: a malformed list fails whole, naming op index and field.
 */
import { piecesByIds, piecesInFolder } from "@/mcp/tools/piece-targets";
import { isMergedToolName } from "@/lib/agents/merged-tools";
import {
  APPLY_OPS_ALLOWED,
  APPLY_OPS_REFUSAL_REASONS,
  applyOpsRefusal,
} from "@/lib/agents/apply-ops-allowlist";
import { beginManifestTransaction, ManifestChangedError } from "@/lib/composition/manifest-transaction";
import { holdRefreshQueries, notify } from "@/mcp/notify";
import { runInBatchContext } from "@/mcp/tools/batch-context";
import { withToolUsedSuppressed } from "@/mcp/analytics";
import { diffManifests } from "@/mcp/tools/apply-ops-diff";
import { mcpLogger as logger } from "@/lib/logger";
import type { ToolResult } from "@/mcp/tools/types";

export const APPLY_OPS_MAX_OPS = 100;
export const APPLY_OPS_MAX_PIECES = 50;

/** The ops' name for a value the batch binds: `as: "music"` makes `"$music"` mean this piece's new id. */
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const BINDING_REF = /^\$([A-Za-z_][A-Za-z0-9_]{0,39})$/;
/** Where a created id sits in a handler's `data`, newest-thing first (a split's head keeps its id; the tail is new). */
const CREATED_ID_FIELDS = ["newId", "tailId", "overlayId", "clipId"] as const;

export interface ApplyOpsTargets {
  pieceId?: string;
  pieceIds?: string[];
  folderId?: string;
  recursive?: boolean;
}

export interface ApplyOpsOp {
  op: string;
  action?: string;
  as?: string;
  perPiece?: Record<string, Record<string, unknown>>;
  [arg: string]: unknown;
}

export interface ApplyOpsParams {
  targets: ApplyOpsTargets;
  ops: ApplyOpsOp[];
  dryRun?: boolean;
}

export interface ArgIssue {
  path: string;
  message: string;
}

export interface OpOutcome {
  ok: boolean;
  /** The handler's `data`, when it returned an object. */
  data?: Record<string, unknown>;
  error?: string;
  hint?: string;
}

/** What the engine needs from the tool layer: check one op's arguments, run one op. */
export interface OpInvoker {
  validate(tool: string, action: string | undefined, args: Record<string, unknown>): Promise<ArgIssue[]>;
  call(tool: string, action: string | undefined, args: Record<string, unknown>, extra: unknown): Promise<OpOutcome>;
}

export interface ApplyOpsAnalytics {
  /** One event per OP of the list (tool + bounded action), not per piece. */
  toolUsed(tool: string, action?: string): void;
  /** One event per call, bounded buckets only. */
  run(params: { pieces: number; ops: number; dryRun: boolean; outcome: ApplyOpsOutcomeKind }): void;
}

export type ApplyOpsOutcomeKind = "applied" | "partial" | "failed" | "dry_run" | "invalid";

export interface ApplyOpsDeps {
  invoker: OpInvoker;
  analytics?: ApplyOpsAnalytics;
}

/** One op, once its meta fields are pulled off. */
interface PlannedOp {
  index: number;
  tool: string;
  /** Short name for messages: `update_overlay`, `audio_clip enable`. */
  label: string;
  action?: string;
  as?: string;
  args: Record<string, unknown>;
  perPiece: Record<string, Record<string, unknown>>;
  effect: "manifest" | "piece-row";
}

export interface PieceOpError {
  op: number;
  tool: string;
  error: string;
  field?: string;
  hint?: string;
}

type PieceStatus = "applied" | "unchanged" | "dry_run" | "rolled_back" | "refused";

interface PieceReport {
  pieceId: string;
  name?: string;
  status: PieceStatus;
  /** Lines, or "same as <pieceId>" when this piece's changes read exactly like an earlier piece's. */
  changes?: string[] | string;
  bindings?: Record<string, string>;
  errors?: PieceOpError[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A property whose string value (or array of strings) is an id a binding may stand in for. */
function isIdKey(key: string): boolean {
  return /Ids?$/.test(key) || key === "overlayIdsInZOrder";
}

/** Every `$name` reference in `args`' id-valued fields, with its path. */
function bindingRefs(value: unknown, key: string, path: string, out: { name: string; path: string }[]): void {
  if (typeof value === "string") {
    const m = isIdKey(key) ? BINDING_REF.exec(value) : null;
    if (m) out.push({ name: m[1], path });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => bindingRefs(v, key, `${path}[${i}]`, out));
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) bindingRefs(v, k, path ? `${path}.${k}` : k, out);
  }
}

/** `value` with every `$name` in an id field replaced by this piece's bound id. Unknown names throw. */
function resolveBindings(value: unknown, key: string, bound: Readonly<Record<string, string>>, path: string): unknown {
  if (typeof value === "string") {
    const m = isIdKey(key) ? BINDING_REF.exec(value) : null;
    if (!m) return value;
    const id = bound[m[1]];
    if (id === undefined) throw Object.assign(new Error(`"${value}" is not bound on this piece`), { path });
    return id;
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveBindings(v, key, bound, `${path}[${i}]`));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveBindings(v, k, bound, path ? `${path}.${k}` : k)]));
  }
  return value;
}

function allowedOpsHint(): string {
  return Object.entries(APPLY_OPS_ALLOWED)
    .map(([tool, a]) => `${tool.slice("libi.".length)}${a.actions ? ` (${a.actions.join("|")})` : ""}`)
    .join(", ");
}

/** Pull the meta fields off each op, refuse what a batch may not run, check names and references. */
function planOps(ops: ApplyOpsOp[], issues: { op: number; field: string; message: string }[]): PlannedOp[] {
  const planned: PlannedOp[] = [];
  const bound = new Set<string>();
  ops.forEach((raw, index) => {
    const issue = (field: string, message: string) => issues.push({ op: index, field, message });
    const { op, action, as, perPiece, ...args } = raw as ApplyOpsOp;
    if (typeof op !== "string" || op.length === 0) {
      issue("op", "needs `op`: the tool's name without the `libi.` prefix, e.g. \"update_overlay\".");
      return;
    }
    const tool = op.startsWith("libi.") ? op : `libi.${op}`;
    const merged = isMergedToolName(tool);
    if (action !== undefined && typeof action !== "string") {
      issue("action", "must be a string.");
      return;
    }
    const label = `${tool.slice("libi.".length)}${action ? ` ${action}` : ""}`;

    const refusal = applyOpsRefusal(tool, action);
    if (refusal) {
      issue("op", `${label} is not allowed in a batch: ${APPLY_OPS_REFUSAL_REASONS[refusal]}.`);
      return;
    }
    const allowance = APPLY_OPS_ALLOWED[tool];
    if (!allowance) {
      issue("op", `unknown op "${op}". Allowed: ${allowedOpsHint()}.`);
      return;
    }
    if (merged && allowance.actions) {
      if (action === undefined || !allowance.actions.includes(action)) {
        issue(
          "action",
          `${tool.slice("libi.".length)} needs \`action\`: one of ${allowance.actions.join(", ")}` +
            (action === undefined ? "." : `; "${action}" is not allowed in a batch.`),
        );
        return;
      }
    } else if (action !== undefined) {
      issue("action", `${tool.slice("libi.".length)} has no actions; remove \`action\`.`);
      return;
    }
    if (Object.hasOwn(args, "pieceId")) {
      issue("pieceId", "is set by `targets`; remove it from the op.");
      return;
    }
    for (const [field, reason] of Object.entries(allowance.refuseFields ?? {})) {
      if (Object.hasOwn(args, field)) issue(field, `is not allowed in a batch: ${reason}.`);
    }
    if (as !== undefined) {
      if (typeof as !== "string" || !BINDING_NAME.test(as)) {
        issue("as", "must be a short name: letters, digits and _, not starting with a digit (e.g. \"music\").");
      } else if (bound.has(as)) {
        issue("as", `"${as}" is already bound by an earlier op.`);
      }
    }
    if (perPiece !== undefined) {
      if (!isRecord(perPiece) || !Object.values(perPiece).every(isRecord)) {
        issue("perPiece", "must map a pieceId to an object of arguments that replace the op's own for that piece.");
      } else {
        for (const [pid, overrides] of Object.entries(perPiece)) {
          for (const reserved of ["op", "action", "as", "perPiece", "pieceId"]) {
            if (Object.hasOwn(overrides, reserved)) issue(`perPiece.${pid}.${reserved}`, "cannot be overridden per piece.");
          }
        }
      }
    }
    const refs: { name: string; path: string }[] = [];
    bindingRefs({ ...args, ...(isRecord(perPiece) ? { perPiece } : {}) }, "", "", refs);
    for (const ref of refs) {
      if (!bound.has(ref.name)) {
        issue(ref.path, `"$${ref.name}" is not bound by an earlier op: add \`as: "${ref.name}"\` to the op that creates it, before this one.`);
      }
    }
    if (typeof as === "string" && BINDING_NAME.test(as)) bound.add(as);
    planned.push({
      index,
      tool,
      label,
      ...(action ? { action } : {}),
      ...(typeof as === "string" ? { as } : {}),
      args,
      perPiece: isRecord(perPiece) ? (perPiece as Record<string, Record<string, unknown>>) : {},
      effect: allowance.effect,
    });
  });
  return planned;
}

interface ResolvedTargets {
  pieces: { id: string; name: string }[];
  /** Ids the caller named that are not pieces: refused alone, the rest carry on. */
  unknown: string[];
}

/** The pieces the targets name, or a message when the targets themselves are unusable. */
function resolveTargets(targets: ApplyOpsTargets): ResolvedTargets | { error: string } {
  const named = [targets.pieceId !== undefined, targets.pieceIds !== undefined, targets.folderId !== undefined].filter(Boolean).length;
  if (named !== 1) return { error: "targets needs exactly one of pieceId, pieceIds, folderId." };
  if (targets.recursive !== undefined && targets.folderId === undefined) return { error: "targets.recursive only goes with folderId." };

  if (targets.folderId !== undefined) {
    const found = piecesInFolder(targets.folderId, targets.recursive);
    if ("missing" in found) return { error: `targets.folderId: no folder ${targets.folderId} (libi.piece_folder action list shows the ids).` };
    if ("empty" in found) {
      return { error: `targets.folderId: folder ${targets.folderId} holds no pieces${targets.recursive ? "" : " (pass recursive: true to include its subfolders)"}.` };
    }
    return { pieces: found.pieces, unknown: [] };
  }

  const requested = targets.pieceId !== undefined ? [targets.pieceId] : [...new Set(targets.pieceIds ?? [])];
  if (requested.length === 0) return { error: "targets.pieceIds is empty." };
  return piecesByIds(requested);
}

function bucketPieces(n: number): number {
  return n <= 1 ? 1 : n <= 5 ? 5 : n <= 20 ? 20 : 50;
}
function bucketOps(n: number): number {
  return n <= 3 ? 3 : n <= 10 ? 10 : n <= 30 ? 30 : 100;
}

function trim(text: string | undefined, max = 400): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describePieceRowOp(op: PlannedOp, args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof args.name === "string") parts.push(`name → ${JSON.stringify(trim(args.name, 60))}`);
  if (typeof args.description === "string") parts.push("description updated");
  return `piece: ${parts.join(", ") || op.label}`;
}

/** Run the planned ops on one piece. Never throws: every failure is the piece's report. */
async function runPiece(
  piece: { id: string; name: string },
  ops: PlannedOp[],
  dryRun: boolean,
  deps: ApplyOpsDeps,
  extra: unknown,
): Promise<{ report: PieceReport; notes: string[]; refreshes: { queryKey: string; pieceId?: string }[] }> {
  const report: PieceReport = { pieceId: piece.id, name: piece.name, status: "applied" };
  const notes: string[] = [];
  const bindings: Record<string, string> = {};
  const rowOps: { op: PlannedOp; args: Record<string, unknown> }[] = [];
  const rowLines: string[] = [];
  const fail = (op: PlannedOp, error: string, extraFields: Partial<PieceOpError> = {}) => {
    report.errors = [...(report.errors ?? []), { op: op.index, tool: op.label, error, ...extraFields }];
    report.status = "rolled_back";
  };

  let txn;
  try {
    txn = await beginManifestTransaction(piece.id);
  } catch (err) {
    report.status = "refused";
    report.errors = [{ op: -1, tool: "apply_ops", error: `could not read the piece: ${err instanceof Error ? err.message : String(err)}` }];
    return { report, notes, refreshes: [] };
  }

  const { refreshes } = await holdRefreshQueries(async () => {
    for (const op of ops) {
      let args: Record<string, unknown>;
      try {
        args = resolveBindings({ ...op.args, ...(op.perPiece[piece.id] ?? {}) }, "", bindings, "") as Record<string, unknown>;
      } catch (err) {
        const path = (err as { path?: string }).path;
        fail(op, (err as Error).message, path ? { field: path } : {});
        return;
      }
      const callArgs = { ...args, pieceId: piece.id };

      if (op.effect === "piece-row") {
        // Checked now (so a bad one rolls the piece back), run once the manifest has been saved.
        const issues = await deps.invoker.validate(op.tool, op.action, callArgs);
        if (issues.length > 0) {
          fail(op, issues.map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`).join("; "), issues[0].path ? { field: issues[0].path } : {});
          return;
        }
        rowOps.push({ op, args: callArgs });
        rowLines.push(describePieceRowOp(op, callArgs));
        continue;
      }

      let outcome: OpOutcome;
      try {
        outcome = await txn.run(() => withToolUsedSuppressed(() => runInBatchContext(() => deps.invoker.call(op.tool, op.action, callArgs, extra))));
      } catch (err) {
        outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!outcome.ok) {
        fail(op, trim(outcome.error) ?? "the op failed", { ...(outcome.hint ? { hint: trim(outcome.hint) } : {}) });
        return;
      }
      if (op.as) {
        const id = CREATED_ID_FIELDS.map((f) => outcome.data?.[f]).find((v): v is string => typeof v === "string");
        if (!id) {
          fail(op, `\`as: "${op.as}"\` found no new id in the result of ${op.label}, so nothing can be bound to it.`, { field: "as" });
          return;
        }
        bindings[op.as] = id;
      }
      const data = outcome.data;
      if (data?.musicMatchSkipped === true) notes.push("A copyrighted song was added without a platform match (a batch never calls out); match it on its own, or in the Posting tab.");
    }
  });

  if (Object.keys(bindings).length > 0) report.bindings = bindings;
  if (report.status === "rolled_back") {
    // Nothing was written: the transaction is simply dropped. Held refreshes are dropped with it.
    return { report, notes, refreshes: [] };
  }

  const lines = [...diffManifests(txn.baseline, txn.working, bindings), ...rowLines];
  report.changes = lines;
  if (dryRun) {
    report.status = "dry_run";
    return { report, notes, refreshes: [] };
  }
  // Nothing the diff can name changed (an op set a field to the value it had): no draft is written for it.
  if (lines.length === 0) {
    report.status = "unchanged";
    return { report, notes, refreshes: [] };
  }
  try {
    await txn.commit();
  } catch (err) {
    report.status = err instanceof ManifestChangedError ? "refused" : "rolled_back";
    report.changes = undefined;
    report.errors = [{ op: -1, tool: "apply_ops", error: err instanceof Error ? err.message : String(err) }];
    return { report, notes, refreshes: [] };
  }
  for (const row of rowOps) {
    let outcome: OpOutcome;
    try {
      outcome = await withToolUsedSuppressed(() => deps.invoker.call(row.op.tool, row.op.action, row.args, extra));
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!outcome.ok) {
      report.errors = [...(report.errors ?? []), { op: row.op.index, tool: row.op.label, error: `ran after the timeline was saved and failed: ${trim(outcome.error) ?? "unknown error"}` }];
    }
  }
  // The held refreshes, plus the two the editor needs after any save (the timeline, and the draft badge), once each.
  const toSend = new Map<string, { queryKey: string; pieceId?: string }>();
  for (const r of [...refreshes, { queryKey: "composition", pieceId: piece.id }, { queryKey: "piece-state", pieceId: piece.id }]) {
    toSend.set(JSON.stringify([r.queryKey, r.pieceId, (r as { fileId?: string }).fileId, (r as { trackId?: string }).trackId]), r);
  }
  return { report, notes, refreshes: [...toSend.values()] };
}

function bucketOutcome(reports: PieceReport[], dryRun: boolean): ApplyOpsOutcomeKind {
  const failed = reports.filter((r) => r.status === "rolled_back" || r.status === "refused").length;
  if (failed === reports.length) return "failed";
  if (failed > 0) return "partial";
  return dryRun ? "dry_run" : "applied";
}

const invalid = (error: string, errors?: unknown[]): ToolResult => ({
  success: false,
  error,
  ...(errors ? { data: { errors } } : {}),
});

export async function applyOps(params: ApplyOpsParams, deps: ApplyOpsDeps, extra?: unknown): Promise<ToolResult> {
  const { targets, ops, dryRun = false } = params;
  const analytics = deps.analytics;
  const refuse = (message: string, errors?: unknown[]) => {
    analytics?.run({ pieces: 0, ops: Math.min(ops.length, APPLY_OPS_MAX_OPS), dryRun, outcome: "invalid" });
    return invalid(message, errors);
  };

  if (ops.length === 0) return refuse("ops is empty.");
  if (ops.length > APPLY_OPS_MAX_OPS) return refuse(`ops has ${ops.length} entries; the limit is ${APPLY_OPS_MAX_OPS}. Split it across calls.`);
  const resolved = resolveTargets(targets);
  if ("error" in resolved) return refuse(resolved.error);
  if (resolved.pieces.length + resolved.unknown.length > APPLY_OPS_MAX_PIECES) {
    return refuse(`targets names ${resolved.pieces.length + resolved.unknown.length} pieces; the limit is ${APPLY_OPS_MAX_PIECES}. Split it across calls.`);
  }

  // Validate everything before the first write: names, refusals, references, then each op's arguments
  // against the real tool schema, for every piece (an override can differ per piece).
  const issues: { op: number; field: string; message: string }[] = [];
  const planned = planOps(ops, issues);
  {
    const seen = new Set<string>();
    for (const op of planned) {
      for (const piece of resolved.pieces.length > 0 ? resolved.pieces : [{ id: "piece", name: "" }]) {
        const probe = { ...op.args, ...(op.perPiece[piece.id] ?? {}), pieceId: piece.id };
        // A reference stands in for an id the piece has not made yet: validate the shape with a stand-in id.
        const standIn = resolveBindings(probe, "", new Proxy({}, { get: () => "binding" }), "") as Record<string, unknown>;
        const argIssues = await deps.invoker.validate(op.tool, op.action, standIn);
        for (const i of argIssues) {
          const key = `${op.index}|${i.path}|${i.message}`;
          if (seen.has(key)) continue;
          seen.add(key);
          issues.push({ op: op.index, field: i.path, message: i.message });
        }
      }
    }
  }
  if (issues.length > 0) {
    issues.sort((a, b) => a.op - b.op);
    const errors = issues.map((i) => ({ op: i.op, ...(i.field ? { field: i.field } : {}), error: i.message }));
    return refuse(
      `invalid ops: ${issues.slice(0, 5).map((i) => `ops[${i.op}]${i.field ? `.${i.field}` : ""}: ${i.message}`).join(" | ")}${issues.length > 5 ? ` (+${issues.length - 5} more, see data.errors)` : ""}. Nothing was changed.`,
      errors,
    );
  }

  for (const op of planned) analytics?.toolUsed(op.tool, op.action);

  const reports: PieceReport[] = [];
  const notes = new Set<string>();
  const sentRefreshes: { queryKey: string; pieceId?: string }[] = [];
  for (const id of resolved.unknown) {
    reports.push({ pieceId: id, status: "refused", errors: [{ op: -1, tool: "apply_ops", error: "no such piece" }] });
  }
  for (const piece of resolved.pieces) {
    const done = await runPiece(piece, planned, dryRun, deps, extra);
    reports.push(done.report);
    for (const note of done.notes) notes.add(note);
    sentRefreshes.push(...done.refreshes);
  }
  // One refresh per query per piece, however many ops touched it.
  for (const r of sentRefreshes) notify.refreshQuery(r);

  // A piece whose changes read exactly like an earlier piece's says so instead of repeating them.
  // (Ids the batch bound differ per piece, so they are compared by their name: `$music=clip_x` is `$music`.)
  const firstWith = new Map<string, string>();
  for (const r of reports) {
    if (!Array.isArray(r.changes) || r.changes.length === 0) continue;
    const key = JSON.stringify(r.changes.map((line) => line.replace(/\$(\w+)=\S+/g, "$$$1")));
    const earlier = firstWith.get(key);
    if (earlier) r.changes = `same as ${earlier}`;
    else firstWith.set(key, r.pieceId);
  }

  const outcome = bucketOutcome(reports, dryRun);
  analytics?.run({ pieces: bucketPieces(reports.length), ops: bucketOps(planned.length), dryRun, outcome });

  const count = (s: PieceStatus) => reports.filter((r) => r.status === s).length;
  const failed = count("rolled_back") + count("refused");
  const summary =
    `${dryRun ? "dry run: " : ""}${reports.length} piece${reports.length === 1 ? "" : "s"}, ${planned.length} op${planned.length === 1 ? "" : "s"}: ` +
    [
      count("applied") ? `${count("applied")} applied` : "",
      count("dry_run") ? `${count("dry_run")} would apply` : "",
      count("unchanged") ? `${count("unchanged")} unchanged` : "",
      count("rolled_back") ? `${count("rolled_back")} rolled back` : "",
      count("refused") ? `${count("refused")} refused` : "",
    ].filter(Boolean).join(", ");
  logger.info(
    { tag: "apply-ops", op: "run", pieces: reports.length, ops: planned.length, dryRun, applied: count("applied"), failed },
    "apply_ops finished",
  );
  return {
    success: failed === 0,
    ...(failed > 0 ? { error: `${failed} of ${reports.length} pieces were not changed (see pieces[].errors); the rest ${dryRun ? "would apply" : "were applied"}.` } : {}),
    data: {
      summary,
      dryRun,
      written: dryRun ? false : count("applied") > 0,
      pieces: reports,
      ...(notes.size > 0 ? { notes: [...notes] } : {}),
    },
  };
}

