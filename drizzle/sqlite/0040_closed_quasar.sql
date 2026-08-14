CREATE TABLE `model_schemas` (
	`id` text PRIMARY KEY NOT NULL,
	`api_url` text NOT NULL,
	`model` text NOT NULL,
	`schema_json` text NOT NULL,
	`source` text,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_schemas_key_idx` ON `model_schemas` (`api_url`,`model`);