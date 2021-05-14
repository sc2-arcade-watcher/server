ALTER TABLE `ds_game_lobby_message` DROP FOREIGN KEY `FK_b7434953704ac791ef38a74ace4`;
ALTER TABLE `ds_game_lobby_message` DROP FOREIGN KEY `FK_ce09cc2fb30480c24e1cf6d05cc`;
ALTER TABLE `ds_game_lobby_message` DROP INDEX FK_b7434953704ac791ef38a74ace4;
ALTER TABLE `ds_game_lobby_message` DROP INDEX FK_ce09cc2fb30480c24e1cf6d05cc;

ALTER TABLE `ds_game_lobby_message` ADD `closed` tinyint NOT NULL DEFAULT 0 AFTER `message_id`;
ALTER TABLE `ds_game_lobby_subscription` ADD `deleted_at` datetime NULL DEFAULT NULL AFTER `updated_at`;

ALTER TABLE `ds_game_lobby_message` ENGINE=ROCKSDB;
ALTER TABLE `ds_game_lobby_subscription` ENGINE=ROCKSDB;

UPDATE `ds_game_lobby_subscription`
SET
`deleted_at` = `updated_at`
WHERE `enabled` = 0
;
CREATE INDEX `deleted_at_idx` ON `ds_game_lobby_subscription` (`deleted_at`);

ALTER TABLE `ds_game_lobby_message` CHANGE `created_at` `created_at` datetime NOT NULL;
ALTER TABLE `ds_game_lobby_message` CHANGE `updated_at` `updated_at` datetime NOT NULL;
ALTER TABLE `ds_game_lobby_message` CHANGE `closed` `closed` tinyint NOT NULL;
ALTER TABLE `ds_game_lobby_message` CHANGE `completed` `completed` tinyint NOT NULL;
ALTER TABLE `ds_game_lobby_message` DROP COLUMN `id`;
ALTER TABLE `ds_game_lobby_message` ADD PRIMARY KEY (`message_id`);
ALTER TABLE `ds_game_lobby_message` CHANGE `message_id` `message_id` bigint(20) NOT NULL FIRST;
