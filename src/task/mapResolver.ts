import * as orm from 'typeorm';
import * as fs from 'fs-extra';
import * as fxml from 'fast-xml-parser';
import * as he from 'he';
import { spawn } from 'child_process';
import { S2MapHeader } from '../entity/S2MapHeader';
import { BattleDepot } from '../depot';
import { GameRegion, GameLocale, DepotRegion } from '../common';
import { logger, logIt } from '../logger';
import { spawnWaitExit, retry, throwErrIfNotDuplicateEntry, deepCopy } from '../helpers';
import { S2Map, S2MapType } from '../entity/S2Map';
import { S2MapCategory } from '../entity/S2MapCategory';

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
    Bulleted = 'bulleted',
    Numbered = 'numbered',
    None = 'none',
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

export enum AttributeRestrictionKind {
    None = 'none',
    Self = 'self',
    Host = 'host',
    All = 'all',
}

export interface AttributeDefinition<ET, MI> {
    instance: AttributeInstance;
    values: AttributeValueDefinition<ET, MI>[];
    // TODO: requirements
    arbitration: number;
    visibility: AttributeRestrictionKind;
    access: AttributeRestrictionKind;
    options: number;
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
    maxHumanPlayers?: number;
    maxOpenSlots?: number;
    premiumInfo?: PremiumInfo[];
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
    specialTags?: MapTags[];
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
            items: localizeField,
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

    function removeUnknownFields(obj: any) {
        for (const key in obj) {
            if (key.startsWith('_')) {
                delete obj[key];
                continue;
            }
            if (Array.isArray(obj[key])) {
                obj[key].forEach((x: any) => removeUnknownFields(x));
            }
            else if (typeof obj[key] === 'object') {
                removeUnknownFields(obj[key]);
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

    return removeUnknownFields(result);
}

export class MapResolver {
    protected depot = new BattleDepot('data/depot');
    protected mapCategories: S2MapCategory[];

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
        const decodingProc = await spawnWaitExit(spawn(process.env.STARC_S2MDECODER_PATH ?? 's2mdecoder', [
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
        return JSON.parse(decodingProc.stdout) as MapHeaderDataRaw;
    }

    @retry({
        retries: 2,
        onFailedAttempt: err => {
            logger.warn(`failed to init map header`, err);
        },
    })
    async initializeMapHeader(mhead: S2MapHeader, isInitialVersion?: boolean) {
        if (!this.mapCategories) {
            this.mapCategories = await this.conn.getRepository(S2MapCategory).find();
        }

        logger.verbose(`resolving.. map=${mhead.regionId}/${mhead.bnetId} v${mhead.majorVersion}.${mhead.minorVersion} hash=${mhead.headerHash}`);
        const rcode = GameRegion[mhead.regionId];

        const headerRawData = await this.getMapHeader(rcode, mhead.headerHash);

        if (!mhead.uploadedAt) {
            const s2mhResponse = await this.depot.retrieveHead(rcode, `${mhead.headerHash}.s2mh`);
            mhead.uploadedAt = new Date(s2mhResponse.headers['last-modified']);
        }
        if (!mhead.archiveSize) {
            const s2maResponse = await this.depot.retrieveHead(rcode, `${headerRawData.archiveHandle.hash}.${headerRawData.archiveHandle.type}`);
            if (s2maResponse.headers['content-length']) {
                mhead.archiveSize = Number(s2maResponse.headers['content-length']);
            }
            else {
                mhead.archiveSize = null;
            }
        }
        mhead.archiveHash = headerRawData.archiveHandle.hash;

        const mainLocaleTable = headerRawData.workingSet.localeTable.find(x => x.locale === GameLocale.enUS) ?? headerRawData.workingSet.localeTable[0];
        const localizationData = await this.getMapLocalization(rcode, mainLocaleTable.stringTable[0].hash, true);
        const mapHeader = reprocessMapHeader(headerRawData, localizationData);
        const mapIcon = (
            mapHeader.arcadeInfo?.mapIcon ??
            mapHeader.workingSet.thumbnail ??
            mapHeader.workingSet.bigMap ??
            null
        );

        let map = await this.conn.getRepository(S2Map).findOne({
            relations: ['currentVersion', 'initialVersion'],
            where: { regionId: mhead.regionId, bnetId: mhead.bnetId },
        });
        if (!map) {
            map = new S2Map();
            map.regionId = mhead.regionId;
            map.bnetId = mhead.bnetId;
        }

        let updatedMap = false;
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
            updatedMap = true;
        }

        if (isInitialVersion && !map.initialVersion) {
            map.initialVersion = mhead;
            map.publishedAt = mhead.uploadedAt;
            updatedMap = true;
        }

        try {
            await this.conn.transaction(async em => {
                await em.getRepository(S2MapHeader).save(mhead, { transaction: false });
                if (updatedMap) {
                    await em.getRepository(S2Map).save(map, { transaction: false });
                }
            });
        }
        catch (err) {
            throwErrIfNotDuplicateEntry(err);
        }

        return mapHeader;
    }
}
