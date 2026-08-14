DROP INDEX `skills_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_source_unique` ON `skills` (`name`,`source`);