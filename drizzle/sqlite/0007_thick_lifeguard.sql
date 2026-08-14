CREATE TABLE `video_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`piece_id` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`error_message` text,
	`started_at` integer,
	`last_updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_analyses_file_id_unique` ON `video_analyses` (`file_id`);--> statement-breakpoint
CREATE TABLE `video_analysis_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`content` text,
	`file_path` text,
	`metadata` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `video_analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `user_system_prompt` text;