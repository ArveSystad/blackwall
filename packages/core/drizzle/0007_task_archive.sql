-- Archive: when the user archived a done task; null while it is listed.
ALTER TABLE `tasks` ADD `archived_at` integer;
