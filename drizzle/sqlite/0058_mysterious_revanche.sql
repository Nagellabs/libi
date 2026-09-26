CREATE TABLE `social_post_intents` (
	`provider_id` text NOT NULL,
	`request_id` text NOT NULL,
	`piece_id` text,
	`provider_post_id` text,
	`mode` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`provider_id`, `request_id`),
	FOREIGN KEY (`piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_social_post_intents_piece` ON `social_post_intents` (`piece_id`);