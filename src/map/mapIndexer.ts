import * as orm from 'typeorm';
import PQueue from 'p-queue';
import { logger } from '../logger';
import { retry, sleep, isAxiosError } from '../helpers';
import { S2MapHeader } from '../entity/S2MapHeader';
import { MapResolver, reprocessMapHeader, MapHeaderDataRaw, AttributeValue } from './mapResolver';
import { MessageKind, MessageMapRevisionResult, MessageMapDiscoverResult, MapVersionInfo } from '../server/executiveServer';
import { decodeMapVersion, GameRegion, GameLocale } from '../common';
import { S2Map, S2MapType } from '../entity/S2Map';
import { S2MapCategory } from '../entity/S2MapCategory';
import { S2Profile } from '../entity/S2Profile';
import { S2MapTracking } from '../entity/S2MapTracking';
import { S2MapVariant } from '../entity/S2MapVariant';
import { AttributeSystemNamespaceId, AttributeId, lobbyDelayValues } from './attributes';

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
    protected async populateMapHeader(mhead: S2MapHeader) {
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
                    // http://us.depot.battle.net:1119/02374236dc17df4e4e0ee7dd85662c2dca06a666795cec665ef37fad9187d593.s2ma
                    mhead.archiveSize = null;
                }
            }
            catch (err) {
                // CN depot, specificaly, might repeatedly return 503 for non cached s2ma and possibly other files (?)
                // just give up in that case - it probably affects only old revisions of s2ma's
                // example: http://cn.depot.battlenet.com.cn:1119/54c06a38ab2eb96811742cd0bf4107d9be7b58019ca21b73936338b4df378a7e.s2ma
                if (isAxiosError(err) && err.response?.status === 503) {
                    mhead.archiveSize = null;
                    logger.verbose(`failed to obtain archiveSize of ${mhead.linkVer} due to 503`);
                }
                else {
                    throw err;
                }
            }
        }
        mhead.archiveHash = headerRawData.archiveHandle.hash;

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

    async updateMapDataFromHeader(map: S2Map, mhead: S2MapHeader, rawHeaderData?: MapHeaderDataRaw, forceUpdate = false) {
        if (
            !map.currentVersion ||
            (mhead.majorVersion > map.currentVersion.majorVersion) ||
            (mhead.majorVersion === map.currentVersion.majorVersion && mhead.minorVersion > map.currentVersion.minorVersion) ||
            forceUpdate
        ) {
            const rcode = GameRegion[mhead.regionId];
            if (!rawHeaderData) {
                rawHeaderData = await this.resolver.getMapHeader(rcode, mhead.headerHash);
            }
            const mainLocaleTable = rawHeaderData.workingSet.localeTable.find(x => x.locale === GameLocale.enUS)
                ?? rawHeaderData.workingSet.localeTable[0]
            ;
            const localizationData = await this.resolver.getMapLocalization(rcode, mainLocaleTable.stringTable[0].hash, true);
            const mapHeader = reprocessMapHeader(rawHeaderData, localizationData);
            const mapIcon = (
                mapHeader.arcadeInfo?.mapIcon ??
                mapHeader.workingSet.thumbnail ??
                mapHeader.workingSet.bigMap ??
                null
            );

            const mainCategory = this.mapCategories.find(x => x.id === mapHeader.variants[mapHeader.defaultVariantIndex].categoryId);
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
            map.name = mapHeader.workingSet.name;
            map.description = mapHeader.workingSet.description;
            map.website = mapHeader.arcadeInfo?.website;
            map.mainCategoryId = mainCategory.id;
            map.maxPlayers = mapHeader.workingSet.maxPlayers;
            map.iconHash = mapIcon?.hash ?? null;
            map.mainLocale = mainLocaleTable.locale;
            map.mainLocaleHash = mainLocaleTable.stringTable[0].hash;
            map.updatedAt = mhead.uploadedAt;
            map.currentVersion = mhead;

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

            return true;
        }

        return false;
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

            if (map.author && (map.author.lastOnlineAt === null || map.updatedAt > map.author.lastOnlineAt)) {
                map.author.lastOnlineAt = map.updatedAt;
                await tsManager.getRepository(S2Profile).update(map.author.id, {
                    lastOnlineAt: map.author.lastOnlineAt,
                });
            }

            if (dateQuery) {
                let mtrack = await tsManager.getRepository(S2MapTracking).findOne({
                    where: {
                        regionId: map.regionId,
                        bnetId: map.bnetId,
                    },
                });
                if (!mtrack) {
                    mtrack = new S2MapTracking();
                    mtrack.regionId = map.regionId;
                    mtrack.bnetId = map.bnetId;
                    mtrack.lastCheckedAt = dateQuery;
                    mtrack.lastSeenAvailableAt = dateQuery;
                }
                else if (dateQuery > mtrack.lastCheckedAt) {
                    mtrack.lastCheckedAt = dateQuery;
                    mtrack.lastSeenAvailableAt = dateQuery;
                    mtrack.firstSeenUnvailableAt = null;
                    mtrack.unavailabilityCounter = 0;
                }

                await tsManager.getRepository(S2MapTracking).save(mtrack, { transaction: false });
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

        let map = await this.conn.getRepository(S2Map).findOne({
            relations: [
                'currentVersion',
                'initialVersion',
                'author',
            ],
            where: {
                regionId: currentRevision.mhead.regionId,
                bnetId: currentRevision.mhead.bnetId,
            },
        });
        let updatedMap = false;

        if (!map) {
            map = new S2Map();
            map.regionId = currentRevision.mhead.regionId;
            map.bnetId = currentRevision.mhead.bnetId;
            updatedMap = true;
        }

        if ((await this.updateMapDataFromHeader(map, currentRevision.mhead, currentRevision.rawHeaderData))) {
            updatedMap = true;
        }

        if (!map.initialVersion) {
            map.initialVersion = initialRevision.mhead;
            map.publishedAt = initialRevision.mhead.uploadedAt;
            updatedMap = true;
        }

        if (!map.author) {
            let authorProfile = await this.conn.getRepository(S2Profile).findOne({
                where: {
                    regionId: msg.author.regionId,
                    realmId: msg.author.realmId,
                    profileId: msg.author.profileId,
                },
            });
            if (!authorProfile) {
                authorProfile = new S2Profile();
                authorProfile.regionId = msg.author.regionId;
                authorProfile.realmId = msg.author.realmId;
                authorProfile.profileId = msg.author.profileId;
                if (msg.author.discriminator === 0) {
                    authorProfile.name = null;
                    authorProfile.discriminator = 0;
                    authorProfile.deleted = true;
                }
                else {
                    authorProfile.name = msg.author.name;
                    authorProfile.discriminator = msg.author.discriminator;
                    authorProfile.nameUpdatedAt = dateQuery;
                }
            }
            map.author = authorProfile;
            updatedMap = true;
        }

        if (!this.conn.getRepository(S2MapHeader).hasId(initialRevision.mhead)) {
            await this.conn.getRepository(S2MapHeader).insert(initialRevision.mhead);
        }
        if (!this.conn.getRepository(S2MapHeader).hasId(currentRevision.mhead)) {
            await this.conn.getRepository(S2MapHeader).insert(currentRevision.mhead);
        }
        if (!this.conn.getRepository(S2Profile).hasId(map.author)) {
            await this.conn.getRepository(S2Profile).insert(map.author);
        }

        if (updatedMap) {
            await this.saveMap(map, dateQuery);
        }
    }

    protected async processMapRevision(msg: MessageMapRevisionResult) {
        const mapRevision = await this.prepareMapRevision(msg.regionId, msg.mapId, msg);
        if (this.conn.getRepository(S2MapHeader).hasId(mapRevision.mhead)) {
            logger.debug(`skpping map revision ${msg.regionId}/${msg.mapId},${msg.mapVersion}`);
            return;
        }

        logger.verbose(`processing map revision ${msg.regionId}/${msg.mapId},${msg.mapVersion}`);
        await this.conn.getRepository(S2MapHeader).insert(mapRevision.mhead);

        const map = await this.conn.getRepository(S2Map).findOne({
            relations: [
                'currentVersion',
            ],
            where: {
                regionId: mapRevision.mhead.regionId,
                bnetId: mapRevision.mhead.bnetId,
            },
        });

        const dateQuery = new Date(msg.queriedAt * 1000);
        if (map && (await this.updateMapDataFromHeader(map, mapRevision.mhead, mapRevision.rawHeaderData))) {
            await this.saveMap(map, dateQuery);
        }
        else if (
            !map ||
            (
                map.currentVersion.majorVersion === mapRevision.mhead.majorVersion &&
                map.currentVersion.minorVersion === mapRevision.mhead.minorVersion
            )
        ) {
            const mtrack = await this.conn.getRepository(S2MapTracking).findOne({
                where: {
                    regionId: mapRevision.mhead.regionId,
                    bnetId: mapRevision.mhead.bnetId,
                },
            });
            if (mtrack && (dateQuery > mtrack.lastCheckedAt || mtrack.unavailabilityCounter > 0)) {
                await this.conn.getRepository(S2MapTracking).update(mtrack.id, {
                    lastCheckedAt: dateQuery,
                    lastSeenAvailableAt: dateQuery,
                    firstSeenUnvailableAt: null,
                    unavailabilityCounter: 0,
                });
            }
        }
    }

    async add(msg: MessageMapDiscoverResult | MessageMapRevisionResult) {
        return this.taskQueue.add(async () => {
            const key = `${msg.regionId}/${msg.mapId}`;
            if (this.currentlyProcessing.has(key)) {
                logger.debug(`waiting for ${key}..`);
                while (this.currentlyProcessing.has(key)) {
                    await sleep(100);
                }
            }
            try {
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
                this.currentlyProcessing.delete(key);
            }
        }, {
            priority: msg.$id === MessageKind.MapDiscoverResult ? 10 : 5,
        });
        if (this.taskQueue.size > 100) {
            logger.debug(`queue=${this.taskQueue.size} pending=${this.taskQueue.pending}`);
        }
    }
}
