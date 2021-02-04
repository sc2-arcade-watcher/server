import * as util from 'util';
import * as orm from 'typeorm';
import * as program from 'commander';
import * as pMap from 'p-map';
import pQueue from 'p-queue';
import { BattleAPI } from '../bnet/battleAPI';
import { BattleDataUpdater } from '../bnet/battleData';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileBattleTracking } from '../entity/S2ProfileBattleTracking';
import { logger } from '../logger';
import { parseProfileHandle, profileHandle } from '../bnet/common';
import { sleep, isAxiosError, setupProcessTerminator } from '../helpers';
import { BnAccount } from '../entity/BnAccount';
import { subDays, subHours } from 'date-fns';
import { stripIndents } from 'common-tags';
import { S2ProfileMatch } from '../entity/S2ProfileMatch';
import { S2ProfileMatchMapName } from '../entity/S2ProfileMatchMapName';


program.command('battle:sync-account')
    .option<Number>('--concurrency <number>', 'concurrency', Number, 10)
    .option<Number>('--id <number>', 'account id', Number)
    .option<Number>('--older-than <days>', '', Number)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const bData = new BattleDataUpdater(conn);

        const qb = conn.getRepository(BnAccount)
            .createQueryBuilder('bnAccount')
            .select(['id'])
        ;

        if (cmd.id) {
            qb.andWhere('bnAccount.id = :accountId', { accountId: cmd.id }).limit(1);
        }
        else if (cmd.olderThan) {
            qb.andWhere('bnAccount.profilesUpdatedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :olderThan DAY)', {
                olderThan: cmd.olderThan,
            });
        }
        else {
            qb.andWhere('bnAccount.profilesUpdatedAt IS NULL');
        }

        const results = (await qb.getRawMany()).map(x => x.id as number);
        logger.info(`Retrieved ${results.length} records..`);

        await pMap(results.entries(), async (entry) => {
            const [key, accountId] = entry;
            const skey = (key + 1).toString().padStart(results.length.toString().length);
            try {
                logger.verbose(`${skey}/${results.length} : Updating acc=${accountId} ..`);
                const bnAccount = await bData.updateAccount(accountId);
                logger.verbose(`${skey}/${results.length} : OK ${bnAccount.nameWithId} profiles: ${bnAccount.profileLinks.map(profileHandle).join(' ')}`);
            }
            catch (err) {
                if (isAxiosError(err) && err.response.status === 404) {
                    logger.warn(`${skey}/${results.length} : FAIL, acc=${accountId} responseCode=${err.response?.status}`);
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
    .option<Number>('--concurrency <number>', 'concurrency', Number, 20)
    .option<Number>('--chunk-size <number>', 'number of records to fetch per chunk', Number, 2000)
    .option<Number[]>('--region <regionId>', 'region', (value, previous) => value.split(',').map(x => Number(x)), [])
    .option<String>('--profile <handle>', 'profile handle', null)
    .option<Number>('--online-min <hours>', '', Number, null)
    .option<Number>('--online-max <hours>', '', Number, null)
    .option<Number>('--hist-delay <hours>', 'match history scan delay', Number, null)
    .option<Number>('--loop-delay <seconds>', '', Number, -1)
    .option<Number>('--offset <number>', 'initial offset id', Number, null)
    .option('--desc', '', false)
    .option('--retry-err', 'retry all profiles which failed to update in previous iteration(s)', false)
    .action(async (cmd: program.Command) => {
        const conn = await orm.createConnection();
        const bData = new BattleDataUpdater(conn);

        let chunkLimit = Math.max(cmd.concurrency * 50, cmd.chunkSize);
        let reachedEnd = true;
        let lastRecordId: number | null = cmd.offset;
        let waitingNextChunk = false;
        let haltProcess = false;
        const queue = new pQueue({
            concurrency: cmd.concurrency,
        });

        async function fetchNextChunk() {
            if (haltProcess) return;

            waitingNextChunk = true;
            logger.verbose(`Fetching next chunk..`);
            const qb = conn.getRepository(S2Profile).createQueryBuilder('profile')
                .leftJoinAndMapOne(
                    'profile.battleTracking',
                    S2ProfileBattleTracking,
                    'pTrack',
                    'profile.regionId = pTrack.regionId AND profile.localProfileId = pTrack.localProfileId'
                )
                .andWhere('profile.deleted = 0')
            ;

            if (cmd.desc) {
                qb.addOrderBy('profile.id', 'DESC');
            }
            else {
                qb.addOrderBy('profile.id', 'ASC');
            }

            if (lastRecordId !== null) {
                if (cmd.desc) {
                    qb.andWhere('profile.id < :lastRecordId', { lastRecordId: lastRecordId });
                }
                else {
                    qb.andWhere('profile.id > :lastRecordId', { lastRecordId: lastRecordId });
                }
            }

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
                // `(pTrack.profileInfoUpdatedAt IS NULL OR pTrack.profileInfoUpdatedAt < DATE_SUB(profile.lastOnlineAt, INTERVAL 14 DAY))`,
                if (cmd.histDelay) {
                    qb.andWhere(
                        stripIndents
                        `(
                            pTrack.matchHistoryUpdatedAt IS NULL OR
                            pTrack.matchHistoryUpdatedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :histDelay HOUR)
                        )`,
                    {
                        histDelay: cmd.histDelay,
                    });
                }
                if (cmd.onlineMin) {
                    qb.andWhere('profile.lastOnlineAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :onlineMin HOUR)', { onlineMin: cmd.onlineMin });
                }
                if (cmd.onlineMax) {
                    qb.andWhere('profile.lastOnlineAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL :onlineMax HOUR)', { onlineMax: cmd.onlineMax });
                }
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

            results.forEach(profile => {
                queue.add((async () => {
                    if (queue.size === Math.trunc(chunkLimit / 1.4) && !reachedEnd && !waitingNextChunk && !haltProcess) {
                        await fetchNextChunk();
                    }

                    const forceUpdate = cmd.retryErr || cmd.profile;
                    const idPadding = profile.id.toString().padStart(8, ' ');
                    const tdiff = profile.lastOnlineAt ? (
                        (new Date()).getTime() - profile.lastOnlineAt.getTime()
                    ) / 1000 / 3600.0 : 0;

                    if (
                        !forceUpdate &&
                        profile.battleTracking &&
                        (profile.battleTracking.battleAPIErrorCounter > 0 && profile.battleTracking.battleAPIErrorLast) &&
                        (profile.battleTracking.battleAPIErrorLast > subHours(new Date(), Math.pow(1.2, profile.battleTracking.battleAPIErrorCounter)))
                    ) {
                        return;
                    }

                    try {
                        if (
                            forceUpdate ||
                            !profile.battleTracking ||
                            !profile.battleTracking.matchHistoryUpdatedAt ||
                            !cmd.histDelay ||
                            profile.battleTracking.matchHistoryUpdatedAt < subHours(new Date(), cmd.histDelay)
                        ) {
                            logger.verbose(`[${idPadding}] Updating profile :: ${profile.nameAndIdPad} tdiff=${tdiff.toFixed(1).padStart(5, '0')}h`);
                            const commonResult = await bData.updateProfileCommon(profile);

                            if (Object.keys(commonResult.updatedProfileData).length) {
                                Object.assign(profile, commonResult.updatedProfileData);
                                await conn.getRepository(S2Profile).update(profile.id, commonResult.updatedProfileData);
                            }
                            if (Object.keys(commonResult.updatedBattleTracking).length) {
                                Object.assign(profile.battleTracking, commonResult.updatedBattleTracking);
                                await conn.getRepository(S2ProfileBattleTracking).update(
                                    conn.getRepository(S2ProfileBattleTracking).getId(profile.battleTracking),
                                    commonResult.updatedBattleTracking
                                );
                            }
                            if (commonResult.mapNames.length > 0) {
                                await conn.transaction(async (tsManager) => {
                                    await tsManager.getRepository(S2ProfileMatch).insert(commonResult.matches);
                                    await tsManager.getRepository(S2ProfileMatchMapName).insert(commonResult.mapNames);
                                });
                            }
                            else if (commonResult.matches.length) {
                                await conn.getRepository(S2ProfileMatch).insert(commonResult.matches);
                            }
                        }
                    }
                    catch (err) {
                        if (isAxiosError(err)) {
                            logger.warn(`[${idPadding}] connection error, skipping.. :: ${profile.nameAndIdPad}`);
                        }
                        else {
                            throw err;
                        }
                    }

                    logger.debug(`[${idPadding}] Done. qsize=${queue.size}`);
                }));
            });
        }

        setupProcessTerminator(() => {
            haltProcess = true;
            queue.clear();
        });

        while (1) {
            await fetchNextChunk();
            await queue.onIdle();
            logger.info(`Done, lastRecordId=${lastRecordId} reachedEnd=${reachedEnd}`);
            if (haltProcess) break;
            if (!reachedEnd) continue;
            if (cmd.loopDelay === -1) {
                break;
            }
            logger.info(`Next iteration in ${cmd.loopDelay}s..`);
            lastRecordId = null;
            await sleep(cmd.loopDelay * 1000);
        }
        await conn.close();
    })
;
