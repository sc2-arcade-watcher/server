import * as orm from 'typeorm';
import * as program from 'commander';
import pQueue from 'p-queue';
import { S2Profile } from '../entity/S2Profile';
import { logger } from '../logger';
import { BattleAPI, BattleAPIGateway } from '../bnet/battleAPI';
import { PlayerProfileParams, profileHandle } from '../bnet/common';
import { retry, isAxiosError, sleep, throwErrIfNotDuplicateEntry } from '../helpers';
import { BattleDataUpdater, getAvatarIdentifierFromUrl } from '../bnet/battleData';
import { ProfileManager } from '../manager/profileManager';

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
    .option<Number>('--region <number>', 'region id', Number, 1)
    .option<Number>('--offset <number>', 'offset', Number, 0)
    .option<Number>('--concurrency <number>', 'concurrency', Number, 5)
    .option<String>('--gateway <string>', 'blz blz-us blz-eu blz-kr blz-cn sc2', String, 'sc2')
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
                gateway = 'starcraft2.blizzard.com/en-us/api';
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

        function fetchNext() {
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
                    const profResult = await conn.getRepository(S2Profile).createQueryBuilder('profile')
                        .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId', profParams)
                        .limit(1)
                        .getCount()
                    ;
                    if (profResult) {
                        logger.debug(`Skipping ${profileHandle(profParams)}`);
                    }
                    else {
                        break;
                    }
                }

                activeJobIds.add(profParams.profileId);
                try {
                    let checkpointId = Array.from(activeJobIds.values()).sort((a, b) => a - b)[0];
                    logger.verbose(`Trying ${profileHandle(profParams)} :: checkpoint ${checkpointId}`);

                    const bResult = await bDiscovery.retrieveProfileMeta(profParams);
                    const bCurrAvatar = getAvatarIdentifierFromUrl(bResult.avatarUrl);

                    let s2profile: S2Profile;
                    try {
                        s2profile = await ProfileManager.create({
                            ...profParams,
                            name: bResult.name,
                            discriminator: 0,
                            avatar: bCurrAvatar,
                        }, conn);
                    }
                    catch (err) {
                        throwErrIfNotDuplicateEntry(err);
                        logger.warn(`Duplicate ${profileHandle(profParams)} :: checkpoint ${checkpointId}`);
                    }
                    if (s2profile) {
                        logger.info(`Discovered ${s2profile.nameAndIdPad} :: checkpoint ${checkpointId}`);
                    }
                }
                catch (err) {
                    if (isAxiosError(err) && err.response) {
                        logger.warn(`Failed ${profileHandle(profParams)} status ${err.response.status}`);
                        if (err.response.status !== 404) {
                            throw err;
                        }
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
