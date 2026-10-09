CREATE TABLE `backlog_items` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`title` text NOT NULL,
	`origin` text NOT NULL,
	`mode` text,
	`free_text` text DEFAULT '' NOT NULL,
	`agents` text DEFAULT '{}' NOT NULL,
	`triage_mode` text DEFAULT 'intervene' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`task_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `backlog_items_repo_status_idx` ON `backlog_items` (`repo_id`,`status`);