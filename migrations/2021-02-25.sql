--
-- add authorLocalProfileId
--
ALTER TABLE `s2_map` ADD `author_local_profile_id` int UNSIGNED NOT NULL DEFAULT 0 AFTER `initial_version_id`;
UPDATE s2_map sm
INNER JOIN s2_profile sp ON sm.author_id = sp.id
SET sm.author_local_profile_id = IF(sp.realm_id = 1, sp.profile_id, sp.profile_id + CAST(0x80000000 AS DECIMAL))
;
ALTER TABLE `s2_map` CHANGE `author_local_profile_id` `author_local_profile_id` int UNSIGNED NOT NULL;
CREATE INDEX `local_profile_region_idx` ON `s2_map` (`author_local_profile_id`, `region_id`);

--
-- drop authorId
--
ALTER TABLE `s2_map` DROP FOREIGN KEY `FK_78d6d3249dc698c7390300d9550`;
DROP INDEX `author_idx` ON `s2_map`;
ALTER TABLE `s2_map` DROP COLUMN `author_id`;


--
-- remove default 0 on localProfileId
--
ALTER TABLE `s2_profile` CHANGE `local_profile_id` `local_profile_id` int UNSIGNED NOT NULL;
