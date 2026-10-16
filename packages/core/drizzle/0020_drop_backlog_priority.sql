UPDATE `backlog_items` SET `position` = (
  SELECT `rn` FROM (
    SELECT `id`, ROW_NUMBER() OVER (
      PARTITION BY `repo_id`
      ORDER BY CASE `priority` WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, `position`, `created_at`
    ) - 1 AS `rn` FROM `backlog_items`
  ) `r` WHERE `r`.`id` = `backlog_items`.`id`
);--> statement-breakpoint
ALTER TABLE `backlog_items` DROP COLUMN `priority`;