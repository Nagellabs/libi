ALTER TABLE `video_analyses` ADD `source_modified_at` integer;--> statement-breakpoint
ALTER TABLE `video_analysis_artifacts` ADD `frame_index` integer;--> statement-breakpoint
ALTER TABLE `video_analysis_artifacts` ADD `timestamp` real;--> statement-breakpoint
ALTER TABLE `video_analysis_artifacts` ADD `source_modified_at` integer;--> statement-breakpoint
DELETE FROM video_analysis_artifacts WHERE kind = 'annotation';--> statement-breakpoint
UPDATE video_analysis_artifacts SET timestamp = CAST(json_extract(metadata, '$.timestamp') AS REAL) WHERE kind = 'keyframe' AND metadata IS NOT NULL AND timestamp IS NULL;
