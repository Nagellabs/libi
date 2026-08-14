CREATE TABLE `tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`subject_id` text,
	`label` text,
	`method` text NOT NULL,
	`framerate` real NOT NULL,
	`duration_sec` real NOT NULL,
	`sample_count` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
