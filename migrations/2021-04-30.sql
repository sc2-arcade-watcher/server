CREATE INDEX `lobby_idx` ON `ds_game_lobby_message` (`lobby_id`);
ALTER TABLE `ds_game_lobby_subscription` ADD `post_match_result` tinyint NOT NULL DEFAULT 0;
ALTER TABLE `ds_game_lobby_message` CHANGE `rule_id` `subscription_id` int(11) DEFAULT NULL NULL;
UPDATE ds_game_lobby_message SET closed = 1 WHERE completed = 1;
