DROP INDEX `chat_messages_repo_idx`;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `task_id` text REFERENCES tasks(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `chat_messages_repo_idx` ON `chat_messages` (`repo_id`,`task_id`,`created_at`);