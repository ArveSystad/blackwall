ALTER TABLE `repos` ADD `watch_ci` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `ci` text;