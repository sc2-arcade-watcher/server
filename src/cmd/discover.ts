import * as orm from 'typeorm';
import * as program from 'commander';
import * as pMap from 'p-map';
import pQueue from 'p-queue';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileTracking } from '../entity/S2ProfileTracking';
import { logger } from '../logger';
import { BattleAPI, BattleAPIGateway } from '../bnet/battleAPI';
import { PlayerProfileParams, profileHandle } from '../bnet/common';
import { retry, isAxiosError, sleep, throwErrIfNotDuplicateEntry } from '../helpers';
import { subHours } from 'date-fns';
import { BattleDataUpdater, getAvatarIdentifierFromUrl } from '../bnet/battleData';

class BattleDiscovery {
    protected bAPI: BattleAPI;

    constructor(gateway: BattleAPIGateway) {
        this.bAPI = new BattleAPI({
            gateway: {
                sc2: gateway,
            },
        });
    }

    @retry({
        onFailedAttempt: async err => {
            if (isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 500 || err.response?.status === 429)) {
                if (
                    err.response?.status === 404 &&
                    (
                        err.config.baseURL.indexOf('api.blizzard.com') !== -1 ||
                        err.config.baseURL.indexOf('gateway.battlenet.com.cn') !== -1
                    )
                ) {
                    throw err;
                }

                const st = Math.min(
                    1000 * Math.pow(err.attemptNumber, 1.10 + (Math.random() * 0.2)),
                    6000
                );
                logger.debug(`failed attempt ${err.attemptNumber} retry in ${st}ms`);
                await sleep(st);
            }
            else {
                throw err;
            }
        },
        retries: 2,
    })
    async retrieveProfileMeta(params: PlayerProfileParams) {
        return (await this.bAPI.sc2.getProfileMeta(params)).data;
    }
}

program.command('discover:profile')
    .option<Number>('--region <number>', 'region id', (value, previous) => Number(value), 1)
    .option<Number>('--offset <number>', 'offset', (value, previous) => Number(value), 0)
    .option<Number>('--concurrency <number>', 'concurrency', (value, previous) => Number(value), 5)
    .option<String>('--gateway <string>', 'blz blz-us blz-eu blz-kr blz-cn sc2', (value, previous) => String(value), 'sc2')
    .action(async function (cmd: program.Command) {
        let gateway: BattleAPIGateway;
        switch (cmd.gateway) {
            case 'blz': {
                gateway = '{region}.api.blizzard.com';
                break;
            }
            case 'blz-us': {
                gateway = 'us.api.blizzard.com';
                break;
            }
            case 'blz-eu': {
                gateway = 'eu.api.blizzard.com';
                break;
            }
            case 'blz-kr': {
                gateway = 'kr.api.blizzard.com';
                break;
            }
            case 'blz-cn': {
                gateway = 'gateway.battlenet.com.cn';
                break;
            }
            case 'sc2': {
                gateway = 'starcraft2.com/en-us/api';
                break;
            }
            default: {
                logger.error(`unkown param "${cmd.gateway}"`);
                return;
            }
        }

        const conn = await orm.createConnection();
        const queue = new pQueue({
            concurrency: cmd.concurrency,
        });

        let regionId = cmd.region;
        let realmId = 0;
        let profileId = Math.max(cmd.offset - 1, 0);
        const bDiscovery = new BattleDiscovery(gateway);
        const activeJobIds = new Set<number>();

        const profileQuery = conn.getRepository(S2Profile).createQueryBuilder().subQuery().select()
            .from(S2Profile, 'profile')
            .select('profile.id')
            .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId')
            .limit(1)
            .getQuery()
        ;
        function fetchNext() {
            let pTrack: S2ProfileTracking;

            queue.add(async () => {
                let profParams: PlayerProfileParams;

                while (1) {
                    if ((realmId % 2) === 1 && regionId !== 5) {
                        realmId = 2;
                    }
                    else {
                        realmId = 1;
                        ++profileId;
                    }

                    profParams = { regionId, realmId, profileId };
                    logger.verbose(`Checking ${profileHandle(profParams)}`);
                    const profResult = await conn.getRepository(S2ProfileTracking).createQueryBuilder('pTrack')
                        .addSelect(profileQuery, 'pid')
                        .andWhere('pTrack.regionId = :regionId AND pTrack.realmId = :realmId AND pTrack.profileId = :profileId', profParams)
                        .limit(1)
                        .getRawAndEntities()
                    ;

                    if (!profResult.raw.length || !profResult.raw[0].pid) {
                        if (profResult.entities.length) {
                            pTrack = profResult.entities[0];
                            if (
                                pTrack.battleAPIErrorCounter > 4 ||
                                (pTrack.battleAPIErrorLast !== null && pTrack.battleAPIErrorLast > subHours(new Date(), 12))
                            ) {
                                continue;
                            }
                        }
                        else {
                            pTrack = new S2ProfileTracking();
                            Object.assign(pTrack, profParams);
                            pTrack.battleAPIErrorCounter = 0;
                        }
                        break;
                    }
                }

                activeJobIds.add(profParams.profileId);
                try {
                    let checkpointId = Array.from(activeJobIds.values()).sort((a, b) => a - b)[0];
                    logger.verbose(`Trying ${profileHandle(profParams)} :: checkpoint ${checkpointId}`);

                    const bResult = await bDiscovery.retrieveProfileMeta(profParams);
                    const bCurrAvatar = getAvatarIdentifierFromUrl(bResult.avatarUrl);
                    const s2prof = S2Profile.create(profParams);
                    s2prof.name = bResult.name;
                    s2prof.avatar = bCurrAvatar;

                    checkpointId = Array.from(activeJobIds.values()).sort((a, b) => a - b)[0];
                    logger.info(`Discovered ${s2prof.nameAndIdPad} :: checkpoint ${checkpointId}`);
                    try {
                        await conn.getRepository(S2Profile).save(s2prof, { transaction: false });
                    }
                    catch (err) {
                        throwErrIfNotDuplicateEntry(err);
                    }

                    if (conn.getRepository(S2ProfileTracking).hasId(pTrack) || conn.getRepository(S2Profile).hasId(s2prof)) {
                        pTrack.profileInfoUpdatedAt = new Date();
                        pTrack.battleAPIErrorCounter = 0;
                        pTrack.battleAPIErrorLast = null;
                        await conn.getRepository(S2ProfileTracking).save(pTrack, { transaction: false });
                    }
                }
                catch (err) {
                    if (isAxiosError(err) && err.response) {
                        if (err.response.status !== 404) {
                            logger.warn(`Failed ${profileHandle(profParams)} status ${err.response.status}`);
                            throw err;
                        }
                        else {
                            logger.verbose(`Failed ${profileHandle(profParams)} status ${err.response.status}`);
                        }
                        pTrack.battleAPIErrorLast = new Date();
                        ++pTrack.battleAPIErrorCounter;
                        await conn.getRepository(S2ProfileTracking).save(pTrack, { transaction: false });
                    }
                    else {
                        throw err;
                    }
                }
                finally {
                    activeJobIds.delete(profParams.profileId);
                }
                fetchNext();
            });
        }

        for (let i = 0; i < queue.concurrency; ++i) {
            fetchNext();
            await sleep(70);
        }

        await queue.onIdle();
        logger.info('done');
        await conn.close();
    })
;


program.command('discover:account')
    .option<Number>('--offset <number>', 'offset', Number, 0)
    .option<Number>('--concurrency <number>', 'concurrency', Number, 5)
    .action(async function (cmd: program.Command) {
        const conn = await orm.createConnection();
        const bData = new BattleDataUpdater(conn);
        await conn.close();
    })
;
