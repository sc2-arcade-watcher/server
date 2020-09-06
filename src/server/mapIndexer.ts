import * as orm from 'typeorm';
import PQueue from 'p-queue';
import { logger } from '../logger';
import { retry, throwErrIfNotDuplicateEntry } from '../helpers';
import { S2MapHeader } from '../entity/S2MapHeader';
import { MapResolver, reprocessMapHeader, MapHeaderDataRaw } from '../task/mapResolver';
import { MessageKind, MessageMapRevisionResult, MessageMapDiscoverResult, MapVersionInfo } from './executiveServer';
import { decodeMapVersion, GameRegion, GameLocale } from '../common';
import { S2Map, S2MapType } from '../entity/S2Map';
import { S2MapCategory } from '../entity/S2MapCategory';
import { S2Profile } from '../entity/S2Profile';
import { S2MapTracking } from '../entity/S2MapTracking';

export class MapIndexer {
    public readonly resolver = new MapResolver(this.conn);
    protected taskQueue = new PQueue({
        concurrency: Number(process.env.STARC_DHOST_MR_QUEUE_LIMIT) || 8,
    });
    protected mapCategories: S2MapCategory[];

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
        logger.verbose(`resolving header.. map=${mhead.regionId}/${mhead.bnetId} v${mhead.majorVersion}.${mhead.minorVersion} hash=${mhead.headerHash}`);
        const rcode = GameRegion[mhead.regionId];

        const headerRawData = await this.resolver.getMapHeader(rcode, mhead.headerHash);

        if (!mhead.uploadedAt) {
            const s2mhResponse = await this.resolver.depot.retrieveHead(rcode, `${mhead.headerHash}.s2mh`);
            mhead.uploadedAt = new Date(s2mhResponse.headers['last-modified']);
        }
        if (!mhead.archiveSize) {
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
            logger.verbose(`processed header map=${mhead.regionId}/${mhead.bnetId} v${mhead.majorVersion}.${mhead.minorVersion} name=${rawHeaderData.filename} uploadTime=${mhead.uploadedAt.toUTCString()}`);

            return {
                mhead,
                rawHeaderData,
            };
        }

        return {
            mhead,
        };
    }

    async updateMapDataFromHeader(map: S2Map, mhead: S2MapHeader, rawHeaderData?: MapHeaderDataRaw) {
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

        if (
            !map.currentVersion ||
            (mhead.majorVersion > map.currentVersion.majorVersion) ||
            (mhead.majorVersion === map.currentVersion.majorVersion && mhead.minorVersion >= map.currentVersion.minorVersion)
        ) {
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
        }
    }

    protected async processMapDiscover(msg: MessageMapDiscoverResult) {
        const dateQuery = new Date(msg.queriedAt * 1000);
        logger.verbose(`processing map discover ${msg.regionId}/${msg.mapId} author=${msg.author.name}`);

        const initialRevision = await this.prepareMapRevision(msg.regionId, msg.mapId, msg.initialRevision);
        const currentRevision = (
            msg.initialRevision.mapVersion === msg.latestRevision.mapVersion ?
            initialRevision : await this.prepareMapRevision(msg.regionId, msg.mapId, msg.initialRevision)
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

        let mtrack = await this.conn.getRepository(S2MapTracking).findOne({
            where: {
                regionId: currentRevision.mhead.regionId,
                bnetId: currentRevision.mhead.bnetId,
            },
        });
        if (!mtrack) {
            mtrack = new S2MapTracking();
            mtrack.regionId = currentRevision.mhead.regionId;
            mtrack.bnetId = currentRevision.mhead.bnetId;
            mtrack.lastCheckedAt = dateQuery;
            mtrack.lastSeenAvailableAt = dateQuery;
        }

        if (
            !map.currentVersion ||
            (currentRevision.mhead.majorVersion > map.currentVersion.majorVersion) ||
            (
                currentRevision.mhead.majorVersion === map.currentVersion.majorVersion &&
                currentRevision.mhead.minorVersion >= map.currentVersion.minorVersion
            )
        ) {
            await this.updateMapDataFromHeader(map, currentRevision.mhead, currentRevision.rawHeaderData);
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
                    authorProfile.deleted = true;
                }
                else {
                    authorProfile.name = msg.author.name;
                    authorProfile.discriminator = msg.author.discriminator;
                }
                authorProfile.updatedAt = dateQuery;
            }
            map.author = authorProfile;
            updatedMap = true;
        }

        try {
            await this.conn.transaction(async em => {
                if (!em.getRepository(S2MapHeader).hasId(initialRevision.mhead)) {
                    await em.getRepository(S2MapHeader).insert(initialRevision.mhead);
                }
                if (!em.getRepository(S2MapHeader).hasId(currentRevision.mhead)) {
                    await em.getRepository(S2MapHeader).insert(currentRevision.mhead);
                }
                if (!em.getRepository(S2Profile).hasId(map.author)) {
                    await em.getRepository(S2Profile).insert(map.author);
                }
                if (updatedMap) {
                    await em.getRepository(S2Map).save(map, { transaction: false });
                    if (!em.getRepository(S2MapTracking).hasId(mtrack)) {
                        await em.getRepository(S2MapTracking).insert(mtrack);
                    }
                }
            });
        }
        catch (err) {
            throwErrIfNotDuplicateEntry(err);
        }
    }

    protected async processMapRevision(msg: MessageMapRevisionResult) {
        const mapRevision = await this.prepareMapRevision(msg.regionId, msg.mapId, msg);
        if (!this.conn.getRepository(S2MapHeader).hasId(mapRevision.mhead)) {
            try {
                await this.conn.getRepository(S2MapHeader).insert(mapRevision.mhead);
            }
            catch (err) {
                throwErrIfNotDuplicateEntry(err);
            }
        }

        const map = await this.conn.getRepository(S2Map).findOne({
            relations: [
                'currentVersion',
            ],
            where: {
                regionId: mapRevision.mhead.regionId,
                bnetId: mapRevision.mhead.bnetId,
            },
        });
        if (!map) return;

        if (
            !map.currentVersion ||
            (mapRevision.mhead.majorVersion > map.currentVersion.majorVersion) ||
            (
                mapRevision.mhead.majorVersion === map.currentVersion.majorVersion &&
                mapRevision.mhead.minorVersion >= map.currentVersion.minorVersion
            )
        ) {
            await this.updateMapDataFromHeader(map, mapRevision.mhead, mapRevision.rawHeaderData);
            await this.conn.getRepository(S2Map).save(map, { transaction: false });

            const mtrack = await this.conn.getRepository(S2MapTracking).findOne({
                where: {
                    regionId: mapRevision.mhead.regionId,
                    bnetId: mapRevision.mhead.bnetId,
                },
            });
            const checkedAt = new Date(msg.queriedAt * 1000);
            if (mtrack && (checkedAt > mtrack.lastCheckedAt || mtrack.unavailabilityCounter > 0)) {
                this.conn.getRepository(S2MapTracking).update(mtrack.id, {
                    lastCheckedAt: checkedAt,
                    lastSeenAvailableAt: checkedAt,
                    firstSeenUnvailableAt: null,
                    unavailabilityCounter: 0,
                });
            }
        }
    }

    async add(msg: MessageMapDiscoverResult | MessageMapRevisionResult) {
        return this.taskQueue.add(async () => {
            switch (msg.$id) {
                case MessageKind.MapDiscoverResult: {
                    return this.processMapDiscover(msg);
                    break;
                }
                case MessageKind.MapRevisionResult: {
                    return this.processMapRevision(msg);
                    break;
                }
            }
        });
    }
}
