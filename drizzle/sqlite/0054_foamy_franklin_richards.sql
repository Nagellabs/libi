CREATE TABLE `skill_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`scope` text NOT NULL,
	`folder_path` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_synced_at` integer,
	`last_error` text,
	`skipped_names` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_installs_level_unique` ON `skill_installs` (`agent_id`,`scope`,`folder_path`);