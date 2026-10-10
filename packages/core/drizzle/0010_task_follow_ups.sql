ALTER TABLE `backlog_items` ADD `source_task_id` text REFERENCES tasks(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `tasks` ADD `follow_ups` text DEFAULT '[]' NOT NULL;