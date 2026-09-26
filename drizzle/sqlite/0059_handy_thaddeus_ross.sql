CREATE TABLE `social_ad_links` (
	`provider_id` text NOT NULL,
	`provider_ad_id` text NOT NULL,
	`platform_ad_id` text,
	`piece_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`provider_id`, `provider_ad_id`),
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_social_ad_links_piece` ON `social_ad_links` (`piece_id`);