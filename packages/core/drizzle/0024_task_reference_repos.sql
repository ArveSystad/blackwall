ALTER TABLE `backlog_items` ADD `reference_repo_ids` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `reference_repo_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `tasks` SET `reference_repo_ids` = COALESCE((SELECT `reference_repo_ids` FROM `repos` WHERE `repos`.`id` = `tasks`.`repo_id`), '[]');