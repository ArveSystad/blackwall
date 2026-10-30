ALTER TABLE `backlog_items` ADD `in_repo` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `default_in_repo` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `in_repo` integer DEFAULT false NOT NULL;