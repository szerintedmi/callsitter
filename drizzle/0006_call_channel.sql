ALTER TABLE `calls` ADD `channel` text DEFAULT 'phone' NOT NULL;--> statement-breakpoint
ALTER TABLE `calls` ADD `declined` text;--> statement-breakpoint
CREATE INDEX `calls_channel_idx` ON `calls` (`channel`,`started_at`);--> statement-breakpoint
UPDATE `calls` SET `channel` = CASE WHEN `from` = 'public' THEN 'public' WHEN `from` IN ('browser', 'browser (SIP)') THEN 'test' ELSE 'phone' END;
