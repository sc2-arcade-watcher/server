import * as orm from 'typeorm';
import pQueue from 'p-queue';
import * as pMap from 'p-map';
import type lruFactory from 'tiny-lru';
const lru: typeof lruFactory = require('tiny-lru');
import { GameRegion } from '../common';
import { BattleDataUpdater, BattleUpdatedProfileCommon } from './battleData';
import { S2ProfileMatch } from '../entity/S2ProfileMatch';
import { logger, logIt } from '../logger';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileBattleTracking } from '../entity/S2ProfileBattleTracking';
import { S2ProfileMatchMapName } from '../entity/S2ProfileMatchMapName';
import { TypedEvent, isAxiosError } from '../helpers';
import { stripIndents } from 'common-tags';
import { subMinutes, differenceInHours } from 'date-fns';
import { ServiceProcess } from '../proc/process';

interface BattleTrackedProfile {
    profile: S2Profile | null;
    matchHistoryUpdatedAt: Date | null;
    lastMatchAt: Date | null;
    cachedMatchesResult?: BattleUpdatedProfileCommon;
    _cacheSyncOnDoneEvent?: TypedEvent<void>;
    _dataLoadOnDoneEvent?: TypedEvent<void>;
}

export type ProfileLocalParams = {
    regionId: number;
    localProfileId: number;
};

export function getProfileLocalCacheKey(inProfile: ProfileLocalParams) {
    return `${inProfile.regionId}-${inProfile.localProfileId}`;
}

export class BattleProfileUpdater {
    protected bData = new BattleDataUpdater(this.conn);
    protected readonly cacheMaxSize = 10000;
    protected trackedProfiles = lru<BattleTrackedProfile>(0);
    protected cachedProfiles = new Set<string>();
    private _cacheFlushDoneEvent: TypedEvent<number> | undefined = void 0;
    private cacheLastFlush = new Date();

    constructor(protected conn: orm.Connection) {
    }

    async updateProfileMatches(inProfile: ProfileLocalParams | S2Profile, dateThreshold: Date) {
        const currProfKey = getProfileLocalCacheKey(inProfile);
        let tProfile: BattleTrackedProfile = this.trackedProfiles.get(currProfKey);

        if (!tProfile) {
            tProfile = {
                profile: null,
                matchHistoryUpdatedAt: null,
                lastMatchAt: null,
                _dataLoadOnDoneEvent: new TypedEvent(),
            };
            this.trackedProfiles.set(currProfKey, tProfile);
            const tmpEv = tProfile._dataLoadOnDoneEvent;

            let s2prof: S2Profile;
            if (inProfile instanceof S2Profile) {
                s2prof = inProfile;
            }
            else {
                s2prof = await this.conn.getRepository(S2Profile).createQueryBuilder('profile')
                    .leftJoinAndMapOne(
                        'profile.battleTracking',
                        S2ProfileBattleTracking,
                        'bTrack',
                        'profile.regionId = bTrack.regionId AND profile.localProfileId = bTrack.localProfileId'
                    )
                    .andWhere('profile.regionId = :regionId AND profile.localProfileId = :localProfileId', {
                        regionId: inProfile.regionId,
                        localProfileId: inProfile.localProfileId,
                    })
                    .limit(1)
                    .getOne()
                ;
                if (!s2prof) {
                    throw new Error('wtf?');
                }
                if (!s2prof.battleTracking) {
                    s2prof.battleTracking = S2ProfileBattleTracking.create(s2prof);
                    await this.conn.getRepository(S2ProfileBattleTracking).insert(s2prof.battleTracking);
                }
            }

            Object.assign(tProfile, {
                profile: s2prof,
                matchHistoryUpdatedAt: s2prof.battleTracking.matchHistoryUpdatedAt,
                lastMatchAt: s2prof.battleTracking.lastMatchAt,
            });

            tProfile._dataLoadOnDoneEvent = void 0;
            tmpEv.emit();
        }
        else if (tProfile._dataLoadOnDoneEvent) {
            await new Promise((resolve, reject) => tProfile._dataLoadOnDoneEvent.once(resolve));
        }

        // pull recent data only if required
        if (
            !tProfile.profile.battleTracking.matchHistoryUpdatedAt ||
            tProfile.profile.battleTracking.matchHistoryUpdatedAt <= dateThreshold
        ) {
            // flush any caches related to this profile before retrieving next update
            if (this.cachedProfiles.has(currProfKey)) {
                await this.flushProfile(tProfile.profile, { smart: true });
            }

            // if (
            //     tProfile.profile.battleTracking &&
            //     (tProfile.profile.battleTracking.battleAPIErrorCounter > 0 && tProfile.profile.battleTracking.battleAPIErrorLast) &&
            //     (tProfile.profile.battleTracking.battleAPIErrorLast > subMinutes(new Date(), Math.pow(tProfile.profile.battleTracking.battleAPIErrorCounter * 1.5, 1.25)))
            // ) {
            //     return;
            // }

            if (!tProfile._cacheSyncOnDoneEvent) {
                tProfile._cacheSyncOnDoneEvent = new TypedEvent();

                let matchesBtData: BattleUpdatedProfileCommon;
                try {
                    matchesBtData = await this.bData.updateProfileCommon(tProfile.profile);
                }
                catch (err) {
                    if (isAxiosError(err)) {
                        logger.warn(`request failed. skipping.. ${tProfile.profile.nameAndIdPad} errCode=${err?.code} status=${err.response?.status}`);
                    }
                    else {
                        throw err;
                    }
                }

                if (matchesBtData && Object.keys(matchesBtData.updatedBattleTracking).length > 0) {
                    this.cachedProfiles.add(currProfKey);
                    tProfile.cachedMatchesResult = matchesBtData;
                    if (matchesBtData.updatedBattleTracking.matchHistoryUpdatedAt) {
                        tProfile.matchHistoryUpdatedAt = matchesBtData.updatedBattleTracking.matchHistoryUpdatedAt;
                    }

                    if (
                        matchesBtData.updatedBattleTracking.lastMatchAt &&
                        (!tProfile.lastMatchAt || tProfile.lastMatchAt < matchesBtData.updatedBattleTracking.lastMatchAt)
                    ) {
                        tProfile.lastMatchAt = matchesBtData.updatedBattleTracking.lastMatchAt;
                    }
                }

                tProfile._cacheSyncOnDoneEvent.emit();
                tProfile._cacheSyncOnDoneEvent = void 0;
            }
            else {
                await new Promise((resolve, reject) => tProfile._cacheSyncOnDoneEvent.once(resolve));
            }
        }

        if (
            ((Date.now() - this.cacheLastFlush.getTime()) > 1000 * 60 || this.cachedProfiles.size >= 1000) &&
            !this._cacheFlushDoneEvent
        ) {
            await this.flush();
        }

        return {
            lastMatchAt: tProfile.lastMatchAt,
            matchHistoryUpdatedAt: tProfile.matchHistoryUpdatedAt,
            battleAPIErrorLast: tProfile.profile.battleTracking.battleAPIErrorLast,
            battleAPIErrorCounter: tProfile.profile.battleTracking.battleAPIErrorCounter,
        };
    }

    async flushProfile(inProfiles: ProfileLocalParams | ProfileLocalParams[], opts?: { onlyMatches?: boolean; smart?: boolean; }) {
        if (!Array.isArray(inProfiles)) {
            inProfiles = [inProfiles];
        }

        let flushRequired = false;
        for (const item of inProfiles) {
            const currProfKey = getProfileLocalCacheKey(item);
            if (this.cachedProfiles.has(currProfKey)) {
                if (!opts) continue;

                const cachedData = this.trackedProfiles.get(currProfKey).cachedMatchesResult;
                if (opts?.onlyMatches === true && cachedData.matches.length === 0) {
                    continue;
                }
                if (opts?.smart === true &&
                    (
                        cachedData.matches.length === 0 &&
                        Object.keys(cachedData.updatedProfileData).length === 0 &&
                        (
                            Object.keys(cachedData.updatedBattleTracking).length === 1 &&
                            cachedData.updatedBattleTracking.matchHistoryUpdatedAt
                        )
                    )
                ) {
                    continue;
                }

                flushRequired = true;
                break;
            }
        }

        if (!flushRequired) {
            return false;
        }

        await this.flush();
    }

    async flush() {
        if (this._cacheFlushDoneEvent) {
            await new Promise((resolve, reject) => this._cacheFlushDoneEvent.once(resolve));
            return;
        }

        if (this.cachedProfiles.size === 0) return;

        const tmpEv = this._cacheFlushDoneEvent = new TypedEvent();
        const cacheKeysToFlush = Array.from(this.cachedProfiles.values());

        logger.debug(`Flushing ${cacheKeysToFlush.length} results`);

        await this.conn.transaction(async (tsManager) => {
            let matches: S2ProfileMatch[] = [];
            let mapNames: S2ProfileMatchMapName[] = [];

            for (const currCacheKey of cacheKeysToFlush) {
                const cachedProfile = this.trackedProfiles.get(currCacheKey);
                if (!cachedProfile) {
                    throw new Error(`trackedProfiles doesn't exist for ${currCacheKey}`);
                }

                this.cachedProfiles.delete(currCacheKey);
                const currCachedMatchesResult = cachedProfile.cachedMatchesResult;
                cachedProfile.cachedMatchesResult = void 0;

                if (Object.keys(currCachedMatchesResult.updatedProfileData).length > 0) {
                    Object.assign(cachedProfile.profile, currCachedMatchesResult.updatedProfileData);
                    await tsManager.getRepository(S2Profile).update(
                        cachedProfile.profile.id,
                        currCachedMatchesResult.updatedProfileData
                    );
                }
                if (Object.keys(currCachedMatchesResult.updatedBattleTracking).length > 0) {
                    Object.assign(cachedProfile.profile.battleTracking, currCachedMatchesResult.updatedBattleTracking);
                    await tsManager.getRepository(S2ProfileBattleTracking).update(
                        tsManager.getRepository(S2ProfileBattleTracking).getId(cachedProfile.profile.battleTracking),
                        currCachedMatchesResult.updatedBattleTracking
                    );
                }

                if (currCachedMatchesResult.matches.length > 0) {
                    matches = matches.concat(currCachedMatchesResult.matches);
                }

                if (currCachedMatchesResult.mapNames.length > 0) {
                    mapNames = mapNames.concat(currCachedMatchesResult.mapNames);
                }
            }

            if (matches.length > 0) {
                await tsManager.getRepository(S2ProfileMatch).insert(matches);
            }
            if (mapNames.length > 0) {
                await tsManager.getRepository(S2ProfileMatchMapName).insert(mapNames);
            }
        });

        // FIXME: we're using internal props of tiny-lru here
        // so gotta check the code when upgrading lib or fork it
        // @ts-expect-error - size prop is missing in typings
        let tpSize: number = this.trackedProfiles.size;
        while (tpSize > this.cacheMaxSize) {
            // @ts-expect-error - size prop is missing in typings
            tpSize = this.trackedProfiles.size;
            // @ts-expect-error - first prop is missing in typings
            const item: { key: string } = this.trackedProfiles.first;
            if (this.cachedProfiles.has(item.key)) {
                logger.error(`cannot clear trackedProfiles[${item.key}] - referenced in cachedProfiles size=${tpSize}`);
                break;
            }
            if (this.trackedProfiles.get(item.key)._cacheSyncOnDoneEvent || this.trackedProfiles.get(item.key)._dataLoadOnDoneEvent) {
                logger.error(`cannot clear trackedProfiles[${item.key}] - referenced event size=${tpSize}`);
                break;
            }
            this.trackedProfiles.delete(item.key);
            // logger.debug(`evicted trackedProfiles[${item.key}] size=${tpSize}`);
        }

        this._cacheFlushDoneEvent = void 0;
        this.cacheLastFlush = new Date();

        logger.debug(`Flushed ${cacheKeysToFlush.length} results, nsize=${this.cachedProfiles.size}`);
        tmpEv.emit(cacheKeysToFlush.length);
    }
}

interface ProfileRefreshPlan {
    readonly name: string;
    readonly qb: orm.SelectQueryBuilder<S2ProfileBattleTracking> | orm.SelectQueryBuilder<S2Profile>;
    /** in seconds */
    readonly cycleInterval: number;
    readonly priority: number;
    state?: {
        startedAt: Date | null;
        completedAt: Date | null;
        offset: number;
        cycleTimer: NodeJS.Timer | null;
    };
}

export class BattleProfileRefreshDirector extends ServiceProcess {
    protected queue = new pQueue({
        concurrency: 15,
    });
    protected plans: ProfileRefreshPlan[] = [];

    constructor(
        protected conn: orm.Connection,
        protected bProfileUpdater: BattleProfileUpdater,
        protected readonly region: GameRegion,
        protected readonly startStagger: number = 0,
    ) {
        super();
        this.plans = [
            {
                name: 'new',
                qb: this.createQueryNew(),
                cycleInterval: 60 * 4.5,
                priority: 10,
            },
            {
                name: 'recent',
                qb: this.createQueryRecent(),
                cycleInterval: 60 * 130,
                priority: 10,
            },
            {
                name: 'stale',
                qb: this.createQueryStale(),
                cycleInterval: 60 * 60 * 8,
                priority: 0,
            },
        ];
    }

    protected createQueryNew() {
        const qb = this.conn.getRepository(S2Profile).createQueryBuilder('profile')
            .innerJoinAndMapOne(
                'profile.battleTracking',
                S2ProfileBattleTracking,
                'bTrack',
                'profile.regionId = bTrack.regionId AND profile.localProfileId = bTrack.localProfileId'
            )
            .andWhere('profile.regionId = :regionId', {
                regionId: this.region,
            })
            .andWhere('profile.localProfileId > :pkOffset', { pkOffset: 0 })
            .orderBy('profile.localProfileId', 'ASC')
        ;
        qb
            .andWhere(stripIndents`(
                profile.lastOnlineAt IS NOT NULL AND
                profile.lastOnlineAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)
            )`)
            .andWhere(stripIndents`(
                bTrack.profileInfoUpdatedAt IS NULL
            )`)
        ;
        return qb;
    }

    protected createQueryRecent() {
        const qb = this.conn.getRepository(S2Profile).createQueryBuilder('profile')
            .leftJoinAndMapOne(
                'profile.battleTracking',
                S2ProfileBattleTracking,
                'bTrack',
                'profile.regionId = bTrack.regionId AND profile.localProfileId = bTrack.localProfileId'
            )
            .andWhere('profile.regionId = :regionId', {
                regionId: this.region,
            })
            .andWhere('profile.localProfileId > :pkOffset', { pkOffset: 0 })
            .orderBy('profile.localProfileId', 'ASC')
            .andWhere('profile.lastOnlineAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL :offlineMax HOUR)', {
                offlineMax: 24 * 5,
            })
            .andWhere(stripIndents`
                (
                    bTrack.battleAPIErrorCounter < 2 OR
                    bTrack.battleAPIErrorCounter < TIMESTAMPDIFF(
                        DAY,
                        IFNULL(bTrack.matchHistoryUpdatedAt, bTrack.battleAPIErrorLast),
                        profile.lastOnlineAt
                    )
                )
            `)
            .andWhere(stripIndents`
                (
                    bTrack.matchHistoryUpdatedAt IS NULL OR
                    bTrack.matchHistoryUpdatedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 180 MINUTE)
                )
            `)
        ;
        return qb;
    }

    protected createQueryStale() {
        const qb = this.conn.getRepository(S2ProfileBattleTracking).createQueryBuilder('bTrack')
            .leftJoinAndMapOne(
                'bTrack.profile',
                S2Profile,
                'profile',
                'profile.regionId = bTrack.regionId AND profile.localProfileId = bTrack.localProfileId'
            )
            .orderBy('bTrack.localProfileId', 'ASC')
            .andWhere('bTrack.localProfileId > :pkOffset', { pkOffset: 0 })
            .andWhere('bTrack.regionId = :regionId', { regionId: this.region })
            .andWhere('(bTrack.lastMatchAt IS NULL OR bTrack.lastMatchAt <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY))')
            .andWhere(stripIndents`
                (
                    bTrack.profileInfoUpdatedAt IS NULL OR
                    bTrack.matchHistoryUpdatedAt IS NULL OR
                    bTrack.matchHistoryUpdatedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) OR
                    DATEDIFF(UTC_TIMESTAMP(), bTrack.matchHistoryUpdatedAt) > (DATEDIFF(UTC_TIMESTAMP(), IFNULL(bTrack.lastMatchAt, \'2020-01-01\')) / 3)
                )
            `)
            .andWhere(stripIndents`(
                bTrack.battleAPIErrorCounter = 0 OR
                bTrack.battleAPIErrorCounter < 7 OR
                bTrack.battleAPIErrorCounter < (
                    TIMESTAMPDIFF(
                        WEEK,
                        IFNULL(bTrack.matchHistoryUpdatedAt, bTrack.battleAPIErrorLast),
                        UTC_TIMESTAMP()
                    ) * 2
                )
            )`)
        ;
        return qb;
    }

    protected async fetchData(sPlan: ProfileRefreshPlan) {
        sPlan.qb.setParameter('pkOffset', sPlan.state.offset);

        logger.debug(`Fetching chunk region=${this.region} plan=${sPlan.name} offset=${sPlan.state.offset}`);
        const results = await sPlan.qb.getMany();
        if (results.length > 0) {
            sPlan.state.offset = results[results.length - 1].localProfileId;
        }
        logger.debug(`Fetched chunk region=${this.region} plan=${sPlan.name} results=${results.length} offset=${sPlan.state.offset}`);

        return results;
    }

    protected async proceed(sPlan: ProfileRefreshPlan) {
        if (this.isShuttingDown) return;

        if (!sPlan.state) {
            sPlan.state = {
                startedAt: new Date(),
                completedAt: null,
                offset: 0,
                cycleTimer: null,
            };
            logger.verbose(`Cycle started region=${this.region} plan=${sPlan.name}`);
        }

        const qLimit = 5000;
        sPlan.qb.limit(qLimit);

        const results = await this.fetchData(sPlan);
        const reachedEndOfData = results.length < qLimit || results.length === 0;
        if (reachedEndOfData) {
            logger.verbose(`Completed fetching data region=${this.region} plan=${sPlan.name}`);
        }

        const dateThreshold = new Date();
        while (results.length) {
            if (this.isShuttingDown) break;
            const subTasks: Promise<any>[] = [];
            for (let currItem of results.splice(0, this.queue.concurrency * 4)) {
                if (currItem instanceof S2ProfileBattleTracking) {
                    currItem.profile.battleTracking = currItem;
                    currItem = currItem.profile;
                }
                let priority = sPlan.priority;
                if (currItem.lastOnlineAt && differenceInHours(Date.now(), currItem.lastOnlineAt) < 24) {
                    priority += currItem.battleTracking.matchHistoryUpdatedAt ? differenceInHours(Date.now(), currItem.battleTracking.matchHistoryUpdatedAt) : 50;
                }
                subTasks.push(this.queue.add(async () => {
                    await this.bProfileUpdater.updateProfileMatches(currItem, dateThreshold);
                }, {
                    priority: priority,
                }));
            }
            await Promise.all(subTasks);
        }

        if (this.isShuttingDown) {
            logger.verbose(`Execution cycle interrupted, region=${this.region} plan=${sPlan.name} len=${results.length}`);
            return;
        }

        if (reachedEndOfData) {
            sPlan.state.completedAt = new Date();
            const sleepMs = sPlan.cycleInterval * 1000 * (0.95 + Math.random() * 0.1);
            logger.verbose(`Cycle completed region=${this.region} plan=${sPlan.name} sleep=${(sleepMs / 60000).toFixed()}m`);

            sPlan.state.cycleTimer = setTimeout(() => {
                sPlan.state = void 0;
                setImmediate(this.proceed.bind(this, sPlan));
            }, sleepMs);
        }
        else {
            setImmediate(this.proceed.bind(this, sPlan));
        }
    }

    protected async doShutdown() {
        this.plans.forEach(x => {
            if (x?.state?.cycleTimer) {
                clearTimeout(x?.state.cycleTimer);
                x.state.cycleTimer = null;
            }
        });

        this.queue.clear();
        await this.queue.onIdle();
    }

    protected async doStart() {
        for (const [i, sPlan] of this.plans.entries()) {
            let startDelay = 0;
            if (this.startStagger > 0) {
                startDelay = ((this.startStagger - 1 + i) * 7500) + (i * 10000);
            }
            setTimeout(this.proceed.bind(this, sPlan), startDelay).unref();
        }
    }

    async evaluatePlans() {
        for (const sPlan of this.plans) {
            const pf = logger.startTimer();
            const count = await sPlan.qb.getCount();
            pf.done({ level: 'info', message: `region=${this.region} plan=${sPlan.name} count=${count}` });
        }
    }

    protected getName() {
        return `${this.constructor.name}/${GameRegion[this.region]}`;
    }
}
