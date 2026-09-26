CREATE TABLE `template_uses` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`piece_id` text,
	`used_at` integer DEFAULT (unixepoch()) NOT NULL,
	`reported` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_template_uses_template_used` ON `template_uses` (`template_id`,`used_at`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`origin` text DEFAULT 'local' NOT NULL,
	`cloud_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_from_piece_id` text,
	`has_code` integer DEFAULT false NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_from_piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_templates_origin_updated` ON `templates` (`origin`,`updated_at`);