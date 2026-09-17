CREATE TABLE `legacy_provider_keys` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`env_vars` text NOT NULL,
	`shown_at` integer
);
--> statement-breakpoint
ALTER TABLE `files` DROP COLUMN `fal_uploaded_url`;--> statement-breakpoint
ALTER TABLE `mcp_servers` DROP COLUMN `enabled`;