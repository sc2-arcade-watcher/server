import * as orm from 'typeorm';
import type lruFactory from 'tiny-lru';
const lru: typeof lruFactory = require('tiny-lru');
import { BattleAPI, BattleUserInfo, BattleSC2ProfileBase, BattleSC2MatchEntry } from './battleAPI';
import { BnAccount } from '../entity/BnAccount';
import { profileHandle } from './common';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileBattleTracking } from '../entity/S2ProfileBattleTracking';
import { isAxiosError, isErrDuplicateEntry, retry, sleep } from '../helpers';
import { logger } from '../logger';
import { S2ProfileMatch, S2MatchSpeed, S2MatchDecision, S2MatchType } from '../entity/S2ProfileMatch';
import { S2Map, S2MapType } from '../entity/S2Map';
import { S2MapLocale } from '../entity/S2MapLocale';
import { oneLine } from 'common-tags';
import { GameRegion, GameLocale, GameLocaleFlag, GameRegionSite } from '../common';
import { S2ProfileMatchMapName } from '../entity/S2ProfileMatchMapName';
import { S2ProfileBattleTrackingRepository } from '../repository/S2ProfileBattleTrackingRepository';
import { S2ProfileRepository } from '../repository/S2ProfileRepository';
import { S2ProfileAccountLink } from '../entity/S2ProfileAccountLink';
import { AxiosError } from 'axios';
import { subDays } from 'date-fns';

const reSpecialChars = /[^a-z0-9]+/g;

export function getAvatarIdentifierFromUrl(avatarUrl: string) {
    // https://static.starcraft2.com/starport/d0e7c831-18ab-4cd6-adc7-9d4a28f49ec7/portraits/3-9.jpg
    const m = avatarUrl.match(/\/([0-9]+\-[0-9]+)\.jpg$/);
    if (!m) return '';
    return m[1];
}

interface ResolvedMapLocale {
    locale: GameLocale;
    isMain: boolean;
    originalName: string;
}

interface MapLocalizedResult {
    regionId: number;
    mapId: number;
    mapType: S2MapType;
    publishedAt: Date;
    locales: ResolvedMapLocale[];
}

interface MapLocalizedName {
    name: string;
    locale: GameLocale;
}

export type BattleMatchMapMapped = BattleSC2MatchEntry & {
    mapId: number;
    mapNames?: MapLocalizedName[];
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
                'map.type',
                'map.publishedAt',
                'mapLocale.locale',
                'mapLocale.isMain',
                'mapLocale.originalName',
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
                mapType: x.type,
                publishedAt: x.publishedAt,
                locales: x.locales as ResolvedMapLocale[],
            };
        });
        this.mapCache.set(cacheKey, mResult);
        return mResult;
    }

    createMatchEntry(profile: S2Profile, bMatch: BattleMatchMapMapped) {
        const s2match = new S2ProfileMatch();
        s2match.regionId = profile.regionId;
        s2match.localProfileId = profile.localProfileId;
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
        const otherRegions = [GameRegion.US, GameRegion.EU, GameRegion.KR, GameRegion.CN];
        otherRegions.splice(otherRegions.findIndex(x => x === reqRegionId), 1);
        const mappedEntries: BattleMatchMapMapped[] = [];

        let iterKeys = Array.from(firstSrc.entries.keys());
        if (latestKnownMatchIndex !== -1) {
            iterKeys = iterKeys.slice(0, latestKnownMatchIndex);
        }
        for (const entryIndex of iterKeys.reverse()) {
            const currMappedEntry: BattleMatchMapMapped = {
                ...firstSrc.entries[entryIndex],
                mapId: 0,
            };
            const entryMapNames: MapLocalizedName[] = currMappedEntry.mapNames = bSrcs.map(x => {
                return {
                    locale: x.locale,
                    name: x.entries[entryIndex].map,
                };
            });
            const entryMapNamesUnique: string[] = Array.from(new Map(bSrcs.map(x => {
                return [x.entries[entryIndex].map.toLowerCase(), x.entries[entryIndex].map];
            })).values());
            const allCurrRegionMatches: MapLocalizedResult[] = [];
            const possibleCrossMatches: MapLocalizedResult[] = [];

            for (const sourceIndex in bSrcs) {
                const currSrc = bSrcs[sourceIndex];
                const currEntry = currSrc.entries[entryIndex];
                const currMapNameLower = currEntry.map.toLowerCase();

                if (Number(sourceIndex) > 0) {
                    const prevEntry = bSrcs[Number(sourceIndex) - 1].entries[Number(entryIndex)];
                    if (currEntry.date !== prevEntry.date) {
                        logger.error(`${profile.nameAndId}, Date missmatch between sources`, prevEntry, currEntry);
                        return false;
                    }
                }

                const currGlobalCandidates = await this.fetchMaps({ name: currEntry.map });
                const currGlobalNameMatchCount = (new Set(currGlobalCandidates.map(x => x.regionId))).size;
                const currRegionalMapCandidates = currGlobalCandidates.filter(x => x.regionId === reqRegionId);

                // if name isn't globally unique it's likely it's incorrect, due to some cache related bugs on Battle.net API side
                // but the bug actually happens even if it's unique,
                // so, if we reach enough name sources and at least two are unique we need to account for that scenario as well
                // TODO: consider replacing `sourcesLimit` with `Math.min(3, sourcesLimit)` so we can get the match sooner in 2nd scenario?
                if (currGlobalNameMatchCount > 1 || (bSrcs.length >= sourcesLimit && entryMapNamesUnique.length >= 2)) {
                    // if not unique don't proceed until we have enough data to workaround the name bug
                    if (bSrcs.length < Math.min(3, sourcesLimit) && entryMapNamesUnique.length < 2) {
                        return false;
                    }

                    const currCrossRegionMapCandidates = currGlobalCandidates.filter(x => x.regionId !== reqRegionId);

                    for (const currCandidate of currCrossRegionMapCandidates) {
                        // possibly if name is incorrect it's always the one from the mainLocale?
                        // if that's true this could be improved
                        const originalNameMatches = currCandidate.locales.findIndex(x => {
                            return x.originalName?.toLowerCase() === currMapNameLower;
                        }) !== -1;
                        if (originalNameMatches) {
                            possibleCrossMatches.push(currCandidate);
                        }
                    }
                }

                // if maps are deleted then name can be reclaimed, so we can get more than more result
                if (currRegionalMapCandidates.length >= 1) {
                    let currRelevantCandidates: MapLocalizedResult[] = [].concat(...currRegionalMapCandidates);

                    if (currRelevantCandidates.length > 1) {
                        // name might be reclaimed - find appropriate map using available timestamps
                        // the list is intially sorted from newest to oldest
                        currRelevantCandidates = currRelevantCandidates.filter(x => currEntry.date > (x.publishedAt.getTime() / 1000));
                    }

                    for (const finalCandidate of currRelevantCandidates) {
                        const matchedLocaleData = (
                            finalCandidate.locales.find(x => x.locale === currSrc.locale) ??
                            finalCandidate.locales.find(x => x.isMain)
                        );
                        if (!matchedLocaleData) {
                            logger.error(`${profile.nameAndId} matchedLocaleData undefined`, finalCandidate);
                            return false;
                        }
                        if (matchedLocaleData.originalName?.toLowerCase() === currMapNameLower) {
                            allCurrRegionMatches.push(finalCandidate);
                            break;
                        }
                    }
                }
            }

            type GlobalResultType = { mapId: number, regions: Set<number>, maps: MapLocalizedResult[], repetitions: number };
            const bnetIdMap = new Map<number, GlobalResultType>();
            for (const item of allCurrRegionMatches.concat(possibleCrossMatches)) {
                let bnetMapResults = bnetIdMap.get(item.mapId);
                if (!bnetMapResults) {
                    bnetMapResults = {
                        mapId: item.mapId,
                        regions: new Set(),
                        maps: [],
                        repetitions: 0,
                    };
                    bnetIdMap.set(item.mapId, bnetMapResults);
                }
                bnetMapResults.repetitions++;
                if (bnetMapResults.maps.findIndex(x => x.regionId === item.regionId && x.mapId === item.mapId) !== -1) {
                    continue;
                }
                bnetMapResults.regions.add(item.regionId);
                bnetMapResults.maps.push(item);
            }

            const bnetCrossMatches = Array.from(bnetIdMap.values())
                .filter(x => x.regions.size > 1)
                .sort((a, b) => b.regions.size - a.regions.size)
            ;

            if (bnetCrossMatches.length >= 1) {
                if (bnetCrossMatches.length > 1) {
                    logger.error(`${profile.nameAndId} multiple cross matches`, entryMapNames, bnetCrossMatches.map(x => x.mapId));
                    return false;
                }

                currMappedEntry.mapId = bnetCrossMatches[0].mapId;
                mappedEntries.push(currMappedEntry);
                continue;
            }

            const matchedMapsRegional = Array.from(bnetIdMap.values())
                .map(x => x.maps)
                .flat(1)
                .filter(x => x.regionId === reqRegionId)
            ;
            if (matchedMapsRegional.length === 1) {
                const matchedMap = matchedMapsRegional[0];
                const mapMainLocale = matchedMap.locales.find(x => x.isMain);
                const entryMainLocale = entryMapNames.find(x => x.locale === mapMainLocale.locale);
                const isMainLocaleMatching = (
                    mapMainLocale.originalName.toLowerCase() === entryMainLocale?.name.toLowerCase()
                );
                const isBnetIdCrossMatching = Array.from(bnetIdMap.values())
                    .filter(x => !x.regions.has(reqRegionId))
                    .map(x => x.maps)
                    .length
                ;
                const repetitions = bnetIdMap.get(matchedMap.mapId).repetitions;
                const availableUniqueNames = Array.from(new Set(matchedMap.locales.map(x => x.originalName.toLowerCase())));
                if (
                    (isMainLocaleMatching && isBnetIdCrossMatching && entryMapNamesUnique.length >= 2) ||
                    (isBnetIdCrossMatching && entryMapNamesUnique.length >= 2) ||
                    (isMainLocaleMatching && repetitions >= 2) ||
                    (isMainLocaleMatching && !isBnetIdCrossMatching) ||
                    (isMainLocaleMatching || entryMapNamesUnique.length === availableUniqueNames.length)
                ) {
                    if (matchedMap.mapType === S2MapType.DependencyMod || matchedMap.mapType === S2MapType.ExtensionMod) {
                        if (bSrcs.length < sourcesLimit) {
                            return false;
                        }
                        logger.warn(`${profile.nameAndId} matched mod of type=${matchedMap.mapType} instead of map - wtf?`, matchedMap, entryMapNamesUnique);
                        currMappedEntry.mapId = 0;
                        mappedEntries.push(currMappedEntry);
                        continue;
                    }

                    currMappedEntry.mapId = matchedMap.mapId;
                    mappedEntries.push(currMappedEntry);
                    continue;
                }
                else if (bSrcs.length >= sourcesLimit) {
                    logger.warn(
                        `${profile.nameAndId} matchedUniqueNames insufficient`,
                        entryMapNamesUnique,
                        availableUniqueNames
                    );
                }
            }
            else if (bSrcs.length >= sourcesLimit) {
                logger.warn(
                    `${profile.nameAndId} matchedMapsRegional=${matchedMapsRegional.length}`,
                    entryMapNamesUnique,
                    matchedMapsRegional
                );
            }


            if (bSrcs.length >= sourcesLimit) {
                const tdiffDays = (((new Date()).getTime() / 1000) - firstSrc.entries[entryIndex].date) / (3600 * 24);
                if (tdiffDays <= 0.2) {
                    // hold on - it might be just not yet indexed map
                    break;
                }

                logger.warn(
                    `${profile.nameAndId} couldn't identify map, tdiff=${tdiffDays.toFixed(1)}`,
                    bSrcs.map(x => [x.locale, x.entries[entryIndex].map, x.entries[entryIndex].date]),
                    Array.from(bnetIdMap.values()).map(x => `${Array.from(x.regions.keys()).join(',')}/${x.mapId}`),
                );

                currMappedEntry.mapNames = entryMapNames;
                currMappedEntry.mapId = 0;
                mappedEntries.push(currMappedEntry);
                continue;
            }

            return false;
        }

        return {
            matches: mappedEntries,
            integritySince,
        };
    }
}


export interface BattleUpdatedMatchHistory {
    profile: S2Profile;
    updatedBattleTracking: Partial<S2ProfileBattleTracking>;
    matches: S2ProfileMatch[];
    mapNames: S2ProfileMatchMapName[];
    lastOnlineAt: Date | null;
    lastStoredMatch: S2ProfileMatch | null;
}

export interface BattleUpdatedProfileMeta {
    profile: S2Profile;
    updatedBattleTracking: Partial<S2ProfileBattleTracking>;
    avatar: string | null;
}

export interface BattleUpdatedProfileCommon {
    profile: S2Profile;
    updatedProfileData: Partial<S2Profile>;
    updatedBattleTracking: Partial<S2ProfileBattleTracking>;
    matches: S2ProfileMatch[];
    mapNames: S2ProfileMatchMapName[];
}

export class BattleDataUpdater {
    protected bAPIEntry = {
        pub: new BattleAPI({
            gateway: { sc2: 'starcraft2.com/en-us/api' },
        }),
        us: new BattleAPI({
            gateway: { sc2: '{region}.api.blizzard.com' },
            region: GameRegionSite.US,
        }),
        eu: new BattleAPI({
            gateway: { sc2: '{region}.api.blizzard.com' },
            region: GameRegionSite.EU,
        }),
        kr: new BattleAPI({
            gateway: { sc2: '{region}.api.blizzard.com' },
            region: GameRegionSite.KR,
        }),
        tw: new BattleAPI({
            gateway: { sc2: '{region}.api.blizzard.com' },
            region: GameRegionSite.TW,
        }),
        cn: new BattleAPI({
            gateway: { sc2: 'gateway.battlenet.com.cn' },
            region: GameRegionSite.CN,
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
                return this.bAPIEntry.kr;
            }
            case GameRegion.CN: {
                // return this.bAPIEntry.cn;
                // TW gateway supports CN and is faster to respond
                return this.bAPIEntry.tw;
            }
        }
    }

    protected async updateAccountProfiles(bnAccount: BnAccount) {
        let bProfiles: BattleSC2ProfileBase[];
        try {
            try {
                bProfiles = (await this.bAPIEntry.eu.sc2.getAccount(bnAccount.id)).data;
            }
            catch (err) {
                if (!isAxiosError(err)) throw err;
            }

            if (!bProfiles) {
                bProfiles = (await this.bAPIEntry.pub.sc2.getAccount(bnAccount.id)).data;
            }
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

        const initProfileLinksLen = bnAccount.profileLinks.length;

        // ensure profiles exists & update avatars
        const affectedProfiles = await Promise.all(bProfiles.map(async bCurrProfile => {
            const bCurrAvatar = getAvatarIdentifierFromUrl(bCurrProfile.avatarUrl);
            const s2profile = await this.conn.getCustomRepository(S2ProfileRepository).fetchOrCreate({
                ...bCurrProfile,
                discriminator: 0,
                avatar: bCurrAvatar,
            });
            if (s2profile.avatar !== bCurrAvatar) {
                s2profile.avatar = bCurrAvatar;
                await this.conn.getRepository(S2Profile).update(s2profile.id, {
                    avatar: bCurrAvatar,
                });
            }
            return s2profile;
        }));

        // link newly discovered profiles
        const addedProfileLinks: S2ProfileAccountLink[] = [];
        for (const bCurrProfile of bProfiles) {
            let profileLink = bnAccount.profileLinks.find(x => profileHandle(x) === profileHandle(bCurrProfile));
            if (!profileLink) {
                const profile = affectedProfiles.find(x => profileHandle(x) === profileHandle(bCurrProfile));
                logger.info(`Attaching new profile ${profile.fullnameWithHandle} to account ${bnAccount.nameWithId}`);

                profileLink = this.conn.getRepository(S2ProfileAccountLink).create({
                    regionId: bCurrProfile.regionId,
                    realmId: bCurrProfile.realmId,
                    profileId: bCurrProfile.profileId,
                    account: bnAccount,
                    accountVerified: true,
                });
                bnAccount.profileLinks.push(profileLink);
                addedProfileLinks.push(profileLink);
                await this.conn.getRepository(S2ProfileAccountLink).insert(profileLink);
            }
            else if (!profileLink.accountVerified) {
                profileLink.accountVerified = true;
                await this.conn.getRepository(S2ProfileAccountLink).update(this.conn.getRepository(S2ProfileAccountLink).getId(profileLink), {
                    accountVerified: true,
                });
            }
        }

        // unlink profiles that might have been deleted/banned/miss-linked/whatever .. ?
        const removedProfileLinks = bnAccount.profileLinks.filter(x => !bProfiles.find(y => profileHandle(x) === profileHandle(y)));
        for (const profileLink of removedProfileLinks) {
            logger.info(`Detaching profile ${profileHandle(profileLink)} from account ${profileLink.accountId} (verified=${profileLink.accountVerified})`);
            // TODO: can Battle API be trusted in that regard?
            // bnAccount.profileLinks.splice(bnAccount.profileLinks.findIndex(x => x === profileLink), 1);
            // await this.conn.getRepository(S2ProfileAccountLink).delete(this.conn.getRepository(S2ProfileAccountLink).getId(profileLink));
            await this.conn.getRepository(S2ProfileAccountLink).update(this.conn.getRepository(S2ProfileAccountLink).getId(profileLink), {
                accountVerified: false,
            });
        }

        return {
            addedProfileLinks,
            removedProfileLinks,
        };
    }

    protected async profileEnsureTracking(profile: S2Profile) {
        if (profile.battleTracking === null) {
            profile.battleTracking = await this.conn.getCustomRepository(S2ProfileBattleTrackingRepository).fetchOrCreate(profile);
        }
    }

    protected handleAxiosError(err: AxiosError, profile: S2Profile, updatedTrackingData: Partial<S2ProfileBattleTracking>) {
        logger.warn(oneLine`
            [${profile.id.toString().padStart(8, ' ')}] ${profile.nameAndId}
            req=${err.config.url}
            code=${err?.code}
            status=${err.response?.status}
            errCounter=${profile.battleTracking.battleAPIErrorCounter}
            errLast=${profile.battleTracking.battleAPIErrorLast?.toISOString()}
        `);

        if (err.response) {
            switch (err.response.status) {
                case 404:
                case 500:
                case 503:
                case 504: {
                    break;
                }

                default: {
                    throw err;
                }
            }
        }
        else if (err.code !== 'ECONNABORTED') {
            throw err;
        }

        updatedTrackingData.battleAPIErrorLast = new Date();
        updatedTrackingData.battleAPIErrorCounter = profile.battleTracking.battleAPIErrorCounter + 1;
        if (profile.battleTracking.battleAPIErrorCounter > 3 && profile.regionId !== GameRegion.CN) {
            updatedTrackingData.publicGatewaySince = new Date();
        }
    }

    async updateAccount(accountInfo: BattleUserInfo | number) {
        const accountId = typeof accountInfo === 'number' ? accountInfo : accountInfo.id;
        let bnAccount = await this.conn.getRepository(BnAccount).findOne(accountId, {
            relations: ['profileLinks'],
        });
        if (!bnAccount) {
            bnAccount = new BnAccount();
            bnAccount.id = accountId;
            bnAccount.profileLinks = [];
            await this.conn.getRepository(BnAccount).save(bnAccount, { transaction: false });
        }
        if (typeof accountInfo === 'object') {
            bnAccount.battleTag = accountInfo.battletag;
            bnAccount.updatedAt = new Date();
            await this.conn.getRepository(BnAccount).save(bnAccount, { transaction: false });
        }
        const profileLinkingResult = await this.updateAccountProfiles(bnAccount);
        if (profileLinkingResult) {
            bnAccount.profilesUpdatedAt = new Date();
            await this.conn.getRepository(BnAccount).update(bnAccount.id, {
                profilesUpdatedAt: bnAccount.profilesUpdatedAt,
            });
        }
        return bnAccount;
    }

    async updateProfileMetaData(profile: S2Profile) {
        await this.profileEnsureTracking(profile);

        const result: BattleUpdatedProfileMeta = {
            profile: profile,
            updatedBattleTracking: {},
            avatar: null,
        };

        try {
            const bAPI = this.getAPIForRegion(profile.regionId, profile.battleTracking.publicGatewaySince !== null);
            const bCurrProfile = (await bAPI.sc2.getProfileMeta(profile)).data;
            const bCurrAvatar = getAvatarIdentifierFromUrl(bCurrProfile.avatarUrl);

            if (profile.avatar !== bCurrAvatar) {
                result.avatar = bCurrAvatar;
            }

            result.updatedBattleTracking.profileInfoUpdatedAt = new Date();

            if (result.avatar) {
                logger.info(oneLine`
                    [${profile.id.toString().padStart(8, ' ')}] Updated metadata
                    pavatar=${profile.avatar.padEnd(6)} navatar=${result.avatar.padEnd(6)}
                    :: ${profile.nameAndIdPad}
                `);
            }
        }
        catch (err) {
            if (isAxiosError(err)) {
                this.handleAxiosError(err, profile, result.updatedBattleTracking);
            }
            else {
                throw err;
            }
        }

        return result;
    }

    @retry({
        onFailedAttempt: async err => {
            if (isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 429 || err.response?.status === 500)) {
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
                    1500 * Math.pow(err.attemptNumber, 1.5),
                    15000
                );
                logger.debug(`retrieveMatchHistory failed, status ${err.response?.status} attempt ${err.attemptNumber} retry in ${st}ms`);
                await sleep(st);
            }
            else {
                throw err;
            }
        },
        retries: 3,
    })
    protected async retrieveMatchHistorySingle(bAPI: BattleAPI, profile: S2Profile, locale: GameLocale) {
        const bLocale = `${locale.substr(0, 2)}_${locale.substr(2, 2)}`;
        return (await bAPI.sc2.getProfileMatchHistory({ ...profile, locale: bLocale })).data.matches;
    }

    async updateProfileMatchHistory(profile: S2Profile) {
        await this.profileEnsureTracking(profile);

        const result: BattleUpdatedMatchHistory = {
            profile: profile,
            updatedBattleTracking: {},
            matches: [],
            mapNames: [],
            lastOnlineAt: null,
            lastStoredMatch: null,
        };

        try {
            let bAPI: BattleAPI;
            if (profile.regionId === GameRegion.CN && profile.battleTracking.battleAPIErrorCounter % 2 === 1) {
                bAPI = this.bAPIEntry.cn;
            }
            else {
                bAPI = this.getAPIForRegion(profile.regionId, profile.battleTracking.publicGatewaySince !== null);
            }
            const tdiff = profile.battleTracking.matchHistoryUpdatedAt ? (
                (new Date()).getTime() - profile.battleTracking.matchHistoryUpdatedAt.getTime()
            ) / 1000 / 3600.0 : 0;

            const latestStoredRecord = await this.conn.getRepository(S2ProfileMatch).createQueryBuilder('profMatch')
                .andWhere('profMatch.regionId = :regionId AND profMatch.localProfileId = :localProfileId', {
                    regionId: profile.regionId,
                    localProfileId: profile.localProfileId,
                })
                .orderBy('profMatch.id', 'DESC')
                .limit(1)
                .getOne()
            ;
            if (latestStoredRecord) {
                result.lastStoredMatch = latestStoredRecord;
            }

            const dateOfRequest = new Date();
            const bMatchSrcs: BattleMatchesSource[] = [];
            let bMatchHistoryResult: BattleMatchMappingResult | boolean;
            const srcLocales = [
                GameLocale.enUS,
                GameLocale.deDE,
                GameLocale.enGB,
                GameLocale.koKR,
                GameLocale.esES,
                GameLocale.frFR,
                GameLocale.itIT,
                GameLocale.plPL,
                GameLocale.ptPT,
                GameLocale.ruRU,
                GameLocale.zhCN,
                GameLocale.zhTW,
                GameLocale.esMX,
                GameLocale.ptBR,
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
                    profile.battleTracking.matchHistoryIntegritySince,
                    srcLocales.length
                );
                // exit as soon as we get a match
                if (bMatchHistoryResult !== false) {
                    break;
                }
            }

            if (typeof bMatchHistoryResult === 'object') {
                if (
                    !profile.battleTracking.matchHistoryIntegritySince ||
                    profile.battleTracking.matchHistoryIntegritySince.getTime() !== bMatchHistoryResult.integritySince.getTime()
                ) {
                    result.updatedBattleTracking.matchHistoryIntegritySince = new Date(bMatchHistoryResult.integritySince);
                }

                if (bMatchHistoryResult.matches.length) {
                    const bUnknownMatches = bMatchHistoryResult.matches.filter(x => x.mapId === 0);
                    logger.info(oneLine`
                        [${profile.id.toString().padStart(8, ' ')}]
                        recv=${bMatchHistoryResult.matches.length.toString().padStart(2, '0')}
                        sreq=${bMatchSrcs.length}
                        tdiff=${tdiff.toFixed(1).padStart(5, '0')}h
                        int=${typeof result.updatedBattleTracking.matchHistoryIntegritySince === 'undefined' ? 1 : 0}
                        unk=${bUnknownMatches.length}
                        :: ${profile.nameAndIdPad}
                    `);

                    result.matches = bMatchHistoryResult.matches.map(x => this.bMapper.createMatchEntry(profile, x));
                    for (const [currIndex, currMatch] of bMatchHistoryResult.matches.entries()) {
                        if (currMatch.mapId !== 0) continue;

                        const currMapNames: S2ProfileMatchMapName[] = [];
                        for (const item of currMatch.mapNames) {
                            let cName = currMapNames.find(x => x.name === item.name);
                            if (!cName) {
                                cName = new S2ProfileMatchMapName();
                                cName.match = result.matches[currIndex];
                                cName.name = item.name;
                                cName.locales = 0;
                                currMapNames.push(cName);
                            }
                            cName.locales |= GameLocaleFlag[item.locale];
                        }
                        result.mapNames.push(...currMapNames);
                    }

                    const tmpDate = new Date(bMatchHistoryResult.matches[bMatchHistoryResult.matches.length - 1].date * 1000);
                    if (!profile.lastOnlineAt || tmpDate > profile.lastOnlineAt) {
                        result.lastOnlineAt = tmpDate;
                    }
                }
            }
            else if (!bMatchHistoryResult) {
                // exit early
                return result;
            }

            result.updatedBattleTracking.matchHistoryUpdatedAt = dateOfRequest;
        }
        catch (err) {
            if (isAxiosError(err)) {
                this.handleAxiosError(err, profile, result.updatedBattleTracking);
            }
            else {
                throw err;
            }
        }

        if (profile.battleTracking.battleAPIErrorCounter > 0 && typeof result.updatedBattleTracking.battleAPIErrorCounter === 'undefined') {
            logger.verbose(`Resetting error counter on ${profile.nameAndId}, it was at ${profile.battleTracking.battleAPIErrorCounter}`);
            result.updatedBattleTracking.battleAPIErrorCounter = 0;
            result.updatedBattleTracking.battleAPIErrorLast = null;
        }

        return result;
    }

    async updateProfileCommon(profile: S2Profile) {
        const updatedProfileData: Partial<S2Profile> = {};
        const updatedBattleTracking: Partial<S2ProfileBattleTracking> = {};

        const matchResult = await this.updateProfileMatchHistory(profile);
        if (matchResult.lastOnlineAt) {
            updatedProfileData.lastOnlineAt = matchResult.lastOnlineAt;
        }
        Object.assign(updatedBattleTracking, matchResult.updatedBattleTracking);

        let metaResult: BattleUpdatedProfileMeta;
        if (
            !profile.avatar ||
            (
                matchResult.matches.length &&
                (!profile.battleTracking?.profileInfoUpdatedAt || profile.battleTracking?.profileInfoUpdatedAt < subDays(profile.lastOnlineAt ?? new Date(), 21))
            )
        ) {
            metaResult = await this.updateProfileMetaData(profile);
            if (metaResult.avatar) {
                updatedProfileData.avatar = metaResult.avatar;
            }
            Object.assign(updatedBattleTracking, metaResult.updatedBattleTracking);
        }

        return <BattleUpdatedProfileCommon>{
            profile: profile,
            updatedProfileData: updatedProfileData,
            updatedBattleTracking: updatedBattleTracking,
            matches: matchResult.matches,
            mapNames: matchResult.mapNames,
        };
    }
}
