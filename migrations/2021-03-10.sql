CREATE TABLE `app_storage` (`id` int UNSIGNED NOT NULL AUTO_INCREMENT, `key` varchar(255) COLLATE "ascii_bin" NOT NULL, `value` text NOT NULL, UNIQUE INDEX `key_idx` (`key`), PRIMARY KEY (`id`)) ENGINE=ROCKSDB;