CREATE TABLE `social_post_links` (
	`provider_id` text NOT NULL,
	`provider_post_id` text NOT NULL,
	`piece_id` text NOT NULL,
	`export_path` text,
	`request_id` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_status` text,
	`last_status_at` integer,
	PRIMARY KEY(`provider_id`, `provider_post_id`),
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_social_post_links_piece` ON `social_post_links` (`piece_id`);--> statement-breakpoint
ALTER TABLE `settings` ADD `social` text;