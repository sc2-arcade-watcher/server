import * as orm from 'typeorm';
import * as fs from 'fs-extra';
import * as fxml from 'fast-xml-parser';
import * as he from 'he';
import { spawn } from 'child_process';
import { S2MapHeader } from '../entity/S2MapHeader';
import { BattleDepot } from '../depot';
import { GameRegion, GameLocale, DepotRegion, decodeMapVersion } from '../common';
import { logger } from '../logger';
import { spawnWaitExit, deepCopy } from '../helpers';
import { S2Map } from '../entity/S2Map';

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

export type ExternalString = {
    color: number | null;
    table: number;
    index: number;
};

export interface MapRawImage {
    index: number;
    top: number;
    left: number;
    width: number;
    height: number;
}

export interface MapScreenshot<ET, MI> {
    picture: MI;
    caption: ET;
}

export enum ContentListTypeKind {
    Bulleted = 0,
    Numbered = 1,
    None     = 2,
}

export interface ContentSection<ET = ExternalString> {
    title: ET;
    listType: ContentListTypeKind;
    subtitle: ET | null;
    items: ET[];
}

export interface DocumentInstance {
    id: number;
    version: number;
}

export interface DepotFileHandle {
    type: string;
    region: DepotRegion;
    hash: string;
}

export interface LocaleTable<DF> {
    locale: GameLocale;
    stringTable: DF[];
}

export interface MapSize {
    horizontal: number;
    vertical: number;
}

export interface PremiumInfo {
    license: number;
}

export interface AttributeInstance {
    namespace: number;
    id: number;
}

export interface AttributeValue {
    index: number;
}

export interface AttributeDefault {
    attribute: AttributeInstance;
    value: AttributeValue | AttributeValue[];
}

export interface AttributeLocked {
    attribute: AttributeInstance;
    lockedScopes: number;
}

export interface AttributeVisibility {
    attribute: AttributeInstance;
    hidden: number;
}

export interface AttributeVisual<ET, MI> {
    text: ET | null;
    tip: ET | null;
    art: MI | null;
}

export interface AttributeValueDefinition<ET, MI> {
    value: string;
    visual: AttributeVisual<ET, MI>;
}

export enum AttributeArbitrationKind {
    Always = 0,
    FCFS   = 1,
}

export enum AttributeRestrictionKind {
    None   = 0,
    Self   = 1,
    Host   = 2,
    All    = 3,
}

export enum AttributeOptionsFlag {
    Unknown          = 0x01,
    LockedWhenPublic = 0x02,
    Hidden           = 0x04,
}

export interface AttributeDefinition<ET, MI> {
    instance: AttributeInstance;
    values: AttributeValueDefinition<ET, MI>[];
    // TODO: requirements
    arbitration: AttributeArbitrationKind;
    visibility: AttributeRestrictionKind;
    access: AttributeRestrictionKind;
    options: AttributeOptionsFlag;
    default: AttributeValue | AttributeValue[];
    sortOrder: number;
}

export interface Variant<ET> {
    categoryId: number;
    modeId: number;
    categoryName: ET;
    modeName: ET;
    categoryDescription: ET;
    modeDescription: ET;
    attributeDefaults: AttributeDefault[];
    lockedAttributes: AttributeLocked[];
    maxTeamSize: number;
    attributeVisibility?: AttributeVisibility[];
    achievementTags?: string[];
    maxHumanPlayers?: number | null;
    maxOpenSlots?: number | null;
    premiumInfo?: PremiumInfo | null;
    teamNames?: ET[];
}

export interface WorkingSet<ET, MI, DF> {
    name: ET;
    description: ET;
    thumbnail: MI | null;
    bigMap: MI | null;
    maxPlayers: number;
    instances: AttributeDefault[];
    visualFiles: DF[];
    localeTable: LocaleTable<DF>[];
}

export interface PermissionEntry {
    name: string;
    id: number;
}

export interface TutorialLink {
    variantIndex: number;
    speed: string;
    map: DocumentInstance;
}

export interface ArcadeInfo<ET, MI> {
    gameInfoScreenshots: MapScreenshot<ET, MI>[];
    howToPlayScreenshots: MapScreenshot<ET, MI>[];
    howToPlaySections: ContentSection<ET>[];
    patchNoteSections: ContentSection<ET>[];
    mapIcon: MI | null;
    tutorialLink: TutorialLink | null;
    matchmakerTags: string[];
    website: ET | null;
}

export interface MapHeaderDataRaw<ET = ExternalString, MI = MapRawImage, DF = DepotFileHandle> {
    header: DocumentInstance;
    filename: string;
    archiveHandle: DF;
    mapNamespace: number;
    workingSet: WorkingSet<ET, MI, DF>;
    attributes: AttributeDefinition<ET, MI>[];
    localeTable: LocaleTable<DF>[];
    mapSize: MapSize | null;
    tileset: ET | null;
    defaultVariantIndex: number;
    variants: Variant<ET>[];
    extraDependencies?: DocumentInstance[];
    addDefaultPermissions?: boolean;
    relevantPermissions?: PermissionEntry[];
    specialTags: MapTags[];
    arcadeInfo?: ArcadeInfo<ET, MI> | null;
    addMultiMod?: boolean;
}

// ===
// ===
// ===

export interface MapImage {
    hash: string;
    top: number;
    left: number;
    width: number;
    height: number;
}

export interface MapLocalizationTable {
    locale: GameLocale;
    strings: Map<number, string>;
}

export type MapHeader = MapHeaderDataRaw<string | null, MapImage, string> & {
    meta: {
        region: DepotRegion;
        locale: GameLocale;
    };
};

// ===
// ===
// ===

type FieldTransformFn<T = any> = (obj: T, mapHeader: MapHeaderDataRaw, mapLocalization: MapLocalizationTable) => any;

type TransformableSectionRules = {
    [fieldName: string]: FieldTransformFn | TransformableSectionRules,
};

function localizeField(obj: ExternalString, mapHeader: MapHeaderDataRaw, mapLocalization: MapLocalizationTable) {
    return mapLocalization.strings.get(obj.index) ?? null;
}

const reHtmlBr = /<br>/g;
function localizeMultilineField(obj: ExternalString, mapHeader: MapHeaderDataRaw, mapLocalization: MapLocalizationTable) {
    let s = localizeField(obj, mapHeader, mapLocalization);
    if (typeof s === 'string') {
        s = s.replace(reHtmlBr, '\n');
    }
    return s;
}

function extractDepotHandle(obj: DepotFileHandle, mapHeader: MapHeaderDataRaw, mapLocalization: MapLocalizationTable) {
    return obj.hash;
}

function extractPicture(obj: MapRawImage, mapHeader: MapHeaderDataRaw, mapLocalization: MapLocalizationTable): MapImage {
    if (!obj) return null;
    const visualFile = mapHeader.workingSet.visualFiles[obj.index];
    if (!visualFile) return null;
    return {
        hash: visualFile.hash,
        top: obj.top,
        left: obj.left,
        width: obj.width,
        height: obj.height,
    };
}

const fieldsToTransform: TransformableSectionRules = {
    archiveHandle: extractDepotHandle,
    workingSet: {
        name: localizeField,
        description: localizeMultilineField,
        thumbnail: extractPicture,
        bigMap: extractPicture,
        visualFiles: null,
        localeTable: null,
    },
    attributes: {
        values: {
            visual: {
                text: localizeField,
                tip: localizeField,
                art: extractPicture,
            },
        },
        visual: {
            text: localizeField,
            tip: localizeField,
            art: extractPicture,
        },
    },
    localeTable: {
        stringTable: extractDepotHandle,
    },
    tileset: localizeField,
    variants: {
        categoryName: localizeField,
        modeName: localizeField,
        categoryDescription: localizeField,
        modeDescription: localizeField,
    },
    arcadeInfo: {
        gameInfoScreenshots: {
            caption: localizeField,
            picture: extractPicture,
        },
        howToPlayScreenshots: {
            caption: localizeField,
            picture: extractPicture,
        },
        howToPlaySections: {
            title: localizeField,
            subtitle: localizeField,
            items: localizeMultilineField,
        },
        patchNoteSections: {
            title: localizeField,
            subtitle: localizeField,
            items: localizeField,
        },
        mapIcon: extractPicture,
        website: localizeField,
    },
};

export function reprocessMapHeader(mapHeader: MapHeaderDataRaw, mapLocalization: MapLocalizationTable): MapHeader {
    function transformSection(obj: any, transformInstructions: TransformableSectionRules | FieldTransformFn) {
        if (typeof transformInstructions === 'function') {
            return transformInstructions(obj, mapHeader, mapLocalization);
        }

        for (const key in transformInstructions) {
            if (transformInstructions[key] === null) {
                delete obj[key];
                continue;
            }
            if (typeof obj[key] === 'undefined' || obj[key] === null) {
                continue;
            }

            if (Array.isArray(obj[key])) {
                obj[key] = obj[key].map((x: any) => transformSection(x, transformInstructions[key]));
            }
            else if (typeof transformInstructions[key] === 'object') {
                obj[key] = transformSection(obj[key], transformInstructions[key]);
            }
            else if (obj[key] !== null) {
                obj[key] = transformSection(obj[key], transformInstructions[key]);
            }
        }

        return obj;
    }

    let result: MapHeader = Object.assign({
        meta: {
            region: mapHeader.archiveHandle.region,
            locale: mapLocalization.locale,
        },
    } as MapHeader, deepCopy(mapHeader));
    transformSection(result, fieldsToTransform) as MapHeader;

    return result;
}

export interface MapDependencyEntry {
    map: S2Map;
    mapHeader: S2MapHeader;
    rawData: MapHeaderDataRaw;
    requestedVersion: number;
}

export class MapDependencyError extends Error {
}

export class MapResolver {
    public readonly depot = new BattleDepot('data/depot');

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
        const stringMap = new Map<number, string>(data.Locale.e.map((x: { id: string, text: string }) => [Number(x.id), x.text ? String(x.text) : '']));
        return {
            locale: data.Locale.region,
            strings: stringMap,
        };
    }

    async getMapHeader(region: string, hash: string, persist = true) {
        const fPath = await this.depot.getPathOrRetrieve(region, `${hash}.s2mh`);
        const decodingProc = await spawnWaitExit(spawn(process.env.STARC_S2MDEC_PATH ?? 's2mdec', [
            '-c',
            fPath,
        ]), {
            captureStdout: true,
            captureStderr: true,
        });
        if (decodingProc.rcode !== 0) {
            logger.error('s2mdec stdout', decodingProc.stdout);
            logger.error('s2mdec stderr', decodingProc.stderr);
            throw new Error(`s2mdec failed on "${fPath}" code=${decodingProc.rcode} signal=${decodingProc.signal} killed=${decodingProc.proc.killed}`);
        }
        if (!persist) {
            await fs.unlink(fPath);
        }
        return JSON.parse(decodingProc.stdout) as MapHeaderDataRaw;
    }

    async resolveMapDependencies(regionId: number, bnetId: number, version: number = 0) {
        const rcode = GameRegion[regionId];
        const deps = new Map<string, MapDependencyEntry>();

        const fetchMapDependencies = (async function(this: MapResolver, regionId: number, bnetId: number, version: number = 0) {
            let map: S2Map;
            let mhead: S2MapHeader;
            if (version === 0) {
                const result = await this.conn.getRepository(S2Map)
                    .createQueryBuilder('map')
                    .innerJoinAndSelect('map.currentVersion', 'mapHead')
                    .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId', {
                        regionId: regionId,
                        bnetId: bnetId,
                    })
                    .getOne()
                ;
                if (result) {
                    map = result;
                    mhead = map.currentVersion;
                    delete map.currentVersion;
                }
            }
            else {
                const [ majorVersion, minorVersion ] = decodeMapVersion(version);
                const result = await this.conn.getRepository(S2MapHeader)
                    .createQueryBuilder('mapHead')
                    .innerJoinAndMapOne('mapHead.map', S2Map, 'map', 'map.regionId = :regionId AND map.bnetId = :bnetId')
                    .andWhere('mapHead.regionId = :regionId AND mapHead.bnetId = :bnetId AND mapHead.majorVersion = :majorVersion AND mapHead.minorVersion = :minorVersion', {
                        regionId: regionId,
                        bnetId: bnetId,
                        majorVersion: majorVersion,
                        minorVersion: minorVersion,
                    })
                    .getOne()
                ;
                if (result) {
                    mhead = result;
                    map = mhead.map;
                    delete mhead.map;
                }
            }

            if (!map || !mhead) {
                throw new MapDependencyError(`Failed to obtain "${bnetId},${version}" - not indexed.`);
            }

            const mapHeaderData = await this.getMapHeader(rcode, mhead.headerHash);

            for (const dep of mapHeaderData.extraDependencies.reverse()) {
                if (!deps.has(`${dep.id},${dep.version}`)) {
                    await fetchMapDependencies(regionId, dep.id, dep.version);
                }
            }

            deps.set(`${bnetId},${version}`, {
                map: map,
                mapHeader: mhead,
                rawData: mapHeaderData,
                requestedVersion: version,
            });
        }).bind(this);

        await fetchMapDependencies(regionId, bnetId);

        return deps;
    }
}
