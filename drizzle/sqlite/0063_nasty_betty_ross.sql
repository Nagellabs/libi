CREATE TABLE `catalog_index` (
	`cloud_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`nickname` text DEFAULT '' NOT NULL,
	`author_id` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`has_code` integer DEFAULT false NOT NULL,
	`canvas_width` integer NOT NULL,
	`canvas_height` integer NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`slot_count` integer DEFAULT 0 NOT NULL,
	`poster` text NOT NULL,
	`video` text NOT NULL,
	`uses_total` integer DEFAULT 0 NOT NULL,
	`uses_7d` integer DEFAULT 0 NOT NULL,
	`heat` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_catalog_index_uses7d` ON `catalog_index` (`uses_7d`);--> statement-breakpoint
CREATE TABLE `catalog_index_meta` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`etag` text,
	`fetched_at` integer
);
