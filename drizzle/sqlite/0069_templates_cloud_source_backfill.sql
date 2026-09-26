-- Which catalog each existing cloud link and use belongs to (lib/templates/cloud/catalog-source.ts).
-- A link to one of the test-mode fixture's seed ids (FIXTURE_CLOUD_IDS) is the fixture's;
-- every other link is the production site's, the one catalog a released libi ever read.
UPDATE `templates` SET `cloud_source` = CASE
  WHEN coalesce(`cloud_id`, CASE WHEN json_valid(`publish_pending`) THEN json_extract(`publish_pending`, '$.cloudId') END)
    IN ('aaaaaaaaaaaaaaaaaaa2', 'bbbbbbbbbbbbbbbbbbb3', 'ccccccccccccccccccc4') THEN 'test-mode'
  ELSE 'https://libi.nagellabs.com'
END
WHERE `cloud_id` IS NOT NULL OR `publish_pending` IS NOT NULL;
--> statement-breakpoint
UPDATE `template_uses` SET `source` = coalesce(
  (SELECT `cloud_source` FROM `templates` WHERE `templates`.`id` = `template_uses`.`template_id` AND `cloud_source` = 'test-mode'),
  'https://libi.nagellabs.com'
);
