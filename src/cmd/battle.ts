import * as util from 'util';
import * as orm from 'typeorm';
import * as program from 'commander';
import * as pMap from 'p-map';
import pQueue from 'p-queue';
import { BattleAPI } from '../bnet/battleAPI';
import { BattleDataUpdater } from '../bnet/battleData';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileTracking } from '../entity/S2ProfileTracking';
import { logger } from '../logger';
import { profileHandle } from '../bnet/common';

program.command('battle:token')
    .action(async () => {
        const bAPI = new BattleAPI();
        // const tokenInfo = await bAPI.oauth.acquireToken({ grantType: 'client_credentials' });
        // console.log(tokenInfo.data);

        const sc2Profiles = await bAPI.sc2.getAccount(128747765);
        console.log(sc2Profiles.data);

        // for (const profile of sc2Profiles.data) {
        //     console.log(profile);
        //     const mhistResult = await bAPI.sc2.getMatchHistory(profile.regionId, profile.realmId, profile.profileId);
        //     console.log(mhistResult.data);
        // }

        // const conn = await orm.createConnection();
        // await conn.close();
    })
;

program.command('battle:sync-account')
    .option<Number>('--id [number]', 'account id', (value, previous) => Number(value), null)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const bData = new BattleDataUpdater(conn);

        if (cmd.id) {
            await bData.updateAccount(cmd.id);
        }

        await conn.close();
    })
;

program.command('battle:sync-profile')
    .option<Number>('--concurrency [number]', 'concurrency', (value, previous) => Number(value), 20)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const bData = new BattleDataUpdater(conn);

        const chunkLimit = cmd.concurrency * 8;
        let lastRecordId = 0;
        const queue = new pQueue({
            concurrency: cmd.concurrency,
        });

        async function fetchNextChunk() {
            logger.info(`Fetching next chunk..`);
            const qb = conn.getRepository(S2Profile).createQueryBuilder('profile')
                .leftJoinAndMapOne(
                    'profile.tracking',
                    S2ProfileTracking,
                    'pTrack',
                    'profile.regionId = pTrack.regionId AND profile.realmId = pTrack.realmId AND profile.profileId = pTrack.profileId'
                )
                .andWhere('profile.id > :lastRecordId', { lastRecordId: lastRecordId })
                .andWhere('profile.regionId IN (1,2,3)')
                .andWhere('profile.deleted = 0')
                .andWhere('pTrack.profileInfoUpdatedAt IS NULL OR pTrack.profileInfoUpdatedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)')
                .addOrderBy('profile.id', 'ASC')
                .limit(chunkLimit)
            ;
            const results = await qb.getMany();
            logger.info(`Retrieved ${results.length} records..`);

            if (!results.length) return;
            lastRecordId = results[results.length - 1].id;
            logger.verbose(`lastRecordId=${lastRecordId}`);

            results.forEach(profile => {
                queue.add((async () => {
                    logger.info(`[${profile.id}] Updating profile "${profile.name}" ${profileHandle(profile)}`);
                    await bData.updateProfileData(profile);
                    logger.verbose(`[${profile.id}] Done. qsize=${queue.size}`);
                    if (queue.size === Math.trunc(chunkLimit / 1.5)) {
                        fetchNextChunk();
                    }
                }));
            });
        }

        await fetchNextChunk();

        await queue.onIdle();
        await conn.close();
    })
;
