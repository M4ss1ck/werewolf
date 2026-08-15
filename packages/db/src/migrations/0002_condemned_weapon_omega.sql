CREATE TABLE `global_chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL
);
