CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`session_id` text,
	`cli` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_repo_idx` ON `chat_messages` (`repo_id`,`created_at`);