ALTER TABLE `steps` ADD `input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `steps` ADD `output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `steps` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `steps` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `steps` ADD `cost_usd` real;--> statement-breakpoint
-- Backfill from the stored event logs: per token field, the larger of the streamed usage events and the results.
UPDATE `steps` SET `input_tokens` = MAX(
	COALESCE((SELECT SUM(json_extract(`payload`, '$.usage.inputTokens')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'usage'), 0),
	COALESCE((SELECT SUM(json_extract(`payload`, '$.result.usage.inputTokens')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'result'), 0)
);--> statement-breakpoint
UPDATE `steps` SET `output_tokens` = MAX(
	COALESCE((SELECT SUM(json_extract(`payload`, '$.usage.outputTokens')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'usage'), 0),
	COALESCE((SELECT SUM(json_extract(`payload`, '$.result.usage.outputTokens')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'result'), 0)
);--> statement-breakpoint
UPDATE `steps` SET `cache_read_tokens` = MAX(
	COALESCE((SELECT SUM(json_extract(`payload`, '$.usage.cacheReadTokens')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'usage'), 0),
	COALESCE((SELECT SUM(json_extract(`payload`, '$.result.usage.cacheReadTokens')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'result'), 0)
);--> statement-breakpoint
UPDATE `steps` SET `cache_write_tokens` = MAX(
	COALESCE((SELECT SUM(json_extract(`payload`, '$.usage.cacheWriteTokens')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'usage'), 0),
	COALESCE((SELECT SUM(json_extract(`payload`, '$.result.usage.cacheWriteTokens')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'result'), 0)
);--> statement-breakpoint
-- Cost: the usage events' (OpenCode), else the results' (Claude); null when neither reported one.
UPDATE `steps` SET `cost_usd` = COALESCE(
	(SELECT SUM(json_extract(`payload`, '$.usage.costUsd')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'usage'),
	(SELECT SUM(json_extract(`payload`, '$.result.usage.costUsd')) FROM `step_events` WHERE `step_id` = `steps`.`id` AND `type` = 'result')
);
