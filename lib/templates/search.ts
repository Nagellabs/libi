/**
 * The FTS5 query builder for `templates_fts`, and the writer for its public
 * rows. Local rows are kept in sync by triggers on `templates` (scope
 * "local"); the cached public catalog (lib/templates/cloud/catalog-cache.ts)
 * writes its own rows here under scope "public", keyed by cloudId.
 */
import { sql } from "drizzle-orm";
import type { DbClient } from "@/lib/db/client";

const MAX_TOKENS = 8;

/**
 * Query → search tokens. A token is a run of letters, digits and combining
 * marks in ANY script, so a Hebrew, Cyrillic, Greek or CJK query matches
 * instead of tokenizing to nothing and listing every template.
 *
 * Marks stay INSIDE the token although `unicode61` itself treats them as
 * separators (its token characters are L*, N* and Co: "हिन्दी" is stored as
 * `ह | न | द`). That is deliberate: FTS5 re-tokenizes the text inside each
 * quoted phrase `buildMatchExpression` emits with the table's own tokenizer,
 * so a whole word becomes an ADJACENT-token phrase (`"ह न द"*`) — precise —
 * where splitting it here would send `ह`, `न`, `द` as separate AND-ed terms
 * that match anywhere. A token of marks alone becomes an empty phrase and
 * matches nothing. NFC first keeps the JS side canonical; `remove_diacritics`
 * already folds a decomposed "é" in the table.
 */
export function tokenize(query: string): string[] {
  return query
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS);
}

/** `"tok"* "tok2"*` — every token quoted (so FTS operators inside a token
 *  are literal) and prefix-matched; adjacent terms are an implicit AND. */
export function buildMatchExpression(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");
}

/** `db` or a transaction handle — anything that can run a statement. */
type FtsWriter = Pick<DbClient, "run">;

/**
 * Insert PUBLIC rows as they are — no per-row delete. Only for a scope that was
 * just cleared (`deleteFtsScope` in the same transaction): `ref_id` and `scope`
 * are UNINDEXED, so a `DELETE … WHERE ref_id = ?` per row scans the whole
 * table, and a 20k-entry replace done that way blocked for ~14 s. Local rows
 * belong to the triggers — never written here.
 */
export function insertFtsRows(
  db: FtsWriter,
  rows: Array<{ scope: "public"; refId: string; name: string; description: string; tags: string[] }>,
): void {
  if (rows.length === 0) return;
  const values = rows.map((r) => sql`(${r.refId}, ${r.scope}, ${r.name}, ${r.description}, ${r.tags.join(" ")})`);
  db.run(sql`INSERT INTO templates_fts(ref_id, scope, name, description, tags) VALUES ${sql.join(values, sql`, `)}`);
}

/** Drop every row of one scope. Only "public" — the local rows mirror `templates`. */
export function deleteFtsScope(db: FtsWriter, scope: "public"): void {
  db.run(sql`DELETE FROM templates_fts WHERE scope = ${scope}`);
}

export interface FtsHit {
  refId: string;
  scope: string;
  rank: number;
}

export function ftsSearch(
  db: DbClient,
  opts: { match: string; scope: "local" | "public" | "all"; limit: number },
): FtsHit[] {
  const scopeClause = opts.scope === "all" ? sql`` : sql` AND scope = ${opts.scope}`;
  return db
    .all<{ ref_id: string; scope: string; rank: number }>(
      sql`SELECT ref_id, scope, rank FROM templates_fts WHERE templates_fts MATCH ${opts.match}${scopeClause} ORDER BY rank LIMIT ${opts.limit}`,
    )
    .map((r) => ({ refId: r.ref_id, scope: r.scope, rank: r.rank }));
}
