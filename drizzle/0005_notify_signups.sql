CREATE TABLE `notify_signups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`ip` text,
	`country` text,
	`user_agent` text,
	`reason` text,
	`notified_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notify_signups_email_unique` ON `notify_signups` (`email`);