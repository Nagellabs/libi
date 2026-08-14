ALTER TABLE `jobs` ADD `client_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_client_key_idx` ON `jobs` (`client_key`);