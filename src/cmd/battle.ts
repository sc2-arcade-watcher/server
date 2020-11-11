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
import { parseProfileHandle } from '../bnet/common';
import { sleep, isAxiosError } from '../helpers';
import { BnAccount } from '../entity/BnAccount';
import { subDays, subHours } from 'date-fns';


program.command('battle:sync-account')
    .option<Number>('--concurrency [number]', 'concurrency', (value, previous) => Number(value), 10)
    .option<Number>('--id [number]', 'account id', (value, previous) => Number(value), null)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const bData = new BattleDataUpdater(conn);

        const qb = conn.getRepository(BnAccount).createQueryBuilder('bnAccount')
        ;

        if (cmd.id) {
            qb.andWhere('bnAccount.id = :accountId', { accountId: cmd.id }).limit(1);
        }
        else {
            qb.andWhere('bnAccount.profilesUpdatedAt IS NULL');
        }

        const results = await qb.getMany();
        logger.info(`Retrieved ${results.length} records..`);

        await pMap(results.entries(), async (entry) => {
            const [key, item] = entry;
            const skey = (key + 1).toString().padStart(results.length.toString().length);
            try {
                logger.verbose(`${skey}/${results.length} : Updating acc=${item.id} ..`);
                const bnAccount = await bData.updateAccount(item.id);
                logger.info(`${skey}/${results.length} : OK ${bnAccount.nameWithId} profiles: ${bnAccount.profiles.map(x => x.nameAndId).join(', ')}`);
            }
            catch (err) {
                if (isAxiosError(err) && err.response.status === 404) {
                    logger.warn(`${skey}/${results.length} : FAIL, acc=${item.id} responseCode=${err.response?.status}`);
                }
                else {
                    throw err;
                }
            }
        }, { concurrency: cmd.concurrency, });

        await conn.close();
    })
;

program.command('battle:sync-profile')
    .option<Number>('--concurrency [number]', 'concurrency', (value, previous) => Number(value), 20)
    .option<Number>('--chunk-size [number]', 'number of records to fetch per chunk', (value, previous) => Number(value), 2000)
    .option<Number[]>('--region [regionId]', 'region', (value, previous) => value.split(',').map(x => Number(x)), [])
    .option<String>('--profile [profile handle]', 'profile handle', null)
    .option<Number>('--online-margin [days]', '', (value, previous) => Number(value), 14)
    .option<Number>('--hist-delay [hours]', 'match history scan delay', (value, previous) => Number(value), 2)
    .option<Number>('--loop-delay [seconds]', '', (value, previous) => Number(value), -1)
    .option<Number>('--offset [number]', 'initial offset id', (value, previous) => Number(value), 0)
    .option('--retry-err', 'retry all profiles which failed to update in previous iteration(s)', false)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const bData = new BattleDataUpdater(conn);

        let chunkLimit = Math.max(cmd.concurrency * 50, cmd.chunkSize);
        let reachedEnd = true;
        let lastRecordId = cmd.offset;
        let waitingNextChunk = false;
        const queue = new pQueue({
            concurrency: cmd.concurrency,
        });

        async function fetchNextChunk() {
            waitingNextChunk = true;
            logger.verbose(`Fetching next chunk..`);
            const qb = conn.getRepository(S2Profile).createQueryBuilder('profile')
                .leftJoinAndMapOne(
                    'profile.tracking',
                    S2ProfileTracking,
                    'pTrack',
                    'profile.regionId = pTrack.regionId AND profile.realmId = pTrack.realmId AND profile.profileId = pTrack.profileId'
                )
                .andWhere('profile.id >= :lastRecordId', { lastRecordId: lastRecordId })
                .andWhere('profile.deleted = 0')
                .addOrderBy('profile.id', 'ASC')
            ;

            if (cmd.region.length) {
                qb.andWhere(`profile.regionId IN (${(cmd.region as Number[]).join(',')})`);
            }

            if (cmd.profile) {
                const requestedProfile = parseProfileHandle(cmd.profile);
                qb.andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId', {
                    regionId: requestedProfile.regionId,
                    realmId: requestedProfile.realmId,
                    profileId: requestedProfile.profileId,
                });
                chunkLimit = 1;
            }
            else if (cmd.retryErr) {
                qb.andWhere('pTrack.battleAPIErrorCounter > 0');
            }
            else {
                qb.andWhere('(' + [
                    // `(pTrack.profileInfoUpdatedAt IS NULL OR pTrack.profileInfoUpdatedAt < DATE_SUB(profile.lastOnlineAt, INTERVAL 14 DAY))`,
                    `(
                        pTrack.matchHistoryUpdatedAt IS NULL OR (
                            pTrack.matchHistoryUpdatedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :histDelay HOUR) AND
                            profile.lastOnlineAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL :onlineMargin DAY)
                        )
                    )`,
                ].join(' OR ') + ')', {
                    histDelay: cmd.histDelay,
                    onlineMargin: cmd.onlineMargin,
                });
                qb.andWhere('(pTrack.battleAPIErrorCounter IS NULL OR pTrack.battleAPIErrorCounter < 10)');
            }

            qb.limit(chunkLimit);
            const results = await qb.getMany();
            waitingNextChunk = false;
            logger.verbose(`Retrieved ${results.length} records, expected ${chunkLimit}`);

            if (!results.length) {
                reachedEnd = true;
                return;
            }
            else if (results.length < chunkLimit) {
                reachedEnd = true;
            }
            else {
                reachedEnd = false;
            }

            lastRecordId = results[results.length - 1].id;
            logger.verbose(`lastRecordId=${lastRecordId} reachedEnd=${reachedEnd}`);
            ++lastRecordId;

            results.forEach(profile => {
                queue.add((async () => {
                    if (queue.size === Math.trunc(chunkLimit / 1.4) && !reachedEnd && !waitingNextChunk) {
                        await fetchNextChunk();
                    }

                    const forceUpdate = cmd.retryErr || cmd.profile;

                    if (
                        !forceUpdate &&
                        profile.tracking &&
                        (profile.tracking.battleAPIErrorCounter > 0 && profile.tracking.battleAPIErrorLast) &&
                        (profile.tracking.battleAPIErrorLast > subHours(new Date(), Math.pow(1.2, profile.tracking.battleAPIErrorCounter)))
                    ) {
                        return;
                    }

                    let affectedMatches: number;
                    try {
                        if (
                            forceUpdate ||
                            !profile.tracking ||
                            !profile.tracking.matchHistoryUpdatedAt ||
                            profile.tracking.matchHistoryUpdatedAt < subHours(new Date(), cmd.histDelay)
                        ) {
                            logger.verbose(`[${profile.id.toString().padStart(8, ' ')}] Updating profile "${profile.nameAndId}", match history..`);
                            affectedMatches = await bData.updateProfileMatchHistory(profile);
                        }
                    }
                    catch (err) {
                        if (isAxiosError(err)) {
                            logger.warn(`[${profile.id.toString().padStart(8, ' ')}] connection error, skipping..`);
                        }
                        else {
                            throw err;
                        }
                    }

                    if (
                        (
                            affectedMatches &&
                            (!profile.tracking?.profileInfoUpdatedAt || profile.tracking?.profileInfoUpdatedAt < subDays(profile.lastOnlineAt ?? new Date(), 14))
                        ) ||
                        (!profile.tracking?.profileInfoUpdatedAt || profile.tracking?.profileInfoUpdatedAt < subDays(profile.lastOnlineAt ?? new Date(), 90)) ||
                        profile.avatarUrl === null
                    ) {
                        logger.verbose(`[${profile.id.toString().padStart(8, ' ')}] Updating profile "${profile.nameAndId}", meta data..`);
                        await bData.updateProfileMetaData(profile);
                    }

                    logger.debug(`[${profile.id.toString().padStart(8, ' ')}] Done. qsize=${queue.size}`);
                }));
            });
        }

        while (1) {
            await fetchNextChunk();
            await queue.onIdle();
            if (cmd.loopDelay === -1) {
                logger.info(`Done`);
                break;
            }
            logger.info(`Done, next iteration in ${cmd.loopDelay}s..`);
            lastRecordId = 0;
            await sleep(1 * 60 * 1000);
        }
        await conn.close();
    })
;
