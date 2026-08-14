CREATE TABLE `analysis_keyframes` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`step_id` text NOT NULL,
	`file_path` text NOT NULL,
	`frame_index` integer NOT NULL,
	`timestamp` real NOT NULL,
	`description` text,
	`skipped` integer DEFAULT false NOT NULL,
	`skip_reason` text,
	`custom` text,
	`source_modified_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `analysis_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_keyframes_file_frame_unique` ON `analysis_keyframes` (`file_id`,`frame_index`);--> statement-breakpoint
CREATE INDEX `analysis_keyframes_step_idx` ON `analysis_keyframes` (`step_id`);--> statement-breakpoint
CREATE TABLE `analysis_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`piece_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`content` text,
	`metadata` text,
	`error_message` text,
	`source_modified_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_steps_file_kind_unique` ON `analysis_steps` (`file_id`,`kind`);--> statement-breakpoint
DROP TABLE `video_analyses`;--> statement-breakpoint
DROP TABLE `video_analysis_artifacts`;