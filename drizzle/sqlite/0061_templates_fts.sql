CREATE VIRTUAL TABLE templates_fts USING fts5(ref_id UNINDEXED, scope UNINDEXED, name, description, tags, tokenize = 'unicode61');
--> statement-breakpoint
CREATE TRIGGER templates_fts_ai AFTER INSERT ON templates BEGIN
  INSERT INTO templates_fts(ref_id, scope, name, description, tags)
  VALUES (new.id, 'local', new.name, new.description,
    (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)));
END;
--> statement-breakpoint
CREATE TRIGGER templates_fts_ad AFTER DELETE ON templates BEGIN
  DELETE FROM templates_fts WHERE ref_id = old.id AND scope = 'local';
END;
--> statement-breakpoint
CREATE TRIGGER templates_fts_au AFTER UPDATE OF name, description, tags ON templates BEGIN
  DELETE FROM templates_fts WHERE ref_id = old.id AND scope = 'local';
  INSERT INTO templates_fts(ref_id, scope, name, description, tags)
  VALUES (new.id, 'local', new.name, new.description,
    (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)));
END;
