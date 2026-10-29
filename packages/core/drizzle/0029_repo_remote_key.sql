ALTER TABLE `repos` ADD `remote_key` text;--> statement-breakpoint
CREATE INDEX `repos_remote_key_idx` ON `repos` (`remote_key`);