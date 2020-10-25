import { LobbyPreviewSlot, DataLobbyCreate, JournalDecoder, SignalBase, SignalLobbyCreate, SignalLobbyRemove, SignalLobbyUpdate, SignalLobbyPreview, LobbySlotKind, SignalLobbyList, SignalInit, SignalDesc, SigDataCorruption, SignalLobbyAlive, SignalLobbyPvEx, SignalLobbyRequest, LobbyPvExSlotKind, DataLobbyUpdate, DataLobbyPreview, DataLobbyPvEx, DataLobbyRemove, LobbyPvExProfile } from './journal/decoder';
import { TypedEvent, sleep } from './helpers';
import { JournalFeed, JournalFeedCursor } from './journal/feed';
import { logger, logIt } from './logger';
import { parseProfileHandle } from './bnet/common';
import { oneLine } from 'common-tags';

// TODO: replace with GameRegion from common.ts
export enum GameRegion {
    US = 1,
    EU = 2,
    KR = 3,
    CN = 5,
}

interface GameLobbyPreview {
    lastUpdateAt: Date;
    slots: LobbyPreviewSlot[];
    teamsNumber: number;
}

interface PreviewRequestStatus {
    lobbyId: number;
    reqEntry: SignalLobbyRequest;
    basicPreview?: SignalLobbyPreview;
    extendedPreview?: SignalLobbyPvEx;
}

export interface TrackedLobby extends DataLobbyCreate {
    cursor: JournalFeedCursor;
    createdAt: Date;
    updatedAt: Date;
    preview?: GameLobbyPreview;
    previewHistory: PreviewRequestStatus[];
}

export interface TrackedLobbyCreate extends DataLobbyCreate {
    bucketId: number;
    createdAt: Date;
}

export interface TrackedLobbyRemove extends DataLobbyRemove {
    removedAt: Date;
    seenLastAt: Date;
    orphan: boolean;
}

interface TrackedLobbyHeadUpdate extends DataLobbyUpdate {
    updatedAt: Date;
}

interface TrackedLobbyPreview {
    lobbyId: number;
    requstedAt: Date;
    basicPreview?: SignalLobbyPreview;
    extendedPreview?: SignalLobbyPvEx;
}

interface TrackedLobbyListCount {
    count: number;
}

function serializeBasicPreview(basicPreview: DataLobbyPreview | GameLobbyPreview) {
    return basicPreview.slots.map(x => {
        return [x.kind, x.team.toString().padStart(2, '0'), x.name].join('');
    });
}

function serializeExtendedPreview(extendedPreview: DataLobbyPvEx) {
    return extendedPreview.slots.map(x => {
        return [
            ['N', 'A', 'O', 'H'][x.kind],
            x.team.toString().padStart(2, '0'),
            x.profile ? x.profile.name : '',
        ].join('');
    });
}


export class JournalReader {
    protected decoder = new JournalDecoder();

    protected openLobbies = new Map<number, TrackedLobby>();
    protected sessLobbies = new Set<number>();

    protected recentPreviewRequests = new Map<number, PreviewRequestStatus>();
    protected recentExPvResponses = new Set<SignalLobbyPvEx>();

    protected prevCursorPos: JournalFeedCursor;
    protected initEntry: SignalInit;
    protected nextSignal: SignalDesc;
    protected bucketId: number;
    protected isNewSession = false;
    protected sessLbls: number = void 0;
    protected prevCompleteListEntry: SignalLobbyList;
    protected recentListEntry: SignalLobbyList;
    protected lblsCursor: JournalFeedCursor;
    protected timezoneOffset = 0;

    protected _onFeedEnd = new TypedEvent<JournalFeed>();
    protected _onLobbyCreate = new TypedEvent<TrackedLobbyCreate>();
    protected _onLobbyRemove = new TypedEvent<TrackedLobbyRemove>();
    protected _onLobbyUpdate = new TypedEvent<TrackedLobbyHeadUpdate>();
    protected _onLobbyPreview = new TypedEvent<TrackedLobbyPreview>();
    protected _onLobbyListCount = new TypedEvent<TrackedLobbyListCount>();

    readonly onFeedEnd = this._onFeedEnd.on.bind(this._onFeedEnd);
    readonly onLobbyCreate = this._onLobbyCreate.on.bind(this._onLobbyCreate);
    readonly onLobbyRemove = this._onLobbyRemove.on.bind(this._onLobbyRemove);
    readonly onLobbyUpdate = this._onLobbyUpdate.on.bind(this._onLobbyUpdate);
    readonly onLobbyPreview = this._onLobbyPreview.on.bind(this._onLobbyPreview);
    readonly onLobbyListCount = this._onLobbyListCount.on.bind(this._onLobbyListCount);

    constructor(public readonly region: GameRegion, public readonly jfeed: JournalFeed) {
    }

    get supportsPreviewRequests(): boolean {
        return this.initEntry.$version >= 3;
    }

    async close() {
        this.jfeed.close();
    }

    async peek() {
        if (this.nextSignal) {
            return this.nextSignal;
        }
        else {
            this.prevCursorPos = Object.assign({}, this.jfeed.cursor);
            const tmp = await this.jfeed.read();
            if (typeof tmp === 'string') {
                this.nextSignal = this.decodeSignal(tmp);
            }
            else if (tmp === false) {
                this._onFeedEnd.emit(this.jfeed);
            }
            return this.nextSignal;
        }
    }

    async next() {
        if (!this.nextSignal) {
            await this.peek();
        }
        if (this.nextSignal) {
            this.processSignal(this.nextSignal);
            this.nextSignal = void 0;
        }
    }

    get cursorResumePointer(): JournalFeedCursor {
        if (!this.openLobbies.size) {
            return Object.assign({}, this.jfeed.cursor);
        }

        let cursor: JournalFeedCursor;
        for (const gm of this.openLobbies.values()) {
            if (
                (!cursor) ||
                (gm.cursor.session < cursor.session) ||
                (gm.cursor.session === cursor.session && gm.cursor.offset < cursor.offset)
            ) {
                cursor = Object.assign({}, gm.cursor);
            }
        }
        return cursor;
    }

    get cursorCurrent(): JournalFeedCursor {
        return Object.assign({}, this.jfeed.cursor);
    }

    get cursorPrev(): JournalFeedCursor {
        return Object.assign({}, this.prevCursorPos ?? this.jfeed.cursor);
    }

    dateFromEvent(ev: SignalBase | number): Date {
        if (typeof ev === 'number') {
            return new Date((ev + this.timezoneOffset) * 1000);
        }
        else {
            return this.dateFromEvent(ev.$timestamp);
        }
    }

    protected decodeSignal(payload: string) {
        try {
            return this.decoder.unserialize(payload);
        }
        catch (err) {
            if (err instanceof SigDataCorruption) {
                logger.error('corruption at', [
                    this.jfeed.cursor,
                    this.jfeed.baseDir,
                    err.corruptedData.length,
                    err.followingData.length
                ]);
            }
            throw err;
        }
    }

    protected processSignal(ev: SignalDesc) {
        switch (ev.$kind) {
            case 'INIT': return this.handleInit(ev);
            case 'LBCR': return this.handleLobbyCreate(ev);
            case 'LBRM': return this.handleLobbyRemove(ev);
            case 'LBUD': return this.handleLobbyUpdate(ev);
            case 'LBPV': return this.handleLobbyPreview(ev);
            case 'LBPA': return this.handleLobbyAlive(ev);
            case 'LBPE': return this.handleLobbyPvEx(ev);
            case 'LBPR': return this.handleLobbyRequest(ev);
            case 'LBLS': return this.handleLobbyList(ev);
        }
    }

    protected handleInit(ev: SignalInit) {
        this.initEntry = ev;
        this.bucketId = ev.bucketId;
        const mprofile = parseProfileHandle(ev.playerHandle);
        if (mprofile.regionId !== this.region) {
            throw new Error(`sess=${this.jfeed.currCursor} region missmatch ${mprofile.regionId} !== ${this.region}`);
        }

        if (ev.$version === 1) {
            this.timezoneOffset = -3600;
        }
        else {
            this.timezoneOffset = 0;
        }

        if (this.isNewSession) {
            logger.warn(`isNewSession=true for ${ev.playerHandle}`);
            this.isNewSession = false;
        }

        this.recentPreviewRequests.clear();
        this.recentExPvResponses.clear();
    }

    protected handleLobbyList(ev: SignalLobbyList) {
        const tmp = this.recentListEntry;
        this.recentListEntry = ev;
        this.lblsCursor = this.prevCursorPos;

        if (this.sessLbls === void 0) {
            this.sessLbls = this.prevCursorPos.session;
        }
        else if (!this.isNewSession && this.prevCursorPos.session > this.sessLbls) {
            this.isNewSession = true;
            this.sessLobbies.clear();
            return;
        }
        else if (this.isNewSession) {
            const orphans = Array.from(this.openLobbies.keys()).filter(x => !this.sessLobbies.has(x));
            for (const lobbyId of orphans) {
                this.doRemoveLobby(lobbyId, this.dateFromEvent(this.recentListEntry), true);
            }
            this.isNewSession = false;
            this.sessLbls = this.prevCursorPos.session;
        }

        this._onLobbyListCount.emit({
            count: ev.count,
        });

        this.prevCompleteListEntry = tmp;
    }

    protected handleLobbyCreate(ev: SignalLobbyCreate) {
        const gm: TrackedLobby = Object.assign<TrackedLobby, SignalLobbyCreate>({
            cursor: Object.assign({}, this.lblsCursor),
            createdAt: this.dateFromEvent(this.recentListEntry),
            updatedAt: this.dateFromEvent(this.recentListEntry),
            previewHistory: [],
        } as TrackedLobby, ev);
        delete (<any>gm as SignalLobbyCreate).$kind;
        delete (<any>gm as SignalLobbyCreate).$version;
        delete (<any>gm as SignalLobbyCreate).$timestamp;

        this.openLobbies.set(ev.lobbyId, gm);
        this.sessLobbies.add(ev.lobbyId);

        const tmp = Object.assign<TrackedLobbyCreate, SignalLobbyCreate>({
            bucketId: this.bucketId,
            createdAt: this.dateFromEvent(this.recentListEntry),
        } as TrackedLobbyCreate, ev);
        delete (<any>tmp as SignalLobbyCreate).$kind;
        delete (<any>tmp as SignalLobbyCreate).$version;
        delete (<any>tmp as SignalLobbyCreate).$timestamp;
        this._onLobbyCreate.emit(tmp);
    }

    protected handleLobbyRemove(ev: SignalLobbyRemove) {
        const gm = this.openLobbies.get(ev.lobbyId);
        if (!gm) return;

        this.doRemoveLobby(ev.lobbyId, this.dateFromEvent(this.recentListEntry));
    }

    protected doRemoveLobby(lobbyId: number, removedAt: Date, orphan: boolean = false) {
        const gm = this.openLobbies.get(lobbyId);

        if (this.recentPreviewRequests.has(lobbyId)) {
            this.findMatchForPvEx(0, true);
            this.recentPreviewRequests.delete(lobbyId);
        }

        this.openLobbies.delete(lobbyId);
        this.sessLobbies.delete(lobbyId);
        this._onLobbyRemove.emit({
            lobbyId,
            removedAt,
            orphan,
            seenLastAt: this.dateFromEvent(this.prevCompleteListEntry ?? this.initEntry)
        });
    }

    protected handleLobbyUpdate(ev: SignalLobbyUpdate) {
        const gm = this.openLobbies.get(ev.lobbyId);
        if (!gm) return;

        gm.updatedAt = this.dateFromEvent(this.recentListEntry);
        gm.lobbyName = ev.lobbyName;
        gm.accountThatSetName = ev.accountThatSetName;
        gm.hostName = ev.hostName;
        gm.slotsHumansTaken = ev.slotsHumansTaken;
        gm.slotsHumansTotal = ev.slotsHumansTotal;

        this._onLobbyUpdate.emit({
            updatedAt: this.dateFromEvent(this.recentListEntry),
            lobbyId: ev.lobbyId,
            lobbyName: ev.lobbyName,
            accountThatSetName: ev.accountThatSetName,
            hostName: ev.hostName,
            slotsHumansTaken: ev.slotsHumansTaken,
            slotsHumansTotal: ev.slotsHumansTotal,
        });
    }

    protected handleLobbyPreview(ev: SignalLobbyPreview) {
        const gm = this.openLobbies.get(ev.lobbyId);
        if (!gm) return;

        gm.preview = {
            lastUpdateAt: this.dateFromEvent(ev),
            slots: ev.slots,
            teamsNumber: ev.teamsNumber,
        };

        if (!this.supportsPreviewRequests) {
            this._onLobbyPreview.emit({
                lobbyId: ev.lobbyId,
                requstedAt: this.dateFromEvent(ev.$timestamp),
                basicPreview: ev,
            });
        }
        else {
            const reqInfo = this.recentPreviewRequests.get(ev.lobbyId);
            if (!reqInfo) {
                logger.debug(`haven't found matching preview request for lobid=${ev.lobbyId}`);
                return;
            }
            if (reqInfo.basicPreview) {
                logger.debug(`matched preview request already has "basicPreview" lobid=${ev.lobbyId}`);
                return;
            }
            reqInfo.basicPreview = ev;
            if (reqInfo.basicPreview && reqInfo.extendedPreview) {
                this.forwardCompletePreviewRequests(reqInfo.lobbyId);
            }
            else {
                this.findMatchForPvEx(ev.$timestamp);
            }
        }
    }

    protected handleLobbyAlive(ev: SignalLobbyAlive) {
        const gm = this.openLobbies.get(ev.lobbyId);
        if (!gm) return;

        this.handleLobbyPreview({
            $kind: 'LBPV',
            $timestamp: ev.$timestamp,
            $version: 1,
            lobbyId: ev.lobbyId,
            slots: gm.preview.slots,
            teamsNumber: gm.preview.teamsNumber,
        });
    }

    protected handleLobbyPvEx(ev: SignalLobbyPvEx) {
        if (!ev.slots.length) {
            logger.debug(`encountered 0 slots LBPE ${ev.$timestamp}`);
            return;
        }
        const knownBattletags = new Set<string>();
        for (const slot of ev.slots) {
            if (slot.kind !== LobbyPvExSlotKind.Human) continue;
            if (!slot.profile) {
                logger.debug(`encountered incomplete LBPE ${ev.$timestamp} slot=${slot.slotIdx}`);
                return;
            }
            const user = `${slot.profile.name}#${slot.profile.discriminator}`;
            if (slot.profile.regionId === 0 || slot.profile.realmId === 0 || slot.profile.profileId === 0 || slot.profile.discriminator === 0) {
                const profile = `${slot.profile.regionId}-S2-${slot.profile.realmId}-${slot.profile.profileId}`;
                logger.debug(`encountered incomplete LBPE ${ev.$timestamp} slot=${slot.slotIdx} user=${user} profile=${profile}`);
                return;
            }
            if (knownBattletags.has(user)) {
                // in very rare conditions the same player may appear on multiple slots - fix it up
                slot.profile = void 0;
                slot.kind = LobbyPvExSlotKind.Open;
                logger.debug(`found duplicate of player LBPE ${ev.$timestamp} slot=${slot.slotIdx} user=${user}`);
                continue;
            }
            knownBattletags.add(user);
        }

        this.recentExPvResponses.add(ev);
        this.findMatchForPvEx(ev.$timestamp);
    }

    protected handleLobbyRequest(ev: SignalLobbyRequest) {
        const gm = this.openLobbies.get(ev.lobbyId);
        if (!gm) return;

        if (this.recentPreviewRequests.has(ev.lobbyId)) {
            this.findMatchForPvEx(ev.$timestamp);
        }

        if (this.recentPreviewRequests.has(ev.lobbyId)) {
            const existingRequestInfo = this.recentPreviewRequests.get(ev.lobbyId);
            const tdiff = ev.$timestamp - existingRequestInfo.reqEntry.$timestamp;
            if (existingRequestInfo.extendedPreview) {
                this.forwardCompletePreviewRequests(ev.lobbyId);
            }
            else if (tdiff >= 3) {
                // previous LBPR got no response
                this.recentPreviewRequests.delete(ev.lobbyId);
            }
        }

        if (!this.recentPreviewRequests.has(ev.lobbyId)) {
            this.recentPreviewRequests.set(ev.lobbyId, {
                lobbyId: ev.lobbyId,
                reqEntry: ev,
            });
        }

        this.findMatchForPvEx(ev.$timestamp);
        this.processPendingRequests(ev);
        this.pruneObsoleteRequests(ev);
    }

    protected findMatchForPvEx(currTimestamp: number, force = false) {
        for (const [key, reqInfo] of Array.from(this.recentPreviewRequests.entries()).reverse()) {
            const exPvCandidates: SignalLobbyPvEx[] = [];

            if (reqInfo.basicPreview) {
                const tmpClassicPv = serializeBasicPreview(reqInfo.basicPreview).join(' ');
                for (const entryPvEx of Array.from(this.recentExPvResponses.values()).reverse()) {
                    const tmpExtendedPv = serializeExtendedPreview(entryPvEx).join(' ');
                    if (tmpClassicPv === tmpExtendedPv) {
                        exPvCandidates.push(entryPvEx);
                    }
                }
            }
            else {
                for (const entryPvEx of Array.from(this.recentExPvResponses.values()).reverse()) {
                    const tdiff = entryPvEx.$timestamp - reqInfo.reqEntry.$timestamp;
                    if (tdiff > 2.0) continue;
                    const gmlobby = this.openLobbies.get(reqInfo.lobbyId);
                    const isNameUnique = Array.from(this.openLobbies.values()).filter(x => {
                        if (x.hostName === gmlobby.hostName) return true;
                        return x.preview && x.preview.slots.filter(y => y.name === gmlobby.hostName).length;
                    }).length === 1;
                    if (!isNameUnique) {
                        continue;
                    }
                    // check if player names from the event match the hostName of tested lobby
                    const tmpExtendedPv = serializeExtendedPreview(entryPvEx);
                    if (!tmpExtendedPv.find(x => x.substr(3) === gmlobby.hostName)) {
                        continue;
                    }
                    // check if amount of slots is matching prev request
                    const recentPreviewReq = gmlobby.previewHistory.reverse().find(x => x.extendedPreview);
                    if (recentPreviewReq && recentPreviewReq.extendedPreview.slots.length !== entryPvEx.slots.length) {
                        logger.verbose(`possibly incomplete LBPE, slot missmatch. lob=${reqInfo.lobbyId} prev=${recentPreviewReq.extendedPreview.slots.length} now=${entryPvEx.slots.length}`);
                        logger.debug(`slots info`, recentPreviewReq.extendedPreview.slots, entryPvEx.slots);
                        continue;
                    }
                    exPvCandidates.push(entryPvEx);
                }
            }

            if (exPvCandidates.length > 1) {
                logger.debug(
                    `extra matches found for lobid=${reqInfo.lobbyId} num=${exPvCandidates.length}`,
                    Array.from(exPvCandidates.values())
                );
                continue;
            }
            if (exPvCandidates.length === 0) {
                continue;
            }

            reqInfo.extendedPreview = exPvCandidates.shift();
            this.recentExPvResponses.delete(reqInfo.extendedPreview);

            // forward early only if it has both preview events what confirms the data is correct
            if (reqInfo.basicPreview) {
                this.forwardCompletePreviewRequests(key);
            }
        }

        if (!this.recentPreviewRequests.size) return;

        // fallback find when LBPV was not received
        for (const entryPvEx of this.recentExPvResponses) {
            if ((currTimestamp - entryPvEx.$timestamp) <= 1.5) continue;

            let candidates = Array.from(this.recentPreviewRequests.values())
                .filter(reqInfo => {
                    if (reqInfo.basicPreview || reqInfo.extendedPreview) {
                        return false;
                    }
                    const tdiff = entryPvEx.$timestamp - reqInfo.reqEntry.$timestamp;
                    return tdiff > 0 && tdiff <= 2.5;
                })
                .filter(reqInfo => {
                    const gm = this.openLobbies.get(reqInfo.lobbyId);
                    if (!gm.preview) return false;
                    if (gm.preview.teamsNumber !== entryPvEx.teamsNumber) return false;
                    if (gm.preview.slots.length !== entryPvEx.slots.length) return false;
                    const currentHumanSlots = gm.preview.slots.filter(x => x.kind === LobbySlotKind.Human);
                    const matchingHumanSlots = entryPvEx.slots.filter(x => x.profile && currentHumanSlots.find(y => y.name === x.profile.name));
                    return matchingHumanSlots.length > 0;
                })
            ;

            if (candidates.length !== 1) {
                const players = entryPvEx.slots.map(x => x.profile?.name).filter(x => x);
                logger.debug(`no matches for entryPvEx l=${candidates.length} ts=${entryPvEx.$timestamp} sl=${entryPvEx.slots.length} players=${players}`);
            }
            else {
                const reqInfo = candidates.shift();
                reqInfo.extendedPreview = entryPvEx;
                this.forwardCompletePreviewRequests(reqInfo.lobbyId);
            }
            this.recentExPvResponses.delete(entryPvEx);
        }
    }

    protected pruneObsoleteRequests(ev: SignalLobbyRequest) {
        for (const [key, item] of this.recentPreviewRequests) {
            if ((ev.$timestamp - item.reqEntry.$timestamp) > 25) {
                if (item.extendedPreview) {
                    throw new Error(`wtf1 lobid=${item.lobbyId} ts=${item.reqEntry.$timestamp}`);
                }
                if (item.basicPreview) {
                    this.forwardPreview(key);
                }
                this.recentPreviewRequests.delete(key);
            }
        }
        for (const item of this.recentExPvResponses) {
            if ((ev.$timestamp - item.$timestamp) > 30) {
                this.recentExPvResponses.delete(item);
            }
        }

        for (const [key, item] of this.recentPreviewRequests) {
            if (this.recentPreviewRequests.size <= 5) break;
            if (item.basicPreview) {
                this.forwardPreview(key);
            }
            else if (item.extendedPreview) {
                logger.debug(`removed pending LBPR with incomplete response, lobid=${item.lobbyId} ts=${item.reqEntry.$timestamp}`, {
                    extendedPreview: item.extendedPreview,
                    basicPreview: item.basicPreview,
                });
            }
            this.recentPreviewRequests.delete(key);
        }
        for (const item of this.recentExPvResponses) {
            if (this.recentExPvResponses.size <= 3) break;
            logger.debug(`removed pending LBPE without a match, ts=${item.$timestamp}`);
            this.recentExPvResponses.delete(item);
        }
    }

    protected processPendingRequests(ev: SignalLobbyRequest) {
        for (const [key, reqInfo] of this.recentPreviewRequests) {
            if (key === this.recentPreviewRequests.size - 1) continue;
            if (reqInfo.reqEntry === ev) continue;
            if (!reqInfo.basicPreview && reqInfo.extendedPreview) {
                const tdiff = ev.$timestamp - reqInfo.extendedPreview.$timestamp;
                if (tdiff <= 0.2) continue;
            }
            else if (reqInfo.basicPreview && !reqInfo.extendedPreview) {
                const tdiff = ev.$timestamp - reqInfo.basicPreview.$timestamp;
                if (tdiff <= 0.2) continue;
            }
            else {
                continue;
            }

            this.forwardPreview(key);
            this.recentPreviewRequests.delete(key);
        }
    }

    protected forwardCompletePreviewRequests(lobbyId: number = -1) {
        for (const [key, reqInfo] of this.recentPreviewRequests) {
            if (lobbyId !== -1 && lobbyId !== key) continue;
            if (!reqInfo.extendedPreview) continue;
            if (reqInfo.basicPreview && reqInfo.extendedPreview && reqInfo.basicPreview.slots.length < 16 && reqInfo.basicPreview.slots.length !== reqInfo.extendedPreview.slots.length) {
                if (reqInfo.basicPreview.slots.length > reqInfo.extendedPreview.slots.length) {
                    logger.debug(`preview slots count missmatch lobid=${reqInfo.reqEntry.lobbyId}`, reqInfo.basicPreview, reqInfo.extendedPreview);
                    reqInfo.extendedPreview = void 0;
                }
            }
            this.forwardPreview(key);
            this.recentPreviewRequests.delete(key);
        }
    }

    protected forwardPreview(lobbyId: number) {
        const reqInfo = this.recentPreviewRequests.get(lobbyId);
        this.openLobbies.get(lobbyId).previewHistory.push(reqInfo);
        this._onLobbyPreview.emit({
            lobbyId: lobbyId,
            requstedAt: this.dateFromEvent(reqInfo.reqEntry.$timestamp),
            basicPreview: reqInfo.basicPreview,
            extendedPreview: reqInfo.extendedPreview,
        });
    }
}


export enum GameLobbyStatus {
    Open = 'open',
    Started = 'started',
    Abandoned = 'abandoned',
    Unknown = 'unknown',
}

export type GameLobbySlotProfile = LobbyPvExProfile;

export interface GameLobbySlotDesc {
    kind: LobbyPvExSlotKind;
    team: number;
    name: string | null;
    profile?: GameLobbySlotProfile;
}

function gameLobbySlotsFromPvEx(preview: DataLobbyPvEx) {
    const slots: GameLobbySlotDesc[] = [];
    for (const item of preview.slots) {
        slots.push({
            kind: item.kind,
            team: item.team,
            name: item.profile?.name ?? null,
            profile: item.profile ? Object.assign({}, item.profile) : void 0,
        });
    }
    return slots;
}

const slotKindMapFromBasic = {
    [LobbySlotKind.Closed]: 0,
    [LobbySlotKind.AI]: 1,
    [LobbySlotKind.Open]: 2,
    [LobbySlotKind.Human]: 3,
};

function gameLobbySlotsFromBasicPreview(preview: DataLobbyPreview) {
    const slots: GameLobbySlotDesc[] = [];
    for (const item of preview.slots) {
        slots.push({
            kind: slotKindMapFromBasic[item.kind],
            team: item.team,
            name: item.kind === LobbySlotKind.Human ? item.name : null,
            profile: void 0,
        });
    }
    return slots;
}

export class GameLobbyDesc {
    trackedBy = new Set<JournalReader>();
    initInfo: DataLobbyCreate & { bucketId: number };
    status: GameLobbyStatus = GameLobbyStatus.Open;

    createdAt: Date;
    closedAt?: Date;
    snapshotUpdatedAt: Date;
    slotTakenSnapshotUpdatedAt: Date;

    lobbyName: string;
    lobbyNameMeta: {
        title: string;
        profileName: string;
        accountId: number | null;
        changedAt: Date;
    } | null;

    hostName: string;
    slotsHumansTaken: number;
    slotsHumansTotal: number;

    slots?: GameLobbySlotDesc[];
    slotsPreviewUpdatedAt?: Date;
    basicPreviewUpdatedAt?: Date;
    pendingBasicPreview?: SignalLobbyPreview;
    extendedPreview?: SignalLobbyPvEx;

    constructor(public region: GameRegion, lobbyData: TrackedLobbyCreate) {
        this.initInfo = Object.assign({}, lobbyData);
        delete (<any>this.initInfo as TrackedLobbyCreate).createdAt;

        this.createdAt = lobbyData.createdAt;
        this.snapshotUpdatedAt = lobbyData.createdAt;

        this.lobbyName = this.initInfo.lobbyName;
        if (this.initInfo.lobbyName) {
            this.lobbyNameMeta = {
                title: this.initInfo.lobbyName,
                profileName: this.initInfo.hostName,
                accountId: this.initInfo.accountThatSetName === 0 ? null : this.initInfo.accountThatSetName,
                changedAt: new Date(this.createdAt),
            };
            this.lobbyNameMeta.changedAt.setMilliseconds(0);
        }
        else {
            this.lobbyNameMeta = null;
        }
        this.hostName = this.initInfo.hostName;
        this.slotsHumansTaken = this.initInfo.slotsHumansTaken;
        this.slotsHumansTotal = this.initInfo.slotsHumansTotal;
        this.slotTakenSnapshotUpdatedAt = lobbyData.createdAt;
    }

    get globalId(): string {
        return `${this.region}/${this.initInfo.bucketId}/${this.initInfo.lobbyId}`;
    }

    get teamsNumber(): number {
        return this.slots?.length ?? 0;
    }

    get previewHumanTakenSlots(): number {
        return this.slots?.filter(x => x.kind === LobbyPvExSlotKind.Human).length ?? 0;
    }

    updateSnapshot(snapshot: TrackedLobbyHeadUpdate) {
        if (snapshot.updatedAt > this.snapshotUpdatedAt) {
            this.hostName = snapshot.hostName;
            if (this.lobbyName !== snapshot.lobbyName) {
                this.lobbyNameMeta = {
                    title: snapshot.lobbyName,
                    profileName: snapshot.hostName,
                    accountId: snapshot.accountThatSetName === 0 ? null : snapshot.accountThatSetName,
                    changedAt: new Date(snapshot.updatedAt),
                };
                this.lobbyNameMeta.changedAt.setMilliseconds(0);
            }
            this.lobbyName = snapshot.lobbyName;
            this.snapshotUpdatedAt = snapshot.updatedAt;

            if (this.slotsHumansTaken !== snapshot.slotsHumansTaken || this.slotsHumansTotal !== snapshot.slotsHumansTotal) {
                this.slotsHumansTaken = snapshot.slotsHumansTaken;
                this.slotsHumansTotal = snapshot.slotsHumansTotal;
                this.slotTakenSnapshotUpdatedAt = snapshot.updatedAt;
            }
            return true;
        }
        return false;
    }

    updatePreview(previewData: TrackedLobbyPreview) {
        this.pendingBasicPreview = void 0;
        this.basicPreviewUpdatedAt = void 0;

        if (previewData.extendedPreview) {
            const newSlots = gameLobbySlotsFromPvEx(previewData.extendedPreview);
            this.slots = newSlots;
            this.slotsPreviewUpdatedAt = previewData.requstedAt;
            this.extendedPreview = previewData.extendedPreview;
        }
        else {
            this.basicPreviewUpdatedAt = previewData.requstedAt;
            this.pendingBasicPreview = previewData.basicPreview;
            return false;
        }
        return true;
    }

    close(closeData: TrackedLobbyRemove) {
        // make sure the basic preview is actually newer before falling back to it
        if (this.pendingBasicPreview && (
            !this.slotsPreviewUpdatedAt || this.basicPreviewUpdatedAt > this.slotsPreviewUpdatedAt
        )) {
            const pendingSlots = gameLobbySlotsFromBasicPreview(this.pendingBasicPreview);
            if (this.extendedPreview) {
                const slBasic = serializeBasicPreview(this.pendingBasicPreview);
                const slExtended = serializeExtendedPreview(this.extendedPreview);

                if (
                    this.extendedPreview.$version < 3 &&
                    (slBasic.length === 16 && slExtended.length === 15)
                ) {
                    // supress the warning:
                    // it's possible for 16 slots to be unlocked, but 15 at most is usable
                    // however this was fixed in LBPEv3 - it now includes all 16 slots
                    // moreover sometimes the slot at last index would still be used in place of a slot with lower index
                }
                else if (slBasic.length !== slExtended.length) {
                    // log it but don't do anything - this doesn't necessarily means the data is incorrect
                    logger.debug(`extended slot count missmatch`, slBasic, slExtended);
                }
                else if (slBasic.join('') !== slExtended.join('')) {
                    this.slots.forEach((slot, index) => {
                        if (slBasic[index] === slExtended[index]) return;
                        if (this.slots[index].kind === LobbyPvExSlotKind.Human && pendingSlots[index].kind === LobbyPvExSlotKind.Human) {
                            logger.verbose(
                                oneLine`
                                    player slot incomplete ${this.initInfo.bucketId}/${this.initInfo.lobbyId} idx=${index}
                                `,
                                {
                                    p: this.slots[index],
                                    n: pendingSlots[index],
                                },
                            );
                        }
                        this.slots[index] = pendingSlots[index];
                    });
                    this.slotsPreviewUpdatedAt = this.basicPreviewUpdatedAt;
                }
            }
            else {
                this.slots = pendingSlots;
                this.slotsPreviewUpdatedAt = this.basicPreviewUpdatedAt;
            }
        }

        this.closedAt = closeData.removedAt;

        const diff = closeData.removedAt.getTime() - closeData.seenLastAt.getTime();
        if (diff > 70000) {
            logger.warn(`orphan lastseen=${closeData.seenLastAt.toISOString()} now=${closeData.removedAt.toISOString()} lobid=${this.initInfo.lobbyId}`);
            this.status = GameLobbyStatus.Unknown;
            this.closedAt = closeData.seenLastAt;
        }
        else if (this.slotsHumansTotal === 1 && this.slotsHumansTaken === this.slotsHumansTotal) {
            this.status = GameLobbyStatus.Started;
        }
        else if (!this.slots) {
            this.status = GameLobbyStatus.Unknown;
        }
        else {
            const snapshotTimeDiff = this.slotTakenSnapshotUpdatedAt.getTime() - this.slotsPreviewUpdatedAt.getTime();
            const humanSlotsOccupiedCount = snapshotTimeDiff > 17000 ? this.slotsHumansTaken : this.previewHumanTakenSlots;
            const hostInPreview = this.slots.filter(x => x.name === this.hostName).length;
            if (humanSlotsOccupiedCount <= 1) {
                this.status = GameLobbyStatus.Abandoned;
            }
            else if (humanSlotsOccupiedCount === 2 && snapshotTimeDiff > 15000 && !hostInPreview) {
                logger.warn(`fallback to disbandeded method2, lobid=${this.initInfo.lobbyId}`);
                this.status = GameLobbyStatus.Abandoned;
            }
            else {
                this.status = GameLobbyStatus.Started;
            }
        }
    }
}

export enum JournalEventKind {
    NewLobby,
    CloseLobby,
    UpdateLobbySnapshot,
    UpdateLobbySlots,
    UpdateLobbyList,
}

export interface JournalEventBase {
    kind: JournalEventKind;
    feedName: string;
    feedCursor: JournalFeedCursor;
}

export interface JournalEventOptionalBase {
    feedName?: string;
    feedCursor?: JournalFeedCursor;
}

export interface JournalEventNewLobby extends JournalEventBase {
    kind: JournalEventKind.NewLobby;
    lobby: GameLobbyDesc;
}

export interface JournalEventCloseLobby extends JournalEventBase {
    kind: JournalEventKind.CloseLobby;
    lobby: GameLobbyDesc;
}

export interface JournalEventUpdateLobbySnapshot extends JournalEventBase {
    kind: JournalEventKind.UpdateLobbySnapshot;
    lobby: GameLobbyDesc;
}

export interface JournalEventUpdateLobbySlots extends JournalEventBase {
    kind: JournalEventKind.UpdateLobbySlots;
    lobby: GameLobbyDesc;
}

export interface JournalEventUpdateLobbyList extends JournalEventBase {
    kind: JournalEventKind.UpdateLobbyList;
    count: number;
}

export type JournalEvent = JournalEventNewLobby
    | JournalEventCloseLobby
    | JournalEventUpdateLobbySnapshot
    | JournalEventUpdateLobbySlots
    | JournalEventUpdateLobbyList
;

type JournalEventOmitBase<T extends JournalEventBase> = Omit<T, 'feedName' | 'feedCursor'>;

export class JournalMultiProcessor {
    gtracks = new Map<string, JournalReader>();
    protected gameLobbies = new Map<number, GameLobbyDesc>();
    currentDate: Date;
    protected eventQueue: JournalEvent[] = [];
    private closed = false;

    constructor(public readonly region: GameRegion) {
    }

    protected pushEvent<T extends JournalEvent>(jreader: JournalReader, ev: JournalEventOmitBase<T>) {
        (<JournalEventOptionalBase>ev).feedName = jreader.jfeed.name;
        (<JournalEventOptionalBase>ev).feedCursor = jreader.cursorPrev;
        this.eventQueue.push(<any>ev);
    }

    protected handleLobbyCreate(jreader: JournalReader, tlob: TrackedLobbyCreate) {
        let lobState = this.gameLobbies.get(tlob.lobbyId);
        if (lobState) {
            const changed = lobState.updateSnapshot({
                lobbyId: tlob.lobbyId,
                updatedAt: tlob.createdAt,
                hostName: tlob.hostName,
                lobbyName: tlob.lobbyName,
                accountThatSetName: tlob.accountThatSetName,
                slotsHumansTaken: tlob.slotsHumansTaken,
                slotsHumansTotal: tlob.slotsHumansTotal,
            });
            lobState.trackedBy.add(jreader);
            if (!changed) return;
            this.pushEvent<JournalEventUpdateLobbySnapshot>(jreader, {
                kind: JournalEventKind.UpdateLobbySnapshot,
                lobby: lobState,
            });
        }
        else {
            lobState = new GameLobbyDesc(this.region, tlob);
            lobState.trackedBy.add(jreader);
            this.gameLobbies.set(tlob.lobbyId, lobState);
            this.pushEvent<JournalEventNewLobby>(jreader, {
                kind: JournalEventKind.NewLobby,
                lobby: lobState,
            });
        }
    }

    protected handleLobbyRemove(jreader: JournalReader, tlob: TrackedLobbyRemove) {
        const lobState = this.gameLobbies.get(tlob.lobbyId);
        if (!lobState) return;

        lobState.trackedBy.delete(jreader);
        if (tlob.orphan && lobState.trackedBy.size > 0) {
            const trackedByList = Array.from(lobState.trackedBy.values());
            logger.warn(`lobby ${lobState.initInfo.lobbyId} orphaned by ${jreader.jfeed.name} still tracked by ${trackedByList.map(x => x.jfeed.name).join(', ')}`);
            return;
        }

        lobState.close(tlob);
        this.gameLobbies.delete(tlob.lobbyId);
        this.pushEvent<JournalEventCloseLobby>(jreader, {
            kind: JournalEventKind.CloseLobby,
            lobby: lobState,
        });
    }

    protected handleLobbyUpdate(jreader: JournalReader, tlob: TrackedLobbyHeadUpdate) {
        const lobState = this.gameLobbies.get(tlob.lobbyId);
        if (!lobState) return;

        if (!lobState.updateSnapshot(tlob)) return;
        this.pushEvent<JournalEventUpdateLobbySnapshot>(jreader, {
            kind: JournalEventKind.UpdateLobbySnapshot,
            lobby: lobState,
        });
    }

    protected handleLobbyPreview(jreader: JournalReader, ev: TrackedLobbyPreview) {
        const lobState = this.gameLobbies.get(ev.lobbyId);
        if (!lobState) return;
        if (!lobState.updatePreview(ev)) return;

        this.pushEvent<JournalEventUpdateLobbySlots>(jreader, {
            kind: JournalEventKind.UpdateLobbySlots,
            lobby: lobState,
        });
    }

    protected handleLobbyListCount(jreader: JournalReader, ev: TrackedLobbyListCount) {
        this.pushEvent<JournalEventUpdateLobbyList>(jreader, {
            kind: JournalEventKind.UpdateLobbyList,
            count: ev.count,
        });
    }

    protected handleFeedEnd(jreader: JournalReader, evFeed: JournalFeed) {
        this.gtracks.delete(evFeed.name);
        logger.info(`onFeedEnd: ${evFeed.name} (${this.gtracks.size})`);
    }

    async close() {
        if (this.closed) {
            logger.warn(`already closed`);
            return;
        }
        this.closed = true;
        await Promise.all(Array.from(this.gtracks.values()).map(x => x.close()));
    }

    addFeedSource(sigstream: JournalFeed) {
        const jreader = new JournalReader(this.region, sigstream);
        this.gtracks.set(sigstream.name, jreader);
        jreader.onLobbyCreate(this.handleLobbyCreate.bind(this, jreader));
        jreader.onLobbyRemove(this.handleLobbyRemove.bind(this, jreader));
        jreader.onLobbyUpdate(this.handleLobbyUpdate.bind(this, jreader));
        jreader.onLobbyPreview(this.handleLobbyPreview.bind(this, jreader));
        jreader.onLobbyListCount(this.handleLobbyListCount.bind(this, jreader));
        jreader.onFeedEnd(this.handleFeedEnd.bind(this, jreader));
    }

    async proceed(timeout: number = -1): Promise<JournalEvent> {
        let breakloop = false;
        let tim: NodeJS.Timer;
        if (timeout >= 0) {
            tim = setTimeout(() => {
                breakloop = true;
                tim = void 0;
            }, timeout);
        }

        while (!breakloop) {
            while (this.eventQueue.length) {
                return this.eventQueue.shift();
            }
            if (this.closed || !this.gtracks.size) return;

            const activeGtracks = Array.from(this.gtracks.values());
            let result = (await Promise.all(activeGtracks.map(async v => {
                return [v, await v.peek()] as [JournalReader, SignalDesc];
            }))).filter(v => v[1]);
            if (result.length > 1) {
                result = result.sort((a, b) => a[1].$timestamp - b[1].$timestamp);
            }

            if (!result.length) {
                await sleep(10);
                continue;
            }
            if (tim) {
                tim.refresh();
            }

            await result[0][0].next();
            this.currentDate = result[0][0].dateFromEvent(result[0][1]);
        }

        if (tim) {
            clearTimeout(tim);
            tim = void 0;
            // TODO: throw timeout exception?
        }

        return;
    }
}
