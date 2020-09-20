export enum GameRegion {
    US = 1,
    EU = 2,
    KR = 3,
    CN = 5,
}

export type DepotRegion = 'us' | 'eu' | 'kr' | 'cn';

export enum GameLocale {
    deDE = 'deDE',
    enGB = 'enGB',
    esES = 'esES',
    frFR = 'frFR',
    itIT = 'itIT',
    plPL = 'plPL',
    ptPT = 'ptPT',
    ruRU = 'ruRU',
    zhCN = 'zhCN',
    zhTW = 'zhTW',
    koKR = 'koKR',
    enSG = 'enSG',
    enUS = 'enUS',
    esMX = 'esMX',
    ptBR = 'ptBR',
}

export interface PlayerProfile {
    regionId: number;
    realmId: number;
    profileId: number;
    name: string;
    discriminator: number;
}

export function battleMapLink(regionId: number, mapId: number) {
    return `battlenet:://starcraft/map/${regionId}/${mapId}`;
}

export function encodeMapVersion(majorVersion: number, minorVersion: number) {
    return ((majorVersion & 0xFFFF) << 16) | minorVersion & 0xFFFF;
}

export function decodeMapVersion(version: number) {
    return [(version >> 16) & 0xFFFF, (version) & 0xFFFF];
}
