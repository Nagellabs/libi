/**
 * The FTS5 index over templates — ONE definition, used by the custom
 * migration (`drizzle/sqlite/0061_templates_fts.sql`, which must equal
 * `TEMPLATES_FTS_MIGRATION_SQL` byte for byte; a unit test pins it) and by
 * the in-memory test DB (`__tests__/helpers/test-db.ts`).
 *
 * A STANDALONE FTS table rather than an external-content one on purpose:
 * external content can only mirror a single table, and sub-project 3 adds
 * cached public-catalog rows under `scope = 'public'` from ANOTHER table.
 * `ref_id` is the row id in whichever table owns the row (`templates.id`
 * for `scope = 'local'`).
 *
 * `tags` is indexed as the JSON array's values joined by spaces (json_each),
 * so `"name-card"` tokenises as `name` + `card` under unicode61 and a search
 * for either finds it.
 */
export const TEMPLATES_FTS_STATEMENTS: readonly string[] = [
  `CREATE VIRTUAL TABLE templates_fts USING fts5(ref_id UNINDEXED, scope UNINDEXED, name, description, tags, tokenize = 'unicode61');`,
  `CREATE TRIGGER templates_fts_ai AFTER INSERT ON templates BEGIN
  INSERT INTO templates_fts(ref_id, scope, name, description, tags)
  VALUES (new.id, 'local', new.name, new.description,
    (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)));
END;`,
  `CREATE TRIGGER templates_fts_ad AFTER DELETE ON templates BEGIN
  DELETE FROM templates_fts WHERE ref_id = old.id AND scope = 'local';
END;`,
  `CREATE TRIGGER templates_fts_au AFTER UPDATE OF name, description, tags ON templates BEGIN
  DELETE FROM templates_fts WHERE ref_id = old.id AND scope = 'local';
  INSERT INTO templates_fts(ref_id, scope, name, description, tags)
  VALUES (new.id, 'local', new.name, new.description,
    (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)));
END;`,
];

/** The custom migration's exact contents (drizzle's statement separator). */
export const TEMPLATES_FTS_MIGRATION_SQL = TEMPLATES_FTS_STATEMENTS.join("\n--> statement-breakpoint\n") + "\n";
