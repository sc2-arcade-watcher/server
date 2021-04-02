import * as orm from 'typeorm';
import PQueue from 'p-queue';
import { logger } from '../logger';
import { retry, sleep, isAxiosError } from '../helpers';
import { S2MapHeader } from '../entity/S2MapHeader';
import { MapResolver, reprocessMapHeader, MapHeaderDataRaw, AttributeValue, MapHeader } from './mapResolver';
import { MessageKind, MessageMapRevisionResult, MessageMapDiscoverResult, MapVersionInfo } from '../server/executiveServer';
import { decodeMapVersion, GameRegion, GameLocale, GameLocaleFlag } from '../common';
import { S2Map, S2MapType } from '../entity/S2Map';
import { S2MapCategory } from '../entity/S2MapCategory';
import { S2Profile } from '../entity/S2Profile';
import { S2MapTracking } from '../entity/S2MapTracking';
import { S2MapTrackingRepository } from '../repository/S2MapTrackingRepository';
import { S2MapVariant } from '../entity/S2MapVariant';
import { AttributeSystemNamespaceId, AttributeId, lobbyDelayValues } from './attributes';
import { S2MapRepository } from '../repository/S2MapRepository';
import { S2MapLocale } from '../entity/S2MapLocale';
import { S2MapDependency } from '../entity/S2MapDependency';
import { S2ProfileRepository } from '../repository/S2ProfileRepository';
import { ProfileManager } from '../manager/profileManager';

export class MapIndexer {
    public readonly resolver = new MapResolver(this.conn);
    protected taskQueue = new PQueue({
        concurrency: Number(process.env.STARC_DHOST_MR_QUEUE_LIMIT) || 8,
    });
    protected mapCategories: S2MapCategory[];
    protected currentlyProcessing = new Set<string>();

    constructor(public conn: orm.Connection) {
    }

    async load() {
        this.mapCategories = await this.conn.getRepository(S2MapCategory).find();
    }

    async close() {
        logger.verbose(`Stopping map indexing.. queue=${this.taskQueue.size} pending=${this.taskQueue.pending}`);
        this.taskQueue.pause();
        this.taskQueue.clear();
        await this.taskQueue.onIdle();
        logger.verbose(`Stopped map indexing`);
    }

    @retry({
        retries: 2,
        onFailedAttempt: err => {
            logger.warn(`failed to populate header`, err);
        },
    })
    public async populateMapHeader(mhead: S2MapHeader) {
        logger.verbose(`resolving header.. map=${mhead.linkVer} hash=${mhead.headerHash}`);
        const rcode = GameRegion[mhead.regionId];

        const headerRawData = await this.resolver.getMapHeader(rcode, mhead.headerHash);

        if (!mhead.uploadedAt) {
            const s2mhResponse = await this.resolver.depot.retrieveHead(rcode, `${mhead.headerHash}.s2mh`);
            mhead.uploadedAt = new Date(s2mhResponse.headers['last-modified']);
        }

        if (!mhead.archiveSize) {
            try {
                const s2maResponse = await this.resolver.depot.retrieveHead(rcode, `${headerRawData.archiveHandle.hash}.${headerRawData.archiveHandle.type}`);
                if (s2maResponse.headers['content-length']) {
                    mhead.archiveSize = Number(s2maResponse.headers['content-length']);
                }
                else {
                    // most likely means it's invalid archive, such as:
                    // US 02374236dc17df4e4e0ee7dd85662c2dca06a666795cec665ef37fad9187d593.s2ma
                    mhead.archiveSize = null;
                }
            }
            catch (err) {
                // CN depot, specificaly, might repeatedly return 503 for non cached s2ma and possibly other files (?)
                // just give up in that case - it probably affects only old revisions of s2ma's
                // example: CN 54c06a38ab2eb96811742cd0bf4107d9be7b58019ca21b73936338b4df378a7e.s2ma
                if (isAxiosError(err) && err.response?.status === 503) {
                    mhead.archiveSize = null;
                    logger.warn(`failed to obtain archiveSize of ${mhead.linkVer} due to 503`);
                }
                else {
                    throw err;
                }
            }
        }

        mhead.archiveHash = headerRawData.archiveHandle.hash;
        mhead.archiveFilename = headerRawData.filename;

        return headerRawData;
    }

    protected async prepareMapRevision(regionId: number, mapId: number, revision: MapVersionInfo) {
        const [ majorVer, minorVer ] = decodeMapVersion(revision.mapVersion);

        let mhead = await this.conn.getRepository(S2MapHeader).findOne({
            where: {
                regionId: regionId,
                bnetId: mapId,
                majorVersion: majorVer,
                minorVersion: minorVer,
            },
        });

        if (!mhead) {
            mhead = new S2MapHeader();
            mhead.regionId = regionId;
            mhead.bnetId = mapId;
            mhead.majorVersion = majorVer;
            mhead.minorVersion = minorVer;
            mhead.headerHash = revision.headerHash;
            mhead.isPrivate = revision.isPrivate;
            mhead.isExtensionMod = revision.isExtensionMod;

            const rawHeaderData = await this.populateMapHeader(mhead);
            logger.verbose(`processed header map=${mhead.linkVer} name=${rawHeaderData.filename} uploadTime=${mhead.uploadedAt.toUTCString()}`);

            return {
                mhead,
                rawHeaderData,
            };
        }

        return {
            mhead,
        };
    }

    async updateMapLocale(map: S2Map, mhead: S2MapHeader, rawHeaderData: MapHeaderDataRaw, forceUpdate = false) {
        const isInitialVersion = (
            map.initialVersion.majorVersion === mhead.majorVersion && map.initialVersion.minorVersion === mhead.minorVersion
        );
        const isLatestVersion = (
            mhead.majorVersion === map.currentVersion.majorVersion && mhead.minorVersion === map.currentVersion.minorVersion
        );
        const rcode = GameRegion[mhead.regionId];
        let dUpdated = false;

        for (const lTable of rawHeaderData.localeTable) {
            let s2locale = map.getLocalization(lTable.locale);

            const isHeaderNewer = (
                !s2locale ||
                (mhead.majorVersion > s2locale.latestMajorVersion) ||
                (mhead.majorVersion === s2locale.latestMajorVersion && mhead.minorVersion > s2locale.latestMinorVersion) ||
                (mhead.majorVersion === s2locale.latestMajorVersion && mhead.minorVersion === s2locale.latestMinorVersion && forceUpdate)
            );

            const isHeaderOlder = (
                !s2locale ||
                (mhead.majorVersion < s2locale.initialMajorVersion) ||
                (mhead.majorVersion === s2locale.initialMajorVersion && mhead.minorVersion < s2locale.initialMinorVersion) ||
                (mhead.majorVersion === s2locale.initialMajorVersion && mhead.minorVersion === s2locale.initialMinorVersion && forceUpdate) ||
                (0 === s2locale.initialMajorVersion && 0 === s2locale.initialMinorVersion && forceUpdate)
            );

            if (!s2locale) {
                s2locale = new S2MapLocale();
                s2locale.regionId = map.regionId;
                s2locale.bnetId = map.bnetId;
                s2locale.locale = lTable.locale;
                s2locale.isMain = false;
                s2locale.inLatestVersion = false;
                s2locale.initialMajorVersion = mhead.majorVersion;
                s2locale.initialMinorVersion = mhead.minorVersion;
                s2locale.originalName = null;
                map.locales.push(s2locale);
            }

            let localizedMapHeader: MapHeader;
            // don't load it unless required
            if (isHeaderNewer || isInitialVersion || s2locale.originalName === null) {
                localizedMapHeader = reprocessMapHeader(rawHeaderData, await this.resolver.getMapLocalization(
                    rcode,
                    lTable.stringTable[0].hash,
                ));
            }

            if (isHeaderNewer) {
                s2locale.latestMajorVersion = mhead.majorVersion;
                s2locale.latestMinorVersion = mhead.minorVersion;
                if (isLatestVersion) {
                    s2locale.inLatestVersion = true;
                }
                s2locale.tableHash = lTable.stringTable[0].hash;
                s2locale.name = localizedMapHeader.workingSet.name ?? '';
                s2locale.description = localizedMapHeader.workingSet.description ?? '';
                s2locale.website = localizedMapHeader.arcadeInfo?.website ?? '';
                dUpdated = true;
            }

            if (isHeaderOlder) {
                s2locale.initialMajorVersion = mhead.majorVersion;
                s2locale.initialMinorVersion = mhead.minorVersion;
                dUpdated = true;
            }

            if (isInitialVersion || s2locale.originalName === null) {
                s2locale.originalName = localizedMapHeader.workingSet.name;
                dUpdated = true;
            }
        }

        for (const s2locale of map.locales) {
            const localeIndex = rawHeaderData.localeTable.findIndex(x => x.locale === s2locale.locale);
            if (localeIndex !== -1) continue;
            const isHeaderNewer = (
                (mhead.majorVersion > s2locale.latestMajorVersion) ||
                (mhead.majorVersion === s2locale.latestMajorVersion && mhead.minorVersion > s2locale.latestMinorVersion) ||
                (mhead.majorVersion === s2locale.latestMajorVersion && mhead.minorVersion === s2locale.latestMinorVersion && forceUpdate)
            );
            if (!isHeaderNewer || !s2locale.inLatestVersion) continue;
            s2locale.inLatestVersion = false;

            dUpdated = true;
        }

        if (isInitialVersion) {
            const mainLocaleable = rawHeaderData.workingSet.localeTable[0];
            const s2locale = map.locales.find(x => x.locale === mainLocaleable.locale);
            s2locale.isMain = true;

            dUpdated = true;
        }

        return dUpdated;
    }

    updateMapDependency(map: S2Map, mhead: S2MapHeader, rawHeaderData: MapHeaderDataRaw) {
        if (rawHeaderData.extraDependencies) {
            let depIndex = 0;
            for (const depItem of rawHeaderData.extraDependencies.reverse()) {
                let s2dep = map.dependencies[depIndex];
                if (!s2dep) {
                    s2dep = new S2MapDependency();
                    s2dep.regionId = map.regionId;
                    s2dep.mapId = map.bnetId;
                    s2dep.dependencyIndex = depIndex;
                    map.dependencies.push(s2dep);
                }
                s2dep.dependencyMapId = depItem.id;
                [s2dep.majorVersion, s2dep.minorVersion] = decodeMapVersion(depItem.version);
                ++depIndex;
            }

            for (let i = depIndex; i < map.dependencies.length; i++) {
                const s2dep = map.dependencies[i];
                s2dep.dependencyMapId = 0;
                s2dep.majorVersion = 0;
                s2dep.minorVersion = 0;
            }
        }
    }

    async updateMapDataFromHeader(map: S2Map, mhead: S2MapHeader, rawHeaderData?: MapHeaderDataRaw, forceUpdate = false) {
        const isInitialUpdate = (
            !map.initialVersion ||
            (mhead.majorVersion < map.initialVersion.majorVersion) ||
            (mhead.majorVersion === map.initialVersion.majorVersion && mhead.minorVersion < map.initialVersion.minorVersion) ||
            (map.initialVersion.majorVersion === mhead.majorVersion && map.initialVersion.minorVersion === mhead.minorVersion && forceUpdate)
        );
        const isLatestUpdate = (
            !map.currentVersion ||
            (mhead.majorVersion > map.currentVersion.majorVersion) ||
            (mhead.majorVersion === map.currentVersion.majorVersion && mhead.minorVersion > map.currentVersion.minorVersion) ||
            (mhead.majorVersion === map.currentVersion.majorVersion && mhead.minorVersion === map.currentVersion.minorVersion && forceUpdate)
        );
        const rcode = GameRegion[mhead.regionId];
        let dUpdated = false;

        if (
            (isLatestUpdate || forceUpdate) &&
            !rawHeaderData
        ) {
            rawHeaderData = await this.resolver.getMapHeader(rcode, mhead.headerHash);
        }

        if (isInitialUpdate) {
            map.publishedAt = new Date(mhead.uploadedAt);
            map.initialVersion = mhead;
            dUpdated = true;
        }

        if (isLatestUpdate) {
            const mainLocaleTable = rawHeaderData.workingSet.localeTable.find(x => x.locale === GameLocale.enUS)
                ?? rawHeaderData.workingSet.localeTable[0]
            ;
            const localizationData = await this.resolver.getMapLocalization(rcode, mainLocaleTable.stringTable[0].hash, true);
            const mapHeader = reprocessMapHeader(rawHeaderData, localizationData);

            const defaultVariant = mapHeader.variants[mapHeader.defaultVariantIndex];
            const mainCategory = this.mapCategories.find(x => x.id === defaultVariant.categoryId);
            if (mapHeader.mapSize) {
                if (mainCategory.isMelee) {
                    map.type = S2MapType.MeleeMap;
                }
                else {
                    map.type = S2MapType.ArcadeMap;
                }
            }
            else if (mhead.isExtensionMod) {
                map.type = S2MapType.ExtensionMod;
            }
            else {
                map.type = S2MapType.DependencyMod;
            }
            map.name = mapHeader.workingSet.name ?? '';
            map.description = mapHeader.workingSet.description;
            map.website = mapHeader.arcadeInfo?.website;
            map.mainCategoryId = defaultVariant.categoryId;

            const playableVariants = mapHeader.variants
                .filter(x => x.categoryId !== 17 && x.categoryId !== 19) // not archon
                .filter(x => x.maxHumanPlayers)
            ;
            map.maxPlayers = mapHeader.workingSet.maxPlayers;
            map.maxHumanPlayers = playableVariants.length ?
                playableVariants.map(x => x.maxHumanPlayers).sort()[playableVariants.length - 1] : mapHeader.workingSet.maxPlayers
            ;

            map.iconHash = (
                mapHeader.arcadeInfo?.mapIcon ??
                mapHeader.workingSet.thumbnail ??
                mapHeader.workingSet.bigMap ??
                null
            )?.hash ?? null;
            map.thumbnailHash = (
                mapHeader.workingSet.thumbnail ??
                mapHeader.workingSet.bigMap ??
                null
            )?.hash ?? null;

            map.availableLocales = 0;
            for (const currLocale of rawHeaderData.workingSet.localeTable.map(x => x.locale)) {
                map.availableLocales |= GameLocaleFlag[currLocale];
            }
            map.mainLocale = mainLocaleTable.locale;
            map.mainLocaleHash = mainLocaleTable.stringTable[0].hash;
            map.updatedAt = new Date(mhead.uploadedAt);
            map.currentVersion = mhead;

            // if we get a new version of removed map, it most likely means that it has been restored
            if (!forceUpdate && map.removed) {
                map.removed = false;
            }

            // variants
            if (map.type === S2MapType.ArcadeMap || map.type === S2MapType.MeleeMap) {
                map.variants = [];
                for (const [index, rawVariant] of mapHeader.variants.entries()) {
                    const mVariant = new S2MapVariant();
                    mVariant.map = map;
                    mVariant.name = rawVariant.modeName ?? '';
                    mVariant.variantIndex = index;
                    mVariant.lobbyDelay = 10;
                    const dvalue = rawVariant.attributeDefaults.find(x => {
                        return x.attribute.namespace === AttributeSystemNamespaceId && x.attribute.id === AttributeId.LobbyDelay;
                    });
                    if (dvalue) {
                        mVariant.lobbyDelay = Number(lobbyDelayValues[(dvalue.value as AttributeValue).index]);
                    }
                    map.variants.push(mVariant);
                }
            }

            this.updateMapDependency(map, mhead, rawHeaderData);

            dUpdated = true;
        }

        if (
            (isLatestUpdate || forceUpdate) &&
            (await this.updateMapLocale(map, mhead, rawHeaderData, forceUpdate))
        ) {
            dUpdated = true;
        }

        return dUpdated;
    }

    @retry({
        onFailedAttempt: async (err) => {
            if (!(err instanceof orm.QueryFailedError)) throw err;
            if ((<any>err).code === 'ER_LOCK_DEADLOCK') {
                logger.verbose(`saveMap: got ${(<any>err).code}, retrying..`);
                await sleep(100);
            }
            else {
                throw err;
            }
        },
    })
    async saveMap(map: S2Map, dateQuery?: Date) {
        if (map.author && (!map.author.lastOnlineAt || map.updatedAt > map.author.lastOnlineAt)) {
            map.author.lastOnlineAt = map.updatedAt;
            await this.conn.getRepository(S2Profile).update(map.author.id, {
                lastOnlineAt: map.author.lastOnlineAt,
            });
        }

        await this.conn.transaction(async tsManager => {
            if (tsManager.getRepository(S2Map).hasId(map)) {
                await tsManager.getRepository(S2MapVariant).delete({
                    mapId: map.id,
                });
            }
            await tsManager.getRepository(S2Map).save(map, { transaction: false });
            if (map.variants) {
                await tsManager.getRepository(S2MapVariant).insert(map.variants);
            }

            const removedDepIndex = map.dependencies.findIndex(x => x.dependencyMapId === 0);
            if (removedDepIndex !== -1) {
                map.dependencies.splice(removedDepIndex);
                await tsManager.getRepository(S2MapDependency).createQueryBuilder()
                    .delete()
                    .andWhere('regionId = :regionId AND mapId = :mapId AND dependencyIndex >= :depIndex', {
                        regionId: map.regionId,
                        mapId: map.bnetId,
                        depIndex: removedDepIndex,
                    })
                    .execute()
                ;
            }
            if (map.dependencies.length > 0) {
                await tsManager.getRepository(S2MapDependency).save(map.dependencies, { transaction: false });
            }

            await tsManager.getRepository(S2MapLocale).save(map.locales, { transaction: false });

            if (dateQuery) {
                const mpTrack = await tsManager.getCustomRepository(S2MapTrackingRepository).fetchOrCreate({
                    regionId: map.regionId,
                    mapId: map.bnetId,
                });
                if (!mpTrack.lastCheckedAt || dateQuery > mpTrack.lastCheckedAt) {
                    await tsManager.getRepository(S2MapTracking).update(
                        tsManager.getRepository(S2MapTracking).getId(mpTrack),
                        {
                            lastCheckedAt: dateQuery,
                            lastSeenAvailableAt: dateQuery,
                            firstSeenUnvailableAt: null,
                            unavailabilityCounter: 0,
                        }
                    );
                }
            }
        });
    }

    @retry({
        retries: 2,
        onFailedAttempt: err => {
            logger.warn(`failed to process map discover`, err);
        },
    })
    protected async processMapDiscover(msg: MessageMapDiscoverResult) {
        const dateQuery = new Date(msg.queriedAt * 1000);
        logger.verbose(`processing map discover ${msg.regionId}/${msg.mapId} author=${msg.author.name}`);

        const initialRevision = await this.prepareMapRevision(msg.regionId, msg.mapId, msg.initialRevision);
        const currentRevision = (
            msg.initialRevision.mapVersion === msg.latestRevision.mapVersion ?
            initialRevision : await this.prepareMapRevision(msg.regionId, msg.mapId, msg.latestRevision)
        );

        let map = await this.conn.getCustomRepository(S2MapRepository).findOneWithMetadata(
            currentRevision.mhead.regionId,
            currentRevision.mhead.bnetId,
        );
        let updatedMap = false;
        let isNewMap = false;

        if (!map) {
            map = new S2Map();
            map.regionId = currentRevision.mhead.regionId;
            map.bnetId = currentRevision.mhead.bnetId;
            map.locales = [];
            map.dependencies = [];
            updatedMap = true;
            isNewMap = true;
        }

        if ((await this.updateMapDataFromHeader(map, initialRevision.mhead, initialRevision.rawHeaderData))) {
            updatedMap = true;
        }

        if (isNewMap) {
            const mHeaders = await this.conn.getRepository(S2MapHeader).createQueryBuilder('mhead')
                .andWhere('mhead.regionId = :regionId AND mhead.bnetId = :bnetId', {
                    regionId: map.regionId,
                    bnetId: map.bnetId,
                })
                .addOrderBy('mhead.majorVersion', 'ASC')
                .addOrderBy('mhead.minorVersion', 'ASC')
                .getMany()
            ;

            for (const mhead of mHeaders) {
                if (mhead.absoluteVersion === map.initialVersion.absoluteVersion) continue;
                if (mhead.absoluteVersion === map.currentVersion.absoluteVersion) continue;

                const rawHeaderData = await this.resolver.getMapHeader(GameRegion[mhead.regionId], mhead.headerHash);
                await this.updateMapLocale(map, mhead, rawHeaderData);
            }
        }

        if ((await this.updateMapDataFromHeader(map, currentRevision.mhead, currentRevision.rawHeaderData))) {
            updatedMap = true;
        }

        if (!map.author) {
            map.author = await ProfileManager.fetchOrCreate(msg.author, this.conn);
            map.authorLocalProfileId = map.author.localProfileId;
            updatedMap = true;
        }

        // update discriminator if applicable
        if (map.author.name === msg.author.name && map.author.discriminator === 0 && msg.author.discriminator !== 0) {
            map.author.name = msg.author.name;
            map.author.discriminator = msg.author.discriminator;
            await this.conn.getCustomRepository(S2ProfileRepository).update(map.author.id, {
                name: msg.author.name,
                discriminator: msg.author.discriminator,
            });
        }

        if (!this.conn.getRepository(S2MapHeader).hasId(map.initialVersion)) {
            await this.conn.getRepository(S2MapHeader).insert(map.initialVersion);
        }
        if (!this.conn.getRepository(S2MapHeader).hasId(map.currentVersion)) {
            await this.conn.getRepository(S2MapHeader).insert(map.currentVersion);
        }

        if (updatedMap) {
            await this.saveMap(map, dateQuery);
        }
    }

    protected async processMapRevision(msg: MessageMapRevisionResult) {
        const mapRevision = await this.prepareMapRevision(msg.regionId, msg.mapId, msg);
        if (this.conn.getRepository(S2MapHeader).hasId(mapRevision.mhead)) {
            logger.debug(`skipping map revision ${msg.regionId}/${msg.mapId},${msg.mapVersion}`);
            return;
        }

        logger.verbose(`processing map revision ${msg.regionId}/${msg.mapId},${msg.mapVersion}`);
        await this.conn.getRepository(S2MapHeader).insert(mapRevision.mhead);

        const map = await this.conn.getCustomRepository(S2MapRepository).findOneWithMetadata(
            mapRevision.mhead.regionId,
            mapRevision.mhead.bnetId,
        );

        const dateQuery = new Date(msg.queriedAt * 1000);
        if (
            map && (
                (await this.updateMapDataFromHeader(map, mapRevision.mhead, mapRevision.rawHeaderData)) ||
                (await this.updateMapLocale(map, mapRevision.mhead, mapRevision.rawHeaderData))
            )
        ) {
            await this.saveMap(map, dateQuery);
        }
        else if (
            !map ||
            (
                map.currentVersion.majorVersion === mapRevision.mhead.majorVersion &&
                map.currentVersion.minorVersion === mapRevision.mhead.minorVersion
            )
        ) {
            const mpTrack = await this.conn.getCustomRepository(S2MapTrackingRepository).fetchOrCreate({
                regionId: mapRevision.mhead.regionId,
                mapId: mapRevision.mhead.bnetId,
            });
            if (!mpTrack.lastCheckedAt || dateQuery > mpTrack.lastCheckedAt || mpTrack.unavailabilityCounter > 0) {
                await this.conn.getCustomRepository(S2MapTrackingRepository).update(
                    this.conn.getCustomRepository(S2MapTrackingRepository).getId(mpTrack),
                    {
                        lastCheckedAt: dateQuery,
                        lastSeenAvailableAt: dateQuery,
                        firstSeenUnvailableAt: null,
                        unavailabilityCounter: 0,
                    }
                );
            }
        }
    }

    async add(msg: MessageMapDiscoverResult | MessageMapRevisionResult) {
        if (this.taskQueue.size > 60 || this.taskQueue.pending > 60) {
            logger.debug(`queue=${this.taskQueue.size} pending=${this.taskQueue.pending}`, this.currentlyProcessing);
        }
        return this.taskQueue.add(async () => {
            const key = `${msg.regionId}/${msg.mapId}`;
            if (this.currentlyProcessing.has(key)) {
                logger.debug(`waiting ${key}.. ${(<MessageMapRevisionResult>msg)?.mapVersion}`);
                while (this.currentlyProcessing.has(key)) {
                    await sleep(100);
                }
                logger.debug(`done waiting ${key}.. ${(<MessageMapRevisionResult>msg)?.mapVersion}`);
            }
            try {
                logger.debug(`begin processing ${key}.. ${(<MessageMapRevisionResult>msg)?.mapVersion}`);
                this.currentlyProcessing.add(key);
                switch (msg.$id) {
                    case MessageKind.MapDiscoverResult: {
                        return await this.processMapDiscover(msg);
                        break;
                    }
                    case MessageKind.MapRevisionResult: {
                        return await this.processMapRevision(msg);
                        break;
                    }
                }
            }
            finally {
                logger.debug(`done processing ${key}.. ${(<MessageMapRevisionResult>msg)?.mapVersion}`);
                this.currentlyProcessing.delete(key);
            }
        }, {
            priority: msg.$id === MessageKind.MapDiscoverResult ? 10 : 5,
        });
    }
}
