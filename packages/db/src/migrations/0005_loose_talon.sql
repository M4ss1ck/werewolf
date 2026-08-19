ALTER TABLE `game_players` ADD `channel_since_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE `game_players` SET `channel_since_json` = json_object('wolves', `wolf_since_event_id`) WHERE `wolf_since_event_id` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `game_players` DROP COLUMN `wolf_since_event_id`;