ALTER TABLE `repos` ADD `default_cli` text DEFAULT 'claude' NOT NULL;
--> statement-breakpoint
UPDATE `repos` SET `default_cli` = 'copilot' WHERE lower(`remote_url`) LIKE '%//jbf.ghe.com%' OR lower(`remote_url`) LIKE '%@jbf.ghe.com%';