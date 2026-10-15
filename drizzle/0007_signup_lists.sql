DROP INDEX `notify_signups_email_unique`;--> statement-breakpoint
ALTER TABLE `notify_signups` ADD `list` text DEFAULT 'notify' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notify_signups_email_list_unique` ON `notify_signups` (`email`,`list`);