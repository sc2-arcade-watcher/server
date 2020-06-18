import { logger } from '../logger';

export type SignalKind =
    'INIT' |
    'TMCR' |
    'QUIT' |
    'DISC' |
    'LBLS' |
    'LBCR' |
    'LBRM' |
    'LBUD' |
    'LBPV' |
    'LBPA' |
    'LBPR' |
    'LBPE'
;

export interface SignalBase {
    $kind: SignalKind;
    $version: number;
    $timestamp: number;
}

export interface DataInit {
    bucketId: number;
    handleUnknown1: number;
    playerHandle: string;
}
export interface SignalInit extends SignalBase, DataInit {
    $kind: 'INIT';
}

export interface DataTimeCorrection {
    offset: number;
}
export interface SignalTimeCorrection extends SignalBase, DataTimeCorrection {
    $kind: 'TMCR';
}

export interface DataQuit {
}
export interface SignalQuit extends SignalBase, DataQuit {
    $kind: 'QUIT';
}

export interface DataDisconnect {
}
export interface SignalDisconnect extends SignalBase, DataDisconnect {
    $kind: 'DISC';
}

export interface DataLobbyList {
    count: number;
}
export interface SignalLobbyList extends SignalBase, DataLobbyList {
    $kind: 'LBLS';
}

export interface DataLobbyCreate {
    lobbyId: number;
    mapHandle: number[];
    extModHandle: number[];
    multiModHandle: number[];
    mapVariantIndex: number;
    lobbyName: string;
    accountThatSetName: number;
    hostName: string;
    slotsHumansTaken: number;
    slotsHumansTotal: number;
    mapName: string;
    mapMajorVersion: number;
    mapMinorVersion: number;
    isArcade: boolean;
    mapVariantMode: string;
    mapVariantCategory: string;
    extModName: string;
    extModMajorVersion: number;
    extModMinorVersion: number;
    multiModName: string;
    multiModMajorVersion: number;
    multiModMinorVersion: number;
    mapIcon: string;
}
export interface SignalLobbyCreate extends SignalBase, DataLobbyCreate {
    $kind: 'LBCR';
}

export interface DataLobbyRemove {
    lobbyId: number;
}
export interface SignalLobbyRemove extends SignalBase, DataLobbyRemove {
    $kind: 'LBRM';
}

export interface DataLobbyUpdate {
    lobbyId: number;
    lobbyName: string;
    accountThatSetName: number;
    hostName: string;
    slotsHumansTaken: number;
    slotsHumansTotal: number;
}
export interface SignalLobbyUpdate extends SignalBase, DataLobbyUpdate {
    $kind: 'LBUD';
}

export enum LobbySlotKind {
    Closed = 'C',
    Open = 'O',
    AI = 'A',
    Human = 'H',
}
export interface LobbyPreviewSlot {
    kind: LobbySlotKind;
    team: number;
    name: string;
}
export interface DataLobbyPreview {
    lobbyId: number;
    slots: LobbyPreviewSlot[];
    teamsNumber: number;
}
export interface SignalLobbyPreview extends SignalBase, DataLobbyPreview {
    $kind: 'LBPV';
}

/**
 * Lobby Alive
 */

interface DataLobbyAlive {
    lobbyId: number;
}
export interface SignalLobbyAlive extends SignalBase, DataLobbyAlive {
    $kind: 'LBPA';
}

/**
 * Lobby Request
 */

interface DataLobbyRequest {
    lobbyId: number;
}
export interface SignalLobbyRequest extends SignalBase, DataLobbyRequest {
    $kind: 'LBPR';
}

/**
 * Lobby Preview Extended
 */

export enum LobbyPvExSlotKind {
    // None     = 0,
    Computer = 1,
    Open     = 2,
    Human    = 3,
}

export interface LobbyPvExProfile {
    regionId: number;
    realmId: number;
    profileId: number;
    name: string;
    discriminator: number;
}

export interface LobbyPvExSlot {
    slotIdx: number;
    kind: LobbyPvExSlotKind;
    team: number;
    profile?: LobbyPvExProfile;
}
export interface DataLobbyPvEx {
    slots: LobbyPvExSlot[];
    teamsNumber: number;
}
export interface SignalLobbyPvEx extends SignalBase, DataLobbyPvEx {
    $kind: 'LBPE';
}

export type SignalDesc = SignalInit
    | SignalTimeCorrection
    | SignalQuit
    | SignalDisconnect
    | SignalLobbyList
    | SignalLobbyCreate
    | SignalLobbyRemove
    | SignalLobbyUpdate
    | SignalLobbyPreview
    | SignalLobbyAlive
    | SignalLobbyRequest
    | SignalLobbyPvEx
;

type unserializeEvFn = (version: number, args: string[]) => {};

function popFirst<T>(v: T[]): T {
    return v.shift();
}

function numberPair(s: string) {
    return s.split(',').map(v => Number(v));
}

function myunescape(s: string) {
    s = s.replace(/&gt;/g, '>');
    s = s.replace(/&lt;/g, '<');
    s = s.replace(/&apos;/g, '\'');
    s = s.replace(/&quot;/g, '"');
    s = s.replace(/&amp;/g, '&');
    return s;
}

export class SigDataCorruption extends Error {
    constructor(public readonly corruptedData: string, public readonly followingData: string) {
        super();
    }
}

export class JournalDecoder {
    private unserializeHandlers: Record<SignalKind, unserializeEvFn> = {
        'INIT': this.unserializeInit.bind(this),
        'TMCR': this.unserializeTimeCorrection.bind(this),
        'QUIT': this.unserializeQuit.bind(this),
        'DISC': this.unserializeDisconnect.bind(this),
        'LBLS': this.unserializeLobbyList.bind(this),
        'LBCR': this.unserializeLobbyCreate.bind(this),
        'LBRM': this.unserializeLobbyRemove.bind(this),
        'LBUD': this.unserializeLobbyUpdate.bind(this),
        'LBPV': this.unserializeLobbyPreview.bind(this),
        'LBPA': this.unserializeLobbyAlive.bind(this),
        'LBPR': this.unserializeLobbyRequest.bind(this),
        'LBPE': this.unserializeLobbyPvEx.bind(this),
    };

    unserializeInit(version: number, args: string[]): DataInit {
        const ed = {} as DataInit;
        ed.bucketId = Number(popFirst(args));
        if (version >= 3) {
            ed.handleUnknown1 = Number(popFirst(args));
        }
        ed.playerHandle = popFirst(args);
        return ed;
    }

    unserializeTimeCorrection(version: number, args: string[]): DataTimeCorrection {
        const ed = {} as DataTimeCorrection;
        ed.offset = Number(popFirst(args));
        return ed;
    }

    unserializeQuit(version: number, args: string[]): DataQuit {
        return {};
    }

    unserializeDisconnect(version: number, args: string[]): DataDisconnect {
        return {};
    }

    unserializeLobbyList(version: number, args: string[]): DataLobbyList {
        const ed = {} as DataLobbyList;
        ed.count = Number(popFirst(args));
        return ed;
    }

    unserializeLobbyCreate(version: number, args: string[]): DataLobbyCreate {
        const ed = {} as DataLobbyCreate;
        ed.lobbyId = Number(popFirst(args));
        ed.mapHandle = numberPair(popFirst(args));
        ed.extModHandle = numberPair(popFirst(args));
        ed.multiModHandle = numberPair(popFirst(args));
        ed.mapVariantIndex = Number(popFirst(args));

        ed.lobbyName = myunescape(popFirst(args)).trim();
        if (version >= 2) {
            ed.accountThatSetName = Number(popFirst(args));
        }
        else {
            ed.accountThatSetName = 0;
        }
        ed.hostName = popFirst(args);
        ed.slotsHumansTaken = Number(popFirst(args));
        ed.slotsHumansTotal = Number(popFirst(args));

        ed.mapName = popFirst(args);
        ed.mapMajorVersion = Number(popFirst(args));
        ed.mapMinorVersion = Number(popFirst(args));
        ed.isArcade = Boolean(Number(popFirst(args)));
        ed.mapVariantMode = popFirst(args);
        ed.mapVariantCategory = popFirst(args);

        ed.extModName = popFirst(args);
        ed.extModMajorVersion = Number(popFirst(args));
        ed.extModMinorVersion = Number(popFirst(args));

        ed.multiModName = popFirst(args);
        ed.multiModMajorVersion = Number(popFirst(args));
        ed.multiModMinorVersion = Number(popFirst(args));

        ed.mapIcon = popFirst(args);
        return ed;
    }

    unserializeLobbyRemove(version: number, args: string[]): DataLobbyRemove {
        const ed = {} as DataLobbyRemove;
        ed.lobbyId = Number(popFirst(args));
        return ed;
    }

    unserializeLobbyUpdate(version: number, args: string[]): DataLobbyUpdate {
        const ed = {} as DataLobbyUpdate;
        ed.lobbyId = Number(popFirst(args));
        ed.lobbyName = myunescape(popFirst(args)).trim();
        if (version >= 2) {
            ed.accountThatSetName = Number(popFirst(args));
        }
        else {
            ed.accountThatSetName = 0;
        }
        ed.hostName = popFirst(args);
        ed.slotsHumansTaken = Number(popFirst(args));
        ed.slotsHumansTotal = Number(popFirst(args));
        return ed;
    }

    unserializeLobbySlot(version: number, args: string[]): LobbyPreviewSlot {
        return {
            kind: popFirst(args) as LobbySlotKind,
            team: Number(popFirst(args)),
            name: popFirst(args),
        };
    }

    unserializeLobbyPreview(version: number, args: string[]): DataLobbyPreview {
        const ed = {} as DataLobbyPreview;
        ed.lobbyId = Number(popFirst(args));
        ed.slots = popFirst(args)
            .split('\x02')
            .map(v => this.unserializeLobbySlot(version, v.split('$')))
            .filter(v => v.kind as string !== '' && v.kind !== 'C')
            .sort((a, b) => a.team - b.team)
        ;
        ed.teamsNumber = Number(popFirst(args));
        return ed;
    }

    unserializeLobbyAlive(version: number, args: string[]) {
        const ed = {} as DataLobbyAlive;
        ed.lobbyId = Number(popFirst(args));
        return ed;
    }

    unserializeLobbyRequest(version: number, args: string[]) {
        const ed = {} as DataLobbyRequest;
        ed.lobbyId = Number(popFirst(args));
        return ed;
    }

    unserializeLobbyPvEx(version: number, args: string[]) {
        const ed = {} as DataLobbyPvEx;
        ed.slots = popFirst(args)
            .split('\x02').map((pslot, idx): LobbyPvExSlot => {
                const slotArgs = pslot.split('\x03');
                const slotDesc: LobbyPvExSlot = {
                    slotIdx: idx + 1,
                    team: Number(popFirst(slotArgs)),
                    kind: Number(popFirst(slotArgs)),
                };
                const profileArgs = popFirst(slotArgs).split('\x04');
                if (profileArgs.length > 1) {
                    slotDesc.profile = {
                        regionId: Number(popFirst(profileArgs)),
                        realmId: Number(popFirst(profileArgs)),
                        profileId: Number(popFirst(profileArgs)),
                        discriminator: Number(popFirst(profileArgs)),
                        name: popFirst(profileArgs),
                    };
                }
                return slotDesc;
            })
        ;
        // if first slot is unused it means payload isn't complete and should be ignored
        if (!ed.slots.length || ed.slots[0].kind === 0) {
            ed.slots = [];
            ed.teamsNumber = 0;
        }
        else {
            ed.slots = ed.slots.filter(v => v.kind).sort((a, b) => a.team - b.team);
            ed.teamsNumber = (new Set(ed.slots.map(x => x.team))).size;
        }
        return ed;
    }

    unserialize(payload: string): SignalDesc {
        if (payload.startsWith('\x00')) {
            const m = payload.match(/^(\x00+)(.*)/);
            if (m) {
                logger.error('data corruption', [m[1].length, m[2]]);
                throw new SigDataCorruption(m[1], m[2]);
            }
            else {
                throw new Error('???');
            }
        }

        const args = payload.split('\x01');

        const tmp = popFirst(args).split(':');
        const evKind = tmp[0] as SignalKind;
        let evVersion = 1;
        if (tmp.length > 1) {
            evVersion = Number(tmp[1]);
        }
        const evTimestamp = Number(popFirst(args));

        const handler = this.unserializeHandlers[evKind];
        if (!handler) {
            logger.error(`sigproc: missing handler for "${evKind}"`);
            throw new SigDataCorruption(payload, '');
        }

        return {
            $kind: evKind,
            $version: evVersion,
            $timestamp: evTimestamp,
            ...handler(evVersion, args)
        } as SignalDesc;
    }
}


