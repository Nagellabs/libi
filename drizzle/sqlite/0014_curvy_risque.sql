CREATE TABLE `analysis_audio_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`step_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`start_seconds` real NOT NULL,
	`end_seconds` real NOT NULL,
	`file_path` text,
	`status` text DEFAULT 'not_started' NOT NULL,
	`text` text,
	`words` text,
	`language` text,
	`language_probability` real,
	`error_message` text,
	`source_modified_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `analysis_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_audio_chunks_file_chunk_unique` ON `analysis_audio_chunks` (`file_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `analysis_audio_chunks_step_idx` ON `analysis_audio_chunks` (`step_id`);