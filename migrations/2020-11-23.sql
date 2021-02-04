ALTER TABLE `s2_profile_tracking` ADD `name_updated_at` datetime NOT NULL DEFAULT '0000-00-00 00:00:00';

UPDATE s2_profile_tracking
INNER JOIN s2_profile ON (
    s2_profile_tracking.region_id = s2_profile.region_id AND 
    s2_profile_tracking.realm_id = s2_profile.realm_id AND
    s2_profile_tracking.profile_id = s2_profile.profile_id
)
SET
    s2_profile_tracking.name_updated_at = IFNULL(s2_profile.name_updated_at, DATE('0000-00-00 00:00:00'))
;

ALTER TABLE `s2_profile` ADD `avatar` varchar(12) COLLATE "ascii_bin" NOT NULL AFTER `discriminator`;
UPDATE s2_profile sp 
SET sp.avatar = SUBSTRING_INDEX(SUBSTRING(sp.avatar_url, 87), '.', 1)
WHERE sp.avatar_url IS NOT NULL
;

ALTER TABLE `s2_profile` DROP COLUMN `name_updated_at`;
ALTER TABLE `s2_profile` DROP COLUMN `avatar_url`;
ALTER TABLE `s2_profile` CHANGE `region_id` `region_id` tinyint(3) unsigned NOT NULL AFTER `id`;

CREATE TABLE `s2_profile_account_link` (`region_id` tinyint UNSIGNED NOT NULL, `realm_id` tinyint UNSIGNED NOT NULL, `profile_id` int UNSIGNED NOT NULL, `account_id` int UNSIGNED NULL, `account_verified` tinyint NOT NULL DEFAULT 0, INDEX `account_idx` (`account_id`), PRIMARY KEY (`region_id`, `realm_id`, `profile_id`)) ENGINE=InnoDB;
CREATE UNIQUE INDEX `region_realm_profile_idx` ON `s2_profile_account_link` (`region_id`, `realm_id`, `profile_id`);
ALTER TABLE `s2_profile_account_link` ADD CONSTRAINT `FK_d46b4a442aedb56d12a6cab90e7` FOREIGN KEY (`account_id`) REFERENCES `bn_account`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `s2_profile_account_link` CHANGE `account_id` `account_id` int UNSIGNED NOT NULL;

INSERT INTO s2_profile_account_link (region_id, realm_id, profile_id, account_id, account_verified)
SELECT s2_profile.region_id, s2_profile.realm_id, s2_profile.profile_id, s2_profile.account_id, s2_profile.account_verified FROM s2_profile
WHERE s2_profile.account_id IS NOT NULL
;

ALTER TABLE `s2_profile` DROP FOREIGN KEY `FK_07abbd91164d61dab74a17362c6`;
DROP INDEX `account_idx` ON `s2_profile`;
ALTER TABLE `s2_profile` DROP COLUMN `account_id`;
ALTER TABLE `s2_profile` DROP COLUMN `account_verified`;

ALTER TABLE `s2_profile_match_unknown_map` RENAME TO `s2_profile_match_map_name`;
