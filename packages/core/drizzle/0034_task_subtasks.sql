ALTER TABLE `tasks` ADD `parent_task_id` text REFERENCES tasks(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `tasks` ADD `subtasks` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_task_id`);