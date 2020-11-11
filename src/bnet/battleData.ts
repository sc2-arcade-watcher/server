import * as orm from 'typeorm';
import type lruFactory from 'tiny-lru';
const lru: typeof lruFactory = require('tiny-lru');
import { BattleAPI, BattleUserInfo, BattleSC2ProfileBase, BattleSC2MatchEntry } from './battleAPI';
import { BnAccount } from '../entity/BnAccount';
import { profileHandle } from './common';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileTracking } from '../entity/S2ProfileTracking';
import { isAxiosError, isErrDuplicateEntry, retry, sleep } from '../helpers';
import { logger } from '../logger';
import { S2ProfileMatch, S2MatchSpeed, S2MatchDecision, S2MatchType } from '../entity/S2ProfileMatch';
import { S2Map } from '../entity/S2Map';
import { S2MapLocale } from '../entity/S2MapLocale';
import { oneLine } from 'common-tags';
import { GameRegion, GameLocale } from '../common';

const reSpecialChars = /[^a-z0-9]+/g;

type ResolvedMapLocale = Pick<S2MapLocale, 'regionId' | 'bnetId' | 'locale' | 'inLatestVersion' | 'isMain' | 'originalName' | 'name'>;

interface MapLocalizedResult {
    regionId: number;
    mapId: number;
    publishedAt: Date;
    updatedAt: Date;
    locales: ResolvedMapLocale[];
}

export type BattleMatchMapMapped = BattleSC2MatchEntry & {
    mapId: number;
};

export interface BattleMatchMappingResult {
    matches: BattleMatchMapMapped[];
    integritySince: Date;
}

export interface BattleMatchesSource {
    locale: GameLocale;
    entries: BattleSC2MatchEntry[];
}

export class BattleMatchEntryMapper {
    protected mapCache = lru<MapLocalizedResult[]>(3000, 1000 * 3600 * 2);

    constructor (protected conn: orm.Connection) {
    }

    async fetchMaps(params: { regionId?: number | number[], mapId?: number, name?: string | string[] }): Promise<MapLocalizedResult[]> {
        const cacheKey = [
            params.regionId?.toString() ?? '',
            params.mapId?.toString() ?? '',
            params.name?.toString() ?? '',
        ].join('^');

        let mResult = this.mapCache.get(cacheKey);
        if (mResult) {
            return mResult;
        }

        const qb = this.conn.getRepository(S2MapLocale).createQueryBuilder('mapLocale');
        if (params.regionId) {
            if (typeof params.regionId === 'number') {
                qb.andWhere('mapLocale.regionId = :regionId', { regionId: params.regionId });
            }
            else {
                qb.andWhere('mapLocale.regionId IN (:regionId)', { regionId: params.regionId });
            }
        }

        if (params.mapId) {
            qb.andWhere('mapLocale.bnetId = :mapId', { mapId: params.mapId });
        }
        else if (params.name) {
            if (typeof params.name === 'string') {
                qb.andWhere('(mapLocale.name = :name OR mapLocale.originalName = :name)', { name: params.name });
            }
            else {
                qb.andWhere('(mapLocale.name IN (:name) OR mapLocale.originalName IN (:name))', { name: params.name });
            }
        }
        else {
            throw new Error('expected :mapId or :name');
        }

        const matchingLocaleIds: { regionId: number, mapId: number }[] = await qb.select([])
            .addSelect('mapLocale.regionId', 'regionId')
            .addSelect('mapLocale.bnetId', 'mapId')
            // .addSelect('mapLocale.locale', 'locale')
            .addGroupBy('mapLocale.regionId')
            .addGroupBy('mapLocale.bnetId')
            .getRawMany()
        ;

        if (!matchingLocaleIds.length) {
            return [];
        }

        const qb2 = this.conn.getRepository(S2Map).createQueryBuilder('map')
            .innerJoinAndMapMany('map.locales', S2MapLocale, 'mapLocale', 'map.regionId = mapLocale.regionId AND map.bnetId = mapLocale.bnetId')
            .select([
                'map.regionId',
                'map.bnetId',
                'map.publishedAt',
                'map.updatedAt',
                'mapLocale.regionId',
                'mapLocale.bnetId',
                'mapLocale.locale',
                'mapLocale.inLatestVersion',
                'mapLocale.isMain',
                'mapLocale.originalName',
                'mapLocale.name',
            ])
            .addOrderBy('map.regionId', 'DESC')
            .addOrderBy('map.bnetId', 'DESC')
        ;
        for (const [key, mLocale] of matchingLocaleIds.entries()) {
            qb2.orWhere(`(map.regionId = :regionId${key} AND map.bnetId = :mapId${key})`, {
                [`regionId${key}`]: mLocale.regionId,
                [`mapId${key}`]: mLocale.mapId,
            });
        }

        mResult = (await qb2.getMany()).map(x => {
            return <MapLocalizedResult>{
                regionId: x.regionId,
                mapId: x.bnetId,
                publishedAt: x.publishedAt,
                updatedAt: x.updatedAt,
                locales: x.locales,
            };
        });
        this.mapCache.set(cacheKey, mResult);
        return mResult;
    }

    createMatchEntry(profile: S2Profile, bMatch: BattleMatchMapMapped) {
        const s2match = new S2ProfileMatch();
        s2match.regionId = profile.regionId;
        s2match.realmId = profile.realmId;
        s2match.profileId = profile.profileId;
        s2match.date = new Date(bMatch.date * 1000);
        s2match.type = bMatch.type.toLowerCase().replace(reSpecialChars, '') as S2MatchType;
        s2match.decision = bMatch.decision.toLowerCase().replace(reSpecialChars, '') as S2MatchDecision;
        s2match.speed = bMatch.speed.toLowerCase() as S2MatchSpeed;
        s2match.mapId = bMatch.mapId;
        return s2match;
    }

    /**
     * - returns `true` if list is up to date
     * - returns `false` if there was a problem, and another attempt should be performed at a later time; or more sources are required to correctly match a mapId
     * - returns `BattleMatchMappingResult` if acquired new entries
     */
    async mapFromSource(
        bSrcs: BattleMatchesSource[],
        profile: S2Profile,
        mostRecentMatch?: S2ProfileMatch,
        integritySince?: Date,
        sourcesLimit: number = 2,
    ): Promise<BattleMatchMappingResult | boolean> {
        const firstSrc = bSrcs.find(x => x.locale === GameLocale.enUS);

        if (mostRecentMatch && firstSrc.entries.length === 0) {
            logger.error(`${profile.nameAndId}, got empty match history result, where latest recorded was=${mostRecentMatch.date.toISOString()}`);
            return false;
        }

        if (firstSrc.entries.length === 0) {
            return true;
        }

        let latestKnownMatchIndex = -1;
        if (mostRecentMatch) {
            const mostRecentMatchEpochSecs = mostRecentMatch.date.getTime() / 1000;
            for (let i = firstSrc.entries.length - 1; i >= 0; --i) {
                const item = firstSrc.entries[i];
                if (item.date > mostRecentMatchEpochSecs) break;
                latestKnownMatchIndex = i;
            }

            // nothing new, exit early
            if (latestKnownMatchIndex === 0) {
                return true;
            }
        }
        if (latestKnownMatchIndex === -1) {
            integritySince = new Date(firstSrc.entries[firstSrc.entries.length - 1].date * 1000);
        }

        const reqRegionId = profile.regionId;
        const mappedEntries: BattleMatchMapMapped[] = [];

        let iterKeys = Array.from(firstSrc.entries.keys());
        if (latestKnownMatchIndex !== -1) {
            iterKeys = iterKeys.slice(0, latestKnownMatchIndex);
        }
        for (const entryIndex of iterKeys.reverse()) {
            const allCurrRegionMatches: MapLocalizedResult[] = [];
            const allOtherRegionMatches: MapLocalizedResult[] = [];
            const currMappedEntry: BattleMatchMapMapped = {
                ...firstSrc.entries[entryIndex],
                mapId: 0,
            };

            for (const sourceIndex in bSrcs) {
                const currSrc = bSrcs[sourceIndex];
                const currEntry = currSrc.entries[entryIndex];
                const currMapCandidates = await this.fetchMaps({ regionId: reqRegionId, name: currEntry.map });

                if (Number(sourceIndex) > 0) {
                    const prevEntry = bSrcs[Number(sourceIndex) - 1].entries[Number(entryIndex)];
                    if (currEntry.date !== prevEntry.date) {
                        logger.error(`${profile.nameAndId}, Date missmatch between sources`, prevEntry, currEntry);
                        return false;
                    }
                }

                // if maps are deleted then name can be reclaimed, so we can get more than more result
                if (currMapCandidates.length >= 1) {
                    let currFinalCandidates: MapLocalizedResult[] = [].concat(...currMapCandidates);

                    if (currFinalCandidates.length > 1) {
                        // find appropriate map using available timestamps
                        // the list is intially sorted from newest to oldest
                        currFinalCandidates = currFinalCandidates.filter(x => currEntry.date > (x.publishedAt.getTime() / 1000));
                        if (currFinalCandidates.length === 0) {
                            logger.error(`${profile.nameAndId}, wtf finalCandidates empty`, currMapCandidates, currEntry);
                            return false;
                        }
                    }

                    const currMapNameLower = currEntry.map.toLowerCase();
                    for (const finalCandidate of currFinalCandidates) {
                        const candidateRequestedLocale = finalCandidate.locales.find(x => x.locale === currSrc.locale);
                        const candidateMainLocale = finalCandidate.locales.find(x => x.isMain);
                        if (candidateRequestedLocale && (
                            candidateRequestedLocale.originalName?.toLowerCase() === currMapNameLower ||
                            candidateRequestedLocale.name.toLowerCase() === currMapNameLower
                        )) {
                            allCurrRegionMatches.push(finalCandidate);
                            break;
                        }
                        else if (candidateMainLocale && (
                            candidateMainLocale.originalName?.toLowerCase() === currMapNameLower ||
                            candidateMainLocale.name.toLowerCase() === currMapNameLower
                        )) {
                            allCurrRegionMatches.push(finalCandidate);
                            break;
                        }
                    }
                }
                else {
                    const globalNameMatches = (await this.fetchMaps({ name: currEntry.map })).filter(x => x.regionId !== reqRegionId);
                    allOtherRegionMatches.push(...globalNameMatches);
                }
            }

            const currFinalMatches = new Map(allCurrRegionMatches.map(x => {
                return [`${x.regionId}/${x.mapId}`, { regionId: x.regionId, mapId: x.mapId }];
            }));
            if (currFinalMatches.size === 1) {
                currMappedEntry.mapId = allCurrRegionMatches[0].mapId;
                mappedEntries.push(currMappedEntry);
                continue;
            }

            if (!currFinalMatches.size && bSrcs.length >= sourcesLimit) {
                const tdiffDays = (((new Date()).getTime() / 1000) - firstSrc.entries[entryIndex].date) / (3600 * 24);
                logger.warn(
                    `${profile.nameAndId} couldn't identify map, tdiff=${tdiffDays.toFixed(1)}`,
                    bSrcs.map(x => [x.locale, x.entries[entryIndex]]),
                );
                // FIXME: temporaily disabled
                if (tdiffDays >= 28 && false) {
                    currMappedEntry.mapId = 0;
                    mappedEntries.push(currMappedEntry);
                    continue;
                }
                else {
                    // hold on for few days - it might be just not yet indexed map
                    break;
                }
            }

            // as last effort check for cross bnetId matches
            if (bSrcs.length >= 3 && currFinalMatches.size === 2) {
                const relevantRegions = [GameRegion.US, GameRegion.EU, GameRegion.KR, GameRegion.CN];
                relevantRegions.splice(relevantRegions.findIndex(x => x === reqRegionId), 1);
                const possibleNames = bSrcs.map(x => x.entries[entryIndex].map);

                const allValidCrossLocales: ResolvedMapLocale[] = [];
                for (const item of currFinalMatches.values()) {
                    const crossMapIdMatches = (await this.fetchMaps({
                        regionId: relevantRegions,
                        mapId: item.mapId,
                    }));
                    const nameMatching = crossMapIdMatches.map(x => x.locales).flat(1).filter(x => {
                        return possibleNames.findIndex(y => y === x.originalName || y === x.name) !== -1;
                    });
                    allValidCrossLocales.push(...nameMatching);
                }
                const allValidMapIds = new Set<number>();
                allValidCrossLocales.forEach(x => {
                    allValidMapIds.add(x.bnetId);
                });

                if (allValidMapIds.size === 1) {
                    const finalValidMapId = Array.from(allValidMapIds)[0];
                    const superFinalMatches = allCurrRegionMatches.filter(x => x.mapId !== finalValidMapId);
                    if (superFinalMatches.length === 1) {
                        currMappedEntry.mapId = superFinalMatches[0].mapId;
                        mappedEntries.push(currMappedEntry);
                        continue;
                    }
                }
            }

            if (bSrcs.length >= sourcesLimit) {
                logger.error(
                    `${profile.nameAndId}, failed to find a match`,
                    ...allCurrRegionMatches,
                    bSrcs.map(x => [x.locale, x.entries[entryIndex]]),
                    ...allOtherRegionMatches,
                );

                if (mappedEntries.length) {
                    break;
                }
            }

            return false;
        }

        return {
            matches: mappedEntries,
            integritySince,
        };
    }
}

export class BattleDataUpdater {
    protected bAPIEntry = {
        pub: new BattleAPI({
            gateway: { sc2: 'starcraft2.com/en-us/api' },
        }),
        us: new BattleAPI({
            gateway: { sc2: '{region}.api.blizzard.com' },
            region: GameRegion.US,
        }),
        eu: new BattleAPI({
            gateway: { sc2: '{region}.api.blizzard.com' },
            region: GameRegion.EU,
        }),
        cn: new BattleAPI({
            gateway: { sc2: 'gateway.battlenet.com.cn' },
            region: GameRegion.CN,
        }),
    };
    protected bMapper = new BattleMatchEntryMapper(this.conn);

    constructor (protected conn: orm.Connection) {
    }

    protected getAPIForRegion(regionId: number, preferPublic = false) {
        if (preferPublic) {
            return this.bAPIEntry.pub;
        }
        switch (regionId) {
            case GameRegion.US: {
                return this.bAPIEntry.eu;
            }
            case GameRegion.EU: {
                return this.bAPIEntry.eu;
            }
            case GameRegion.KR: {
                return this.bAPIEntry.pub;
            }
            case GameRegion.CN: {
                return this.bAPIEntry.cn;
            }
        }
    }

    protected async updateAccountProfiles(bnAccount: BnAccount) {
        let bProfiles: BattleSC2ProfileBase[];
        try {
            bProfiles = (await this.bAPIEntry.pub.sc2.getAccount(bnAccount.id)).data;
        }
        catch (err) {
            if (isAxiosError(err)) {
                // err.response!.status === 503
                // supress error even if we fail to obtain list of profiles
                // (due to <https://us.forums.blizzard.com/en/blizzard/t/starcraft-ii-account-endpoint-returning-503-repeatedly/12645>)
                logger.warn(`couldn't acquire list of SC2 profiles for ${bnAccount.nameWithId}`, err.response?.statusText);
                return false;
            }
            else {
                throw err;
            }
        }

        for (const bCurrProfile of bProfiles) {
            let s2profile = bnAccount.profiles.find(x => profileHandle(x) === profileHandle(bCurrProfile));
            if (!s2profile) {
                s2profile = await this.conn.getRepository(S2Profile).findOne({
                    where: {
                        regionId: bCurrProfile.regionId,
                        realmId: bCurrProfile.realmId,
                        profileId: bCurrProfile.profileId,
                    },
                });
                if (!s2profile) {
                    s2profile = S2Profile.create();
                    s2profile.regionId = bCurrProfile.regionId;
                    s2profile.realmId = bCurrProfile.realmId;
                    s2profile.profileId = bCurrProfile.profileId;
                    s2profile.name = bCurrProfile.name;
                    s2profile.nameUpdatedAt = new Date();
                }

                const updatedData: Partial<S2Profile> = {};
                if (!s2profile.account || s2profile.account.id !== bnAccount.id) {
                    updatedData.account = bnAccount;
                    updatedData.accountVerified = true;
                }
                if (s2profile.avatarUrl !== bCurrProfile.avatarUrl) {
                    updatedData.avatarUrl = bCurrProfile.avatarUrl;
                }

                Object.assign(s2profile, updatedData);
                if (this.conn.getRepository(S2Profile).hasId(s2profile)) {
                    if (Object.keys(updatedData).length) {
                        await this.conn.getRepository(S2Profile).update(s2profile.id, updatedData);
                    }
                }
                else {
                    await this.conn.getRepository(S2Profile).insert(s2profile);
                }
                bnAccount.profiles.push(s2profile);
            }
            else {
                if (s2profile.avatarUrl !== bCurrProfile.avatarUrl) {
                    s2profile.avatarUrl = bCurrProfile.avatarUrl;
                    await this.conn.getRepository(S2Profile).update(s2profile.id, {
                        avatarUrl: bCurrProfile.avatarUrl,
                    });
                }
            }
        }

        if (bnAccount.profiles.length > bProfiles.length) {
            const detachedProfiles = bnAccount.profiles.filter(x => !bProfiles.find(y => profileHandle(x) === profileHandle(y)));
            for (const dItem of detachedProfiles) {
                logger.warn(`Detaching profile ${dItem.nameAndId} (verified=${dItem.accountVerified}) from account ${dItem.accountId}`);
                bnAccount.profiles.splice(bnAccount.profiles.findIndex(x => x === dItem), 1);
                const updatedData: Partial<S2Profile> = {
                    accountId: null,
                    accountVerified: false,
                };
                await this.conn.getRepository(S2Profile).update(dItem.id, updatedData);
                Object.assign(dItem, updatedData);
            }
        }

        return true;
    }

    protected async profileEnsureTracking(profile: S2Profile) {
        if (profile.tracking === null) {
            profile.tracking = new S2ProfileTracking();
            profile.tracking.regionId = profile.regionId;
            profile.tracking.realmId = profile.realmId;
            profile.tracking.profileId = profile.profileId;
            profile.tracking.battleAPIErrorCounter = 0;
            profile.tracking.preferPublicGateway = false;
            await this.conn.getRepository(S2ProfileTracking).insert(profile.tracking);
        }
    }

    async updateAccount(accountInfo: BattleUserInfo | number) {
        const accountId = typeof accountInfo === 'number' ? accountInfo : accountInfo.id;
        let bnAccount = await this.conn.getRepository(BnAccount).findOne(accountId, {
            relations: ['profiles'],
        });
        if (!bnAccount) {
            bnAccount = new BnAccount();
            bnAccount.id = accountId;
            bnAccount.profiles = [];
            await this.conn.getRepository(BnAccount).insert(bnAccount);
        }
        if (typeof accountInfo === 'object') {
            bnAccount.battleTag = accountInfo.battletag;
            bnAccount.updatedAt = new Date();
            await this.conn.getRepository(BnAccount).save(bnAccount);
        }
        const profilesUpdated = await this.updateAccountProfiles(bnAccount);
        if (profilesUpdated) {
            bnAccount.profilesUpdatedAt = new Date();
            await this.conn.getRepository(BnAccount).update(bnAccount.id, {
                profilesUpdatedAt: bnAccount.profilesUpdatedAt,
            });
        }
        return bnAccount;
    }

    async updateProfileMetaData(profile: S2Profile) {
        await this.profileEnsureTracking(profile);

        try {
            const bAPI = this.getAPIForRegion(profile.regionId, profile.tracking.preferPublicGateway);
            const bCurrProfile = (await bAPI.sc2.getProfileMeta(profile)).data;

            const updatedData: Partial<S2Profile> = {};
            if (profile.avatarUrl !== bCurrProfile.avatarUrl) {
                updatedData.avatarUrl = bCurrProfile.avatarUrl;
            }

            if (Object.keys(updatedData).length) {
                Object.assign(profile, updatedData);
                await this.conn.getRepository(S2Profile).update(profile.id, updatedData);
            }
        }
        catch (err) {
            if (isAxiosError(err)) {
                logger.warn(`Profile ${profile.nameAndId} code ${err?.code} status ${err.response?.status}`);
                switch (err.response?.status) {
                    case 404: {
                        return;
                        break;
                    }

                    case 500:
                    case 503:
                    case 504: {
                        return;
                        break;
                    }

                    default: {
                        throw err;
                    }
                }
            }
            else {
                throw err;
            }
        }

        await this.conn.getRepository(S2ProfileTracking).update(profile.tracking.id, {
            profileInfoUpdatedAt: new Date(),
        });
    }

    @retry({
        onFailedAttempt: async err => {
            if (isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 500)) {
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
                    2500 * Math.pow(err.attemptNumber, 1.5),
                    30000
                );
                logger.debug(`retrieveMatchHistory failed, status ${err.response?.status} attempt ${err.attemptNumber} retry in ${st}ms`);
                await sleep(st);
            }
            else {
                throw err;
            }
        },
        retries: 4,
    })
    protected async retrieveMatchHistorySingle(bAPI: BattleAPI, profile: S2Profile, locale: GameLocale) {
        const bLocale = `${locale.substr(0, 2)}_${locale.substr(2, 2)}`;
        return (await bAPI.sc2.getProfileMatchHistory({ ...profile, locale: bLocale })).data.matches;
    }

    async updateProfileMatchHistory(profile: S2Profile) {
        await this.profileEnsureTracking(profile);
        const updatedTrackingData: Partial<S2ProfileTracking> = {};
        let newMatchEntries: S2ProfileMatch[] = [];

        try {
            const bAPI = this.getAPIForRegion(profile.regionId, profile.tracking.preferPublicGateway);
            const tdiff = profile.tracking.matchHistoryUpdatedAt ? (
                (new Date()).getTime() - profile.tracking.matchHistoryUpdatedAt.getTime()
            ) / 1000 / 3600.0 : 0;

            const latestStoredRecord = await this.conn.getRepository(S2ProfileMatch).createQueryBuilder('profMatch')
                .andWhere('profMatch.regionId = :regionId AND profMatch.realmId = :realmId AND profMatch.profileId = :profileId', {
                    regionId: profile.regionId,
                    realmId: profile.realmId,
                    profileId: profile.profileId,
                })
                .orderBy('profMatch.id', 'DESC')
                .limit(1)
                .getOne()
            ;

            const dateOfRequest = new Date();
            const bMatchSrcs: BattleMatchesSource[] = [];
            let bMatchHistoryResult: BattleMatchMappingResult | boolean;
            const srcLocales = [
                GameLocale.enUS,
                GameLocale.plPL,
                GameLocale.koKR,
                GameLocale.zhCN,
                GameLocale.zhTW,
                GameLocale.ruRU,
                GameLocale.deDE,
            ];
            for (const locale of srcLocales) {
                bMatchSrcs.push({
                    locale,
                    entries: await this.retrieveMatchHistorySingle(bAPI, profile, locale),
                });
                bMatchHistoryResult = await this.bMapper.mapFromSource(
                    bMatchSrcs,
                    profile,
                    latestStoredRecord,
                    profile.tracking.matchHistoryIntegritySince,
                    srcLocales.length
                );
                // exit early if we get a match just from single locale
                if (bMatchHistoryResult !== false) {
                    break;
                }
            }

            if (typeof bMatchHistoryResult === 'object') {
                if (
                    !profile.tracking.matchHistoryIntegritySince ||
                    profile.tracking.matchHistoryIntegritySince.getTime() !== bMatchHistoryResult.integritySince.getTime()
                ) {
                    updatedTrackingData.matchHistoryIntegritySince = new Date(bMatchHistoryResult.integritySince);
                }

                if (bMatchHistoryResult.matches.length) {
                    const bValidMatches = bMatchHistoryResult.matches.filter(x => x.mapId !== 0);
                    logger.info(oneLine`
                        [${profile.id.toString().padStart(8, ' ')}]
                        recv=${bValidMatches.length.toString().padStart(2, '0')}
                        tdiff=${tdiff.toFixed(1).padStart(5, '0')}h
                        integral=${typeof updatedTrackingData.matchHistoryIntegritySince === 'undefined' ? 1 : 0}
                        :: ${profile.nameAndIdPad}
                    `);

                    for (const item of bValidMatches) {
                        newMatchEntries.push(this.bMapper.createMatchEntry(profile, item));
                    }
                    if (newMatchEntries.length) {
                        await this.conn.getRepository(S2ProfileMatch).insert(newMatchEntries);
                    }

                    const tmpDate = new Date(bMatchHistoryResult.matches[bMatchHistoryResult.matches.length - 1].date * 1000);
                    if (!profile.lastOnlineAt || tmpDate > profile.lastOnlineAt) {
                        profile.lastOnlineAt = tmpDate;
                        await this.conn.getRepository(S2Profile).update(profile.id, {
                            lastOnlineAt: profile.lastOnlineAt,
                        });
                    }
                }
            }
            else if (!bMatchHistoryResult) {
                return;
            }

            updatedTrackingData.matchHistoryUpdatedAt = dateOfRequest;
        }
        catch (err) {
            if (isAxiosError(err)) {
                logger.warn(oneLine`
                    Profile match history ${profile.nameAndId} code ${err?.code} status ${err.response?.status}.
                    errCounter=${profile.tracking.battleAPIErrorCounter}
                    errLast=${profile.tracking.battleAPIErrorLast?.toISOString()}
                `);

                switch (err.response?.status) {
                    case 404:
                    case 500: {
                        updatedTrackingData.battleAPIErrorLast = new Date();
                        updatedTrackingData.battleAPIErrorCounter = profile.tracking.battleAPIErrorCounter + 1;
                        if (profile.tracking.battleAPIErrorCounter > 3 && profile.regionId !== GameRegion.CN) {
                            updatedTrackingData.preferPublicGateway = true;
                        }
                        break;
                    }

                    case 503:
                    case 504: {
                        return;
                        break;
                    }

                    default: {
                        throw err;
                    }
                }
            }
            else {
                throw err;
            }
        }

        if (profile.tracking.battleAPIErrorCounter > 0 && typeof updatedTrackingData.battleAPIErrorCounter === 'undefined') {
            logger.verbose(`Resetting error counter on ${profile.nameAndId}, it was at ${profile.tracking.battleAPIErrorCounter}`);
            updatedTrackingData.battleAPIErrorCounter = 0;
            updatedTrackingData.battleAPIErrorLast = null;
        }

        if (!Object.keys(updatedTrackingData).length) return;

        Object.assign(profile.tracking, updatedTrackingData);
        await this.conn.getRepository(S2ProfileTracking).update(profile.tracking.id, updatedTrackingData);

        return newMatchEntries.length;
    }
}
