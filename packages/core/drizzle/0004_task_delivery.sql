-- Finish: the summarizer's final summary and the squash commit message.
ALTER TABLE `tasks` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `squash_message` text;