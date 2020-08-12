import * as orm from 'typeorm';
import * as fs from 'fs-extra';
import * as fxml from 'fast-xml-parser';
import * as he from 'he';
import { spawn } from 'child_process';
import { S2MapHeader } from '../entity/S2MapHeader';
import { BattleDepot } from '../depot';
import { GameRegion, GameLocale } from '../common';
import { logger, logIt } from '../logger';
import { spawnWaitExit } from '../helpers';
import { S2Map, S2MapType } from '../entity/S2Map';

export type MapTags = 'BLIZ'
    | 'TRIL'
    | 'FEAT'
    | 'PRGN'
    | 'HotS'
    | 'LotV'
    | 'WoL'
    | 'WoLX'
    | 'HoSX'
    | 'LoVX'
    | 'HerX'
    | 'Desc'
    | 'Glue'
    | 'Blnc'
    | 'PREM'
;

export interface MapHeaderData {
    header: MapLink;
    name: string;
    mapFile: DepotFileLink;
    mapNamespace: number;
    mapInfo: MapInfo;
    attributes: any[];
    localeTable: LocaleTable[];
    mapSize: MapSize | null;
    tileset: ExternalString | null;
    defaultVariantIndex: number;
    variants: Variant[];
    dependencies?: MapLink[];
    addDefaultPermissions?: boolean;
    relevantPermissions?: any[];
    specialTags?: MapTags[];
    arcade?: ArcadeInfo | null;
    addMultiMod?: boolean;
}

export interface ArcadeInfo {
    gameInfoScreenshots: Screenshot[];
    howToPlayScreenshots: Screenshot[];
    howToPlaySections: ContentSection[];
    patchNoteSections: ContentSection[];
    mapIcon: MapImage;
    tutorialLink: null;
    matchmakerTags: any[];
    website: ExternalString;
}

export interface Screenshot {
    picture: MapImage;
    caption: ExternalString;
}

export type ExternalString = {
    color: number | null;
    table: number;
    index: number;
} & {[key in GameLocale]?: string};

export interface MapImage {
    index: number;
    top: number;
    left: number;
    width: number;
    height: number;
}

export interface ContentSection {
    title: ExternalString;
    listType: string;
    subtitle: ExternalString;
    items: ExternalString[];
}

export interface MapLink {
    id: number;
    version: number;
}

export interface LocaleTable {
    locale: GameLocale;
    stringTable: DepotFileLink[];
}

export interface DepotFileLink {
    type: string;
    server: string;
    hash: string;
}

export interface MapInfo {
    name: ExternalString;
    description: ExternalString;
    thumbnail: MapImage;
    maxPlayers: number;
    visualFiles: DepotFileLink[];
    localeTable: LocaleTable[];
}

export interface MapSize {
    horizontal: number;
    vertical: number;
}

export interface Variant {
    categoryId: number;
    modeId: number;
    categoryName: ExternalString;
    modeName: ExternalString;
    categoryDescription: ExternalString;
    modeDescription: ExternalString;
    attributeDefaults: AttributeDefault[];
    lockedAttributes: LockedAttribute[];
    maxTeamSize: number;
    attributeVisibility: AttributeVisibility[];
    achievementTags: any[];
    maxHumanPlayers: number;
    maxOpenSlots: number;
    premiumInfo: null;
}

export interface AttributeDefault {
    attribute: Attribute;
    value: number[] | number;
}

export interface Attribute {
    namespace: number;
    id: number;
}

export interface AttributeVisibility {
    attribute: Attribute;
    hidden: number;
}

export interface LockedAttribute {
    attribute: Attribute;
    lockedScopes: number;
}

export interface MapLocalizationTable {
    locale: GameLocale;
    strings: Map<number, string>;
}

export type MapHeaderLocalized = MapHeaderData & {
    // tileset?: string;
    mainLocale: GameLocale;
    resolvedLocales: GameLocale[];
};

type LocalizableFields = {
    [fieldName: string]: true | LocalizableFields,
};

const fieldsToLocalize: LocalizableFields = {
    mapInfo: {
        name: true,
        description: true,
    },
    tileset: true,
};

export function applyMapLocalization(mapHeader: MapHeaderData, mapLocalization: MapLocalizationTable): MapHeaderLocalized {
    function localizeField(field: ExternalString | ExternalString[]): ExternalString | ExternalString[] {
        if (Array.isArray(field)) {
            return field.map(x => localizeField(x)) as ExternalString[];
        }
        field[mapLocalization.locale] = mapLocalization.strings.get(field.index);
        return field as ExternalString;
    }

    function localizeObject(obj: any, fields: LocalizableFields) {
        for (const key in fields) {
            if (typeof fields[key] === 'object') {
                obj[key] = localizeObject(obj[key], fields[key] as LocalizableFields)
            }
            else if (obj[key] !== null) {
                obj[key] = localizeField(obj[key]);
            }
        }
        return obj;
    }

    const r = localizeObject(mapHeader, fieldsToLocalize) as MapHeaderLocalized;
    if (!r.mainLocale) {
        r.mainLocale = mapLocalization.locale;
        r.resolvedLocales = [];
    }
    r.resolvedLocales.push(mapLocalization.locale);

    return r;
}

export class MapResolver {
    protected depot = new BattleDepot('data/depot');

    constructor(protected conn: orm.Connection) {
    }

    async getMapLocalization(region: string, hash: string, persist = true): Promise<MapLocalizationTable> {
        const fPath = await this.depot.getPathOrRetrieve(region, `${hash}.s2ml`);
        const data = fxml.parse(await fs.readFile(fPath, { encoding: 'utf8' }), {
            ignoreAttributes: false,
            attributeNamePrefix: '',
            parseNodeValue: true,
            textNodeName: 'text',
            parseTrueNumberOnly: true,
            attrValueProcessor: (val, attrName) => he.decode(val, { isAttributeValue: true }),
            tagValueProcessor : (val, tagName) => he.decode(val),
        });
        if (!persist) {
            await fs.unlink(fPath);
        }
        const stringMap = new Map<number, string>(data.Locale.e.map((x: { id: string, text: string }) => [Number(x.id), x.text ?? '']));
        return {
            locale: data.Locale.region,
            strings: stringMap,
        };
    }

    async getMapHeader(region: string, hash: string, persist = true) {
        const fPath = await this.depot.getPathOrRetrieve(region, `${hash}.s2mh`);
        const decodingProc = await spawnWaitExit(spawn('s2mdecoder', [
            fPath,
        ]), {
            captureStdout: true,
            captureStderr: true,
        });
        if (decodingProc.rcode !== 0) {
            logger.error('s2mdecoder stdout', decodingProc.stdout);
            logger.error('s2mdecoder stderr', decodingProc.stderr);
            throw new Error(`s2mdecoder failed on "${fPath}" code=${decodingProc.rcode} signal=${decodingProc.signal} killed=${decodingProc.proc.killed}`);
        }
        if (!persist) {
            await fs.unlink(fPath);
        }
        return JSON.parse(decodingProc.stdout) as MapHeaderData;
    }

    async initializeMapHeader(mhead: S2MapHeader) {
        logger.verbose(`resolving.. map=${mhead.regionId}/${mhead.bnetId} v${mhead.majorVersion}.${mhead.minorVersion} hash=${mhead.headerHash}`);
        const rcode = GameRegion[mhead.regionId];

        const headerData = await this.getMapHeader(rcode, mhead.headerHash);

        if (!mhead.uploadedAt) {
            const s2mhResponse = await this.depot.retrieveHead(rcode, `${mhead.headerHash}.s2mh`);
            mhead.uploadedAt = new Date(s2mhResponse.headers['last-modified']);
        }
        if (!mhead.archiveSize) {
            const s2maResponse = await this.depot.retrieveHead(rcode, `${headerData.mapFile.hash}.${headerData.mapFile.type}`);
            mhead.archiveSize = Number(s2maResponse.headers['content-length']);
        }
        mhead.archiveHash = headerData.mapFile.hash;

        const thumbnail = headerData.mapInfo.visualFiles[headerData.mapInfo.thumbnail.index];
        const mainLocaleTable = headerData.mapInfo.localeTable.find(x => x.locale === GameLocale.enUS) ?? headerData.mapInfo.localeTable[0];
        const localizationData = await this.getMapLocalization(rcode, mainLocaleTable.stringTable[0].hash, true);
        const mapLocalized = applyMapLocalization(headerData, localizationData);

        let map = await this.conn.getRepository(S2Map).findOne({
            relations: ['currentVersion'],
            where: { regionId: mhead.regionId, bnetId: mhead.bnetId },
        });
        if (!map) {
            map = new S2Map();
            map.regionId = mhead.regionId;
            map.bnetId = mhead.bnetId;
        }

        let updatedMap = false;
        if (!map.currentVersion || (mhead.majorVersion >= map.currentVersion.majorVersion && mhead.minorVersion >= map.currentVersion.minorVersion)) {
            if (mapLocalized.mapSize) {
                map.type = S2MapType.Map;
            }
            else if (mhead.isExtensionMod) {
                map.type = S2MapType.ExtensionMod;
            }
            else {
                map.type = S2MapType.DependencyMod;
            }
            map.name = mapLocalized.mapInfo.name[mainLocaleTable.locale];
            map.description = mapLocalized.mapInfo.description[mainLocaleTable.locale];
            map.mainCategoryId = mapLocalized.variants[mapLocalized.defaultVariantIndex].categoryId;
            map.iconHash = thumbnail?.hash ?? null;
            map.mainLocale = mainLocaleTable.locale;
            map.mainLocaleHash = mainLocaleTable.stringTable[0].hash;
            map.currentVersion = mhead;
            updatedMap = true;
        }
        await this.conn.transaction(async em => {
            await em.getRepository(S2MapHeader).save(mhead, { transaction: false });
            if (updatedMap) {
                await em.getRepository(S2Map).save(map, { transaction: false });
            }
        });

        logger.info(`resolved map=${mhead.regionId}/${mhead.bnetId} v${mhead.majorVersion}.${mhead.minorVersion} name=${headerData.name} updated=${updatedMap} uploadTime=${mhead.uploadedAt.toUTCString()}`);
    }
}
