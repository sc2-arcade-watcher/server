DROP TABLE IF EXISTS `s2_lobby_match`;
DROP TABLE IF EXISTS `s2_lobby_match_profile`;

CREATE TABLE `s2_lobby_match` (`lobby_id` int UNSIGNED NOT NULL, `result` tinyint UNSIGNED NOT NULL, `completed_at` datetime(0) NULL, PRIMARY KEY (`lobby_id`)) ENGINE=ROCKSDB;
CREATE TABLE `s2_lobby_match_profile` (`lobby_id` int UNSIGNED NOT NULL, `profile_match_id` int UNSIGNED NOT NULL, PRIMARY KEY (`lobby_id`, `profile_match_id`)) ENGINE=ROCKSDB;
CREATE UNIQUE INDEX `profile_match_idx` ON `s2_lobby_match_profile` (`profile_match_id`);

--
-- s2_profile_battle_tracking
--
SET session rocksdb_max_row_locks=50000000;
ALTER TABLE `s2_profile_battle_tracking` ADD `last_match_at` datetime NULL AFTER `match_history_integrity_since`;

DELETE spbt FROM s2_profile_battle_tracking spbt
LEFT JOIN s2_profile sp ON spbt.local_profile_id = sp.local_profile_id AND spbt.region_id = sp.region_id
WHERE sp.id IS NULL;

INSERT INTO s2_profile_battle_tracking (region_id, local_profile_id)
SELECT sp.region_id, sp.local_profile_id FROM s2_profile sp
LEFT JOIN s2_profile_battle_tracking spbt ON spbt.local_profile_id = sp.local_profile_id AND spbt.region_id = sp.region_id
WHERE spbt.local_profile_id IS NULL;
;

UPDATE s2_profile_battle_tracking spbt
SET spbt.last_match_at = (
    SELECT `date` FROM s2_profile_match spm
    WHERE spm.local_profile_id = spbt.local_profile_id AND spm.region_id = spbt.region_id
    ORDER BY spm.id DESC
    LIMIT 1
)
WHERE spbt.last_match_at IS NULL
;

CREATE INDEX `profile_info_updated_at_idx` ON `s2_profile_battle_tracking` (`match_history_updated_at`);
CREATE INDEX `last_match_at_idx` ON `s2_profile_battle_tracking` (`last_match_at`);


--
-- s2_profile
--
CREATE INDEX `avatar_idx` ON `s2_profile` (`avatar`);
