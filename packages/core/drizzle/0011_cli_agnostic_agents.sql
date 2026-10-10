ALTER TABLE `agents` ADD `models` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `backlog_items` ADD `agent_clis` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `steps` ADD `cli` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `cli` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `agent_clis` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE `agents` SET `models` = CASE WHEN `model` IS NULL THEN '{}' ELSE json_object(`cli`, `model`) END;--> statement-breakpoint
UPDATE `agents` SET `permission_overrides` = CASE WHEN `permission_overrides` = '{}' THEN '{}' ELSE json_object(`cli`, json(`permission_overrides`)) END;--> statement-breakpoint
UPDATE `tasks` SET `cli` = (SELECT `default_cli` FROM `repos` WHERE `repos`.`id` = `tasks`.`repo_id`);--> statement-breakpoint
UPDATE `tasks` SET `agent_clis` = COALESCE((
  SELECT json_group_object(`id`, `cli`) FROM (
    SELECT DISTINCT `a`.`id`, `a`.`cli`
    FROM json_tree(`tasks`.`agents`) `jt`
    JOIN `agents` `a` ON `a`.`id` = `jt`.`value`
    WHERE `jt`.`type` = 'text' AND `a`.`cli` != `tasks`.`cli`
  )
), '{}');--> statement-breakpoint
UPDATE `backlog_items` SET `agent_clis` = COALESCE((
  SELECT json_group_object(`id`, `cli`) FROM (
    SELECT DISTINCT `a`.`id`, `a`.`cli`
    FROM json_tree(`backlog_items`.`agents`) `jt`
    JOIN `agents` `a` ON `a`.`id` = `jt`.`value`
    JOIN `repos` `r` ON `r`.`id` = `backlog_items`.`repo_id`
    WHERE `jt`.`type` = 'text' AND `a`.`cli` != `r`.`default_cli`
  )
), '{}');--> statement-breakpoint
UPDATE `steps` SET `cli` = (SELECT `cli` FROM `agents` WHERE `agents`.`id` = `steps`.`agent_id`);--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `cli`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `model`;
