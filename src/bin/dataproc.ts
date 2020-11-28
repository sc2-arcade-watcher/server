import * as orm from 'typeorm';
import type lruFactory from 'tiny-lru';
const lru: typeof lruFactory = require('tiny-lru');
import { JournalReader, JournalMultiProcessor, JournalEventKind, JournalEventNewLobby, JournalEventCloseLobby, GameLobbyStatus, JournalEventUpdateLobbySnapshot, JournalEventUpdateLobbyList, GameLobbyDesc, JournalEventUpdateLobbySlots, JournalEventBase } from '../gametracker';
import { JournalFeed } from '../journal/feed';
import { S2GameLobby } from '../entity/S2GameLobby';
import { S2Region } from '../entity/S2Region';
import { logger, logIt, setupFileLogger } from '../logger';
import { S2GameLobbySlot, S2GameLobbySlotKind } from '../entity/S2GameLobbySlot';
import { SysFeedProvider } from '../entity/SysFeedProvider';
import { sleep, isErrDuplicateEntry, systemdNotifyReady, setupProcessTerminator } from '../helpers';
import { DataLobbyCreate, LobbyPvExSlotKind } from '../journal/decoder';
import { SysFeedPosition } from '../entity/SysFeedPosition';
import { S2Profile } from '../entity/S2Profile';
import { S2GameLobbyPlayerJoin } from '../entity/S2GameLobbyPlayerJoin';
import { S2GameLobbyMap, S2GameLobbyMapKind } from '../entity/S2GameLobbyMap';
import { S2MapVariant } from '../entity/S2MapVariant';
import { S2GameLobbyTitle } from '../entity/S2GameLobbyTitle';
import { oneLine } from 'common-tags';
import { BnAccount } from '../entity/BnAccount';
import { differenceInSeconds } from 'date-fns';
import { GameRegion } from '../common';
import { S2ProfileTracking } from '../entity/S2ProfileTracking';
import { S2ProfileRepository } from '../repository/S2ProfileRepository';
import { S2ProfileTrackingRepository } from '../repository/S2ProfileTrackingRepository';

const slotKindMap = {
    [LobbyPvExSlotKind.Computer]: S2GameLobbySlotKind.AI,
    [LobbyPvExSlotKind.Open]: S2GameLobbySlotKind.Open,
    [LobbyPvExSlotKind.Human]: S2GameLobbySlotKind.Human,
};

type FeedCheckpointMeta = {
    resumeOffsetUpdatedAt: Date;
    resumeEventPointer: JournalEventBase | null;

    storageOffsetUpdatedAt: Date;
    storageEventPointer: JournalEventBase | null;
};

class DataProc {
    protected journalProc = new JournalMultiProcessor(this.region);
    protected s2region: S2Region;
    protected feedProviders = new Map<string, SysFeedProvider>();
    protected feedCheckpointMeta = new Map<string, FeedCheckpointMeta>();
    protected closed = false;

    protected lobbiesCache = lru<S2GameLobby>(0);
    protected bnAccountsCache = lru<BnAccount>(200);
    protected profilesCache = lru<S2Profile>(3000, 1000 * 3600 * 24);
    protected mapVariantsCache = lru<string>(4000, 1000 * 3600);

    protected lobbiesReopenCandidates = new Set();

    constructor(
        protected readonly conn: orm.Connection,
        public readonly region: GameRegion
    ) {
    }

    @logIt()
    async open() {
        this.s2region = await this.conn.getRepository(S2Region).findOne({
            where: {
                id: this.region,
            },
        });
        this.feedProviders = new Map((await this.conn.getRepository(SysFeedProvider).find({
            where: {
                region: this.s2region,
                enabled: true,
            },
        })).map(x => [`${x.name}-${x.region.code}`, x]));

        for (const [name, item] of this.feedProviders) {
            const lbfeedDir = process.env['STARC_LBFEED_DIR'] || 'data/lbstream';
            const feed = new JournalFeed(`${lbfeedDir}/${name}`, {
                initCursor: {
                    session: item.position.resumingFile,
                    // offset: item.position.resumingOffset,
                    offset: 0,
                },
            });
            this.feedCheckpointMeta.set(name, {
                resumeOffsetUpdatedAt: new Date(),
                resumeEventPointer: null,
                storageOffsetUpdatedAt: new Date(),
                storageEventPointer: null,
            });
            this.journalProc.addFeedSource(feed);
        }
    }

    protected async shutdown() {
        await this.storeFeedCheckpoints();
    }

    async close() {
        if (this.closed) return;
        logger.info(`closing..`);
        this.closed = true;
        await this.journalProc.close();
    }

    async work() {
        while (!this.closed) {
            const ev = await this.journalProc.proceed();
            if (!ev) break;

            const feedPos = this.feedProviders.get(ev.feedName).position;
            if (ev.feedCursor.session <= feedPos.storageFile && ev.feedCursor.offset < feedPos.storageOffset) {
                continue;
            }

            try {
                switch (ev.kind) {
                    case JournalEventKind.NewLobby: {
                        await this.onNewLobby(ev);
                        break;
                    }
                    case JournalEventKind.CloseLobby: {
                        await this.onCloseLobby(ev);
                        await this.updateResumingOffset(ev);
                        break;
                    }
                    case JournalEventKind.UpdateLobbySnapshot: {
                        await this.onUpdateLobbySnapshot(ev);
                        break;
                    }
                    case JournalEventKind.UpdateLobbySlots: {
                        await this.onUpdateLobbySlots(ev);
                        break;
                    }
                }
                if (ev.kind === JournalEventKind.UpdateLobbyList) {
                    await this.updateStorageOffset(ev);
                }
            }
            catch (err) {
                logger.error(`@${JournalEventKind[ev.kind]}:`, err, ev);
                await this.close();
                await this.storeFeedCheckpoints();
                throw new Error(`@${JournalEventKind[ev.kind]} ${(err as Error)?.message} ${ev.feedName} ${ev.feedCursor}`);
            }
        }

        await this.storeFeedCheckpoints();
    }

    protected async storeFeedCheckpoints() {
        const procedures = Array.from(this.feedCheckpointMeta.entries()).map(async (item) => {
            const [name, fcMeta] = item;
            if (fcMeta.resumeEventPointer !== null) {
                await this.updateResumingOffset(fcMeta.resumeEventPointer, true);
            }
            if (fcMeta.storageEventPointer !== null) {
                await this.updateStorageOffset(fcMeta.storageEventPointer, true);
            }
        });
        await Promise.all(procedures);
    }

    protected async updateStorageOffset(ev: JournalEventBase, force = false) {
        const fcMeta = this.feedCheckpointMeta.get(ev.feedName);
        fcMeta.storageEventPointer = ev;

        if (!force && differenceInSeconds(new Date(), fcMeta.storageOffsetUpdatedAt) < 60) return;

        const feedProvider = this.feedProviders.get(ev.feedName);
        const feedPos = feedProvider.position;

        if (feedPos.storageFile < ev.feedCursor.session || feedPos.storageOffset < ev.feedCursor.offset) {
            const pf = logger.startTimer();
            feedPos.storageFile = ev.feedCursor.session;
            feedPos.storageOffset = ev.feedCursor.offset;
            await this.conn.getRepository(SysFeedPosition).update(feedProvider.id, {
                storageFile: ev.feedCursor.session,
                storageOffset: ev.feedCursor.offset,
            });
            fcMeta.storageEventPointer = null;
            pf.done({ level: 'verbose', message: `src=${ev.feedName} updateStorageOffset` });
        }
        fcMeta.storageOffsetUpdatedAt = new Date();
    }

    protected async updateResumingOffset(ev: JournalEventBase, force = false) {
        const fcMeta = this.feedCheckpointMeta.get(ev.feedName);
        fcMeta.resumeEventPointer = ev;

        if (!force && differenceInSeconds(new Date(), fcMeta.resumeOffsetUpdatedAt) < 100) return;

        const feedProvider = this.feedProviders.get(ev.feedName);
        const feedPos = feedProvider.position;

        const cursorResume = this.journalProc.gtracks.get(ev.feedName).cursorResumePointer;
        if (feedPos.resumingFile < cursorResume.session || feedPos.resumingOffset < cursorResume.offset) {
            const pf = logger.startTimer();
            feedPos.resumingFile = cursorResume.session;
            feedPos.resumingOffset = cursorResume.offset;
            await this.conn.getRepository(SysFeedPosition).update(feedProvider.id, {
                resumingFile: cursorResume.session,
                resumingOffset: cursorResume.offset,
            });
            fcMeta.resumeEventPointer = null;
            pf.done({ level: 'verbose', message: `src=${ev.feedName} updateResumingOffset` });
        }
        fcMeta.resumeOffsetUpdatedAt = new Date();
    }

    protected async getLobby(lobby: GameLobbyDesc) {
        let s2lobby = this.lobbiesCache.get(lobby.initInfo.lobbyId.toString());
        if (!s2lobby) {
            s2lobby = await this.conn.getRepository(S2GameLobby)
                .createQueryBuilder('lobby')
                .leftJoinAndSelect('lobby.slots', 'slots')
                .leftJoinAndSelect('lobby.titleHistory', 'titleHistory')
                .leftJoinAndSelect('lobby.joinHistory', 'joinHistory')
                .leftJoinAndSelect('joinHistory.profile', 'joinHistoryProfile')
                .andWhere('lobby.regionId = :regionId AND lobby.bnetBucketId = :bnetBucketId AND lobby.bnetRecordId = :bnetRecordId', {
                    regionId: this.s2region.id,
                    bnetBucketId: lobby.initInfo.bucketId,
                    bnetRecordId: lobby.initInfo.lobbyId,
                })
                .addOrderBy('slots.slotNumber', 'ASC')
                .addOrderBy('titleHistory.date', 'ASC')
                .addOrderBy('joinHistory.id', 'ASC')
                .getOne()
            ;

            if (!s2lobby) return;

            // populate local cache with profile instances that have been fetched
            s2lobby.joinHistory.forEach(joinInfo => {
                const profKey = `${joinInfo.profile.realmId}-${joinInfo.profile.profileId}`;
                if (!this.profilesCache.has(profKey)) {
                    this.profilesCache.set(profKey, joinInfo.profile);
                }
                else {
                    // replace fetched instance with cached one
                    joinInfo.profile = this.profilesCache.get(profKey);
                }
            });

            // bind shared entities manually to ensure we're using the same instances within the scope of GameLobby object
            s2lobby.slots.forEach(slot => {
                if (!slot.joinInfoId && !slot.profileId) return;

                slot.joinInfo = s2lobby.joinHistory.find(x => x.id === slot.joinInfoId);
                if (!slot.joinInfo) {
                    throw new Error(`couldn't find a matching joinInfo for lobby=${s2lobby.id} slotNumer=${slot.slotNumber}`);
                }
                delete slot.joinInfoId;

                slot.profile = slot.joinInfo.profile;
                if (slot.profile.id !== slot.profileId) {
                    throw new Error(`profile missmatch in joinInfo for lobby=${s2lobby.id} slotNumer=${slot.slotNumber}`);
                }
                delete slot.profileId;
            });

            this.lobbiesCache.set(lobby.initInfo.lobbyId.toString(), s2lobby);
        }
        return s2lobby;
    }

    protected async updateLobby(s2lobby: S2GameLobby, updateData: Partial<S2GameLobby>) {
        Object.assign(s2lobby, updateData);
        await this.conn.getRepository(S2GameLobby).update(s2lobby.id, updateData);
    }

    protected async updateProfileLastOnline(s2profiles: S2Profile[], nLastOnline: Date) {
        const joinTime = new Date(nLastOnline);
        joinTime.setMilliseconds(0);
        const newlyJoined = s2profiles.filter(x => joinTime > x.lastOnlineAt);
        if (newlyJoined.length > 0) {
            newlyJoined.forEach(x => { x.lastOnlineAt = nLastOnline; });
            await this.conn.getRepository(S2Profile).update(newlyJoined.map(x => x.id), {
                lastOnlineAt: nLastOnline,
            });
        }
    }

    protected async updateLobbyTitleOrigin(s2lobby: S2GameLobby, lobbyData: GameLobbyDesc, tsManager: orm.EntityManager) {
        if (!s2lobby.slots.length) {
            // TODO: could try to determine missing profile using accountId
            return;
        }

        const recentTitle = s2lobby.titleHistory[s2lobby.titleHistory.length - 1];
        const tdiff = lobbyData.slotsPreviewUpdatedAt.getTime() - recentTitle.date.getTime();
        if (
            recentTitle.profileId === null &&
            lobbyData.lobbyNameMeta?.title === recentTitle.title &&
            lobbyData.lobbyNameMeta?.accountId === recentTitle.accountId
        ) {
            const matchedSlots = s2lobby.slots.filter(x => x.kind === S2GameLobbySlotKind.Human && x.name === recentTitle.hostName);
            const matchedPlSlots = matchedSlots.filter(x => x.profile !== null);
            const isInitialTitle = s2lobby.titleHistory.length === 1 && lobbyData.initInfo.lobbyName === recentTitle.title;

            // attempt to pair profile with account
            if (
                recentTitle.accountId !== null &&
                isInitialTitle && lobbyData.initInfo.slotsHumansTaken === 1 &&
                s2lobby.sumSlots.human === 1 &&
                matchedSlots.length === 1 && matchedPlSlots.length === 1 &&
                tdiff >= 0 && tdiff <= 3000
            ) {
                // as long as Battle.net API is working, this isn't needed
                // await this.profileConnectWithAcc(s2lobby, recentTitle, matchedPlSlots[0], tsManager);
            }

            // determine profile of player who changed lobby title
            // try by name looking in slots
            if ((matchedPlSlots.length >= 1 && isInitialTitle) || matchedPlSlots.length === 1) {
                recentTitle.profileId = matchedPlSlots[0].profile.id;
            }
            else if (recentTitle.accountId !== null) {
                // try by looking for profiles already associated with this account
                if (recentTitle.profileId === null) {
                    const accProfiles = await this.conn.getCustomRepository(S2ProfileRepository).findByBattleAccount(
                        recentTitle.accountId,
                        { regionId: this.region }
                    );

                    if (accProfiles.length === 1) {
                        const finalMatch = accProfiles[accProfiles.length - 1];
                        recentTitle.profileId = finalMatch.id;
                        logger.verbose(oneLine`
                            ${s2lobby.globalId}
                            determined profile ${finalMatch.nameAndId} of host "${recentTitle.hostName}" using accountId
                        `);
                        if (finalMatch.name === recentTitle.hostName) {
                            // TODO: recover missing profile links on player slots if name matches?
                            // s2lobby.slots.find(x => x.kind === S2GameLobbySlotKind.Human && !x.profile && x.name === finalMatch.name);
                        }
                        else {
                            logger.warn(`${s2lobby.globalId} name missmatch on determined profile of a host`);
                        }
                    }
                }
            }

            if (recentTitle.profileId) {
                logger.verbose(oneLine`
                    ${s2lobby.globalId}
                    lobby title
                    [${s2lobby.titleHistory.length}] T="${recentTitle.title}"
                    A=${recentTitle.accountId} P=${recentTitle.profileId}
                    M=${matchedSlots.map(x => x.profile ? x.profile.nameAndId : x.name).join()}
                `);
                await tsManager.getRepository(S2GameLobbyTitle).update({
                    date: recentTitle.date,
                    lobbyId: recentTitle.lobbyId,
                }, {
                    profileId: recentTitle.profileId,
                });
            }
        }
    }

    protected hasNewSlotData(s2lobby: S2GameLobby, lobbyData: GameLobbyDesc) {
        const reversedHistory: S2GameLobbyPlayerJoin[] = [].concat(s2lobby.joinHistory).reverse();

        // determine if there are any new players
        for (const updatedSlot of lobbyData.slots) {
            if (slotKindMap[updatedSlot.kind] !== S2GameLobbySlotKind.Human) continue;

            const prevJoinInfo = reversedHistory.find(x => {
                return x.profile.realmId === updatedSlot.profile.realmId && x.profile.profileId === updatedSlot.profile.profileId;
            });

            // new player that hasn't been seen in this lobby, exit early and proceed with update
            if (!prevJoinInfo) {
                return true;
            }

            // skip known player if they're still in the lobby
            if (prevJoinInfo.leftAt === null) {
                continue;
            }

            // skip known player if it matches the last join record
            // meaning it's the same update event, just with newer timestamp - nothing to update
            if (reversedHistory[reversedHistory.length - 1] === prevJoinInfo) {
                continue;
            }

            // this could probably be removed
            const tdiff = lobbyData.slotsPreviewUpdatedAt.getTime() - prevJoinInfo.leftAt.getTime();
            const humanSlotsNumber = lobbyData.slots.filter(x => x.kind === LobbyPvExSlotKind.Human).length;
            const openSlotsNumber = lobbyData.slots.filter(x => x.kind === LobbyPvExSlotKind.Open).length;
            if (
                lobbyData.slotsPreviewUpdatedAt > prevJoinInfo.joinedAt &&
                humanSlotsNumber > 0 &&
                (s2lobby.slots.length === 0 || s2lobby.slots.length === lobbyData.slots.length) &&
                (
                    (humanSlotsNumber >= 2 && tdiff > 0) ||
                    (humanSlotsNumber === 1 && (tdiff > 30000 || openSlotsNumber === 0))
                )
            ) {
                logger.verbose(`${s2lobby.globalId} candidate valid for reopen, data might be fresh`, {
                    prevJoinInfo,
                    tdiff,
                    humanSlotsNumber,
                    openSlotsNumber,
                });
                return true;
            }
        }

        // determine if slot layout is the same
        if (s2lobby.slots.length > 0) {
            if (s2lobby.slots.length !== lobbyData.slots.length) {
                logger.warn(`${s2lobby.globalId} candidate to re-open missmaching slots, ignoring.`, {
                    prev: s2lobby.slots,
                    new: lobbyData.slots,
                });
            }
            else {
                // dissect, check order of slots, team numbers and amount of slots taken by AI
                const newSlotLayout = lobbyData.slots.map((item, index) => {
                    return {
                        kind: slotKindMap[item.kind],
                        team: item.team,
                        slotNumber: index + 1,
                        name: item.name,
                    };
                });
                const diffSlots = newSlotLayout.filter((x, index) => {
                    return (
                        x.kind !== s2lobby.slots[index].kind ||
                        x.team !== s2lobby.slots[index].team ||
                        x.slotNumber !== s2lobby.slots[index].slotNumber
                    );
                });

                if (diffSlots.length > 0)  {
                    logger.verbose(`${s2lobby.globalId} candidate valid for reopen, slot layout differs`, {
                        newSlots: diffSlots,
                        oldSlots: s2lobby.slots.filter(x => diffSlots.find(y => y.slotNumber === x.slotNumber)).map(x => {
                            const o = Object.assign({}, x);
                            delete o.joinInfo;
                            return o;
                        }),
                    });
                    return true;
                }
            }
        }

        return false;
    }

    @logIt({ when: 'out', profTime: true })
    protected async doUpdateSlots(s2lobby: S2GameLobby, lobbyData: GameLobbyDesc, ev: JournalEventBase) {
        if (!lobbyData.slots || lobbyData.slotsPreviewUpdatedAt <= s2lobby.slotsUpdatedAt) return false;

        if (s2lobby.closedAt !== null) {
            if (!this.hasNewSlotData(s2lobby, lobbyData)) return false;
        }

        if (s2lobby.slots.length !== lobbyData.slots.length) {
            if (s2lobby.slots.length > 0) {
                logger.warn(`updated available slots ${s2lobby.globalId} prevSlotCount=${s2lobby.slots.length} newSlotCount=${lobbyData.slots.length}`, s2lobby.slots, lobbyData.slots, ev);
            }
            if (s2lobby.slots.length > lobbyData.slots.length) {
                const removedSlots = s2lobby.slots.splice(lobbyData.slots.length);
                const removedOccupiedSlots = removedSlots.filter(s2slot => s2slot.joinInfo);
                if (removedOccupiedSlots.length) {
                    logger.warn(`occupied slots have been removed?!`, ev, removedOccupiedSlots);
                    await this.conn.getRepository(S2GameLobbyPlayerJoin).update(
                        removedOccupiedSlots.map(s2slot => s2slot.joinInfo.id),
                        {
                            leftAt: lobbyData.slotsPreviewUpdatedAt,
                        }
                    );
                }
                await this.conn.getRepository(S2GameLobbySlot).delete(removedSlots.map(x => x.id));
            }
            else {
                const addedSlots = lobbyData.slots.map((infoSlot, idx) => {
                    if (idx < s2lobby.slots.length) {
                        return void 0;
                    }
                    const s2slot = new S2GameLobbySlot();
                    Object.assign(s2slot, {
                        lobby: s2lobby,
                        slotNumber: idx + 1,
                        team: infoSlot.team,
                        kind: S2GameLobbySlotKind.Open,
                    } as S2GameLobbySlot);
                    return s2slot;
                }).filter(x => x !== void 0);

                await this.conn.getRepository(S2GameLobbySlot).insert(addedSlots);
                s2lobby.slots.push(...addedSlots);
            }
        }
        else {
            const affectedSlots = lobbyData.slots.filter((infoSlot, idx) => {
                const s2slot = s2lobby.slots[idx];
                if (slotKindMap[infoSlot.kind] !== s2slot.kind) return true;
                if (infoSlot.team !== s2slot.team) return true;
                if (infoSlot.name !== s2slot.name) return true;
                if (infoSlot.profile?.realmId !== s2slot.profile?.realmId || infoSlot.profile?.profileId !== s2slot.profile?.profileId) return true;
            });
            if (!affectedSlots.length) return false;
        }

        const newS2profiles = await Promise.all(lobbyData.slots.map(slot => {
            if (!slot.profile) return null;
            return this.fetchOrCreateProfile(slot.profile, lobbyData.slotsPreviewUpdatedAt);
        }));

        const updatedSlots: S2GameLobbySlot[] = [];
        await this.conn.transaction(async tsManager => {
            const playerLeaveInfo = new Map<string, S2GameLobbyPlayerJoin>();

            await Promise.all(lobbyData.slots.map(async (infoSlot, idx) => {
                const s2slot = s2lobby.slots[idx];
                if (idx !== (s2slot.slotNumber - 1)) {
                    logger.error('slotNumber missmatch - not in order?', idx, s2slot.slotNumber, s2slot, infoSlot, s2lobby, lobbyData);
                    throw new Error('slotNumber missmatch - not in order?');
                }
                const newS2SlotKind = slotKindMap[infoSlot.kind];
                if (newS2SlotKind !== s2slot.kind || infoSlot.name !== s2slot.name || infoSlot.team !== s2slot.team) {
                    if (
                        s2slot.joinInfo &&
                        (
                            !infoSlot.profile ||
                            infoSlot.profile.realmId !== s2slot.joinInfo.profile.realmId ||
                            infoSlot.profile.profileId !== s2slot.joinInfo.profile.profileId
                        )
                    ) {
                        playerLeaveInfo.set(`${s2slot.joinInfo.profile.realmId}-${s2slot.joinInfo.profile.profileId}`, s2slot.joinInfo);
                        s2slot.joinInfo = null;
                    }

                    if (!s2slot.joinInfo && newS2profiles[idx]) {
                        const pkey = `${newS2profiles[idx].realmId}-${newS2profiles[idx].profileId}`;
                        s2slot.joinInfo = playerLeaveInfo.get(pkey);
                        if (s2slot.joinInfo) {
                            playerLeaveInfo.delete(pkey);
                        }
                        else {
                            const joinInfoSlotIdx = s2lobby.slots.findIndex(x => x.joinInfo && x.joinInfo.profile.realmId === newS2profiles[idx].realmId && x.joinInfo.profile.profileId === newS2profiles[idx].profileId);
                            if (joinInfoSlotIdx !== -1) {
                                s2slot.joinInfo = s2lobby.slots[joinInfoSlotIdx].joinInfo;
                                s2lobby.slots[joinInfoSlotIdx].joinInfo = null;
                            }
                            else {
                                s2slot.joinInfo = new S2GameLobbyPlayerJoin();
                                s2slot.joinInfo.lobby = s2lobby;
                                s2slot.joinInfo.profile = newS2profiles[idx];
                                s2slot.joinInfo.joinedAt = lobbyData.slotsPreviewUpdatedAt;
                                s2lobby.joinHistory.push(s2slot.joinInfo);
                                await tsManager.getRepository(S2GameLobbyPlayerJoin).insert(s2slot.joinInfo);
                            }
                        }
                    }

                    const changedData: Partial<S2GameLobbySlot> = {
                        team: infoSlot.team,
                        kind: newS2SlotKind,
                        profile: newS2profiles[idx],
                        name: infoSlot.name,
                        joinInfo: s2slot.joinInfo,
                    };
                    Object.assign(s2slot, changedData);
                    updatedSlots.push(s2slot);
                    return tsManager.getRepository(S2GameLobbySlot).update(s2slot.id, changedData);
                }
            }));

            if (playerLeaveInfo.size) {
                const pks = Array.from(playerLeaveInfo.values()).map(x => x.id);
                await tsManager.getRepository(S2GameLobbyPlayerJoin).update(pks, {
                    leftAt: lobbyData.slotsPreviewUpdatedAt,
                });
            }

            if (s2lobby.titleHistory.length > 0) {
                await this.updateLobbyTitleOrigin(s2lobby, lobbyData, tsManager);
            }

            s2lobby.slotsUpdatedAt = lobbyData.slotsPreviewUpdatedAt;
            await tsManager.getRepository(S2GameLobby).update(s2lobby.id, {
                slotsUpdatedAt: lobbyData.slotsPreviewUpdatedAt,
            });
        });

        if (updatedSlots.length > 0) {
            await this.updateProfileLastOnline(updatedSlots.filter(x => x.profile).map(x => x.profile), lobbyData.slotsPreviewUpdatedAt);
        }

        return updatedSlots.length;
    }

    protected async fetchOrCreateBnAccount(accountId: number) {
        const key = accountId.toString();
        let bnAccount = this.bnAccountsCache.get(key);
        if (!bnAccount) {
            bnAccount = await this.conn.getRepository(BnAccount).findOne(accountId, {
                relations: ['profileLinks'],
            });
            if (!bnAccount) {
                bnAccount = this.conn.getRepository(BnAccount).create({
                    id: accountId,
                });
                await this.conn.getRepository(BnAccount).insert(bnAccount);
            }
            this.bnAccountsCache.set(key, bnAccount);
        }
        return bnAccount;
    }

    async fetchOrCreateProfile(infoProfile: Pick<S2Profile, 'regionId' | 'realmId' | 'profileId' | 'name' | 'discriminator'>, updatedAt: Date) {
        const profKey = `${infoProfile.realmId}-${infoProfile.profileId}`;
        let s2profile = this.profilesCache.get(profKey);
        if (!s2profile) {
            s2profile = await this.conn.getCustomRepository(S2ProfileRepository).fetchOrCreate(infoProfile);
            this.profilesCache.set(profKey, s2profile);
        }

        if (s2profile.name !== infoProfile.name || s2profile.discriminator !== infoProfile.discriminator) {
            // before changing name ensure we're not process some stale data, where new name isn't actually new
            const pTrack = await this.conn.getCustomRepository(S2ProfileTrackingRepository).fetchOrCreate(infoProfile);
            if (pTrack.nameUpdatedAt < updatedAt) {
                logger.verbose(`updating profile ${s2profile.fullname} => ${infoProfile.name}#${infoProfile.discriminator} [${s2profile.phandle}]`);
                const updateData: Partial<S2Profile> = {
                    name: infoProfile.name,
                    discriminator: infoProfile.discriminator,
                };
                Object.assign(s2profile, updateData);
                pTrack.nameUpdatedAt = updatedAt;

                await this.conn.transaction(async tsManager => {
                    await tsManager.getRepository(S2Profile).update(s2profile.id, updateData);
                    await tsManager.getRepository(S2ProfileTracking).update(s2profile.id, {
                        nameUpdatedAt: pTrack.nameUpdatedAt,
                    });
                });
            }
        }

        return s2profile;
    }

    async fetchMapVariant(regionId: number, mapId: number, variantIndex: number) {
        const key = `${regionId}/${mapId}:${variantIndex}`;
        let mapVariant = this.mapVariantsCache.get(key);
        if (!mapVariant) {
            const result = await this.conn.getRepository(S2MapVariant).createQueryBuilder('mapVariant')
                .select('mapVariant.name', 'name')
                .innerJoin('mapVariant.map', 'map')
                .andWhere('map.regionId = :regionId AND map.bnetId = :bnetId AND mapVariant.variantIndex = :variantIndex', {
                    regionId: regionId,
                    bnetId: mapId,
                    variantIndex: variantIndex,
                })
                .getRawOne()
            ;

            if (result) {
                mapVariant = result.name;
                this.mapVariantsCache.set(key, mapVariant);
            }
        }
        return mapVariant;
    }

    @logIt({ when: 'out', profTime: true })
    async onNewLobby(ev: JournalEventNewLobby) {
        const info = ev.lobby.initInfo;

        const mapVariantName = await this.fetchMapVariant(this.s2region.id, info.mapHandle[0], info.mapVariantIndex);

        let s2lobby = new S2GameLobby();
        Object.assign(s2lobby, <S2GameLobby>{
            regionId: this.s2region.id,
            bnetBucketId: info.bucketId,
            bnetRecordId: info.lobbyId,
            createdAt: ev.lobby.createdAt,
            closedAt: null,
            status: GameLobbyStatus.Open,

            snapshotUpdatedAt: ev.lobby.snapshotUpdatedAt,
            slotsUpdatedAt: null,

            mapBnetId: info.mapHandle[0],
            extModBnetId: info.extModHandle[0] !== 0 ? info.extModHandle[0] : null,
            multiModBnetId: info.multiModHandle[0] !== 0 ? info.multiModHandle[0] : null,

            mapVariantIndex: info.mapVariantIndex,
            mapVariantMode: mapVariantName ?? '',

            lobbyTitle: ev.lobby.lobbyName,
            hostName: ev.lobby.hostName,
            slotsHumansTaken: ev.lobby.slotsHumansTaken,
            slotsHumansTotal: ev.lobby.slotsHumansTotal,

            slots: [],
            joinHistory: [],
            titleHistory: [],
        });

        const s2LobbyMaps: Partial<S2GameLobbyMap>[] = [];
        s2LobbyMaps.push({
            lobby: s2lobby,
            regionId: this.s2region.id,
            bnetId: info.mapHandle[0],
            type: S2GameLobbyMapKind.Map,
        });
        if (info.extModHandle[0] !== 0) {
            s2LobbyMaps.push({
                lobby: s2lobby,
                regionId: this.s2region.id,
                bnetId: info.extModHandle[0],
                type: S2GameLobbyMapKind.ExtensionMod,
            });
        }
        if (info.multiModHandle[0] !== 0) {
            s2LobbyMaps.push({
                lobby: s2lobby,
                regionId: this.s2region.id,
                bnetId: info.multiModHandle[0],
                type: S2GameLobbyMapKind.MultiMod,
            });
        }

        if (ev.lobby.lobbyNameMeta !== null) {
            const s2LobTitle = new S2GameLobbyTitle();
            s2LobTitle.date = ev.lobby.lobbyNameMeta.changedAt;
            s2LobTitle.title = ev.lobby.lobbyNameMeta.title;
            s2LobTitle.hostName = ev.lobby.lobbyNameMeta.profileName;
            s2LobTitle.profileId = null;
            s2LobTitle.accountId = ev.lobby.lobbyNameMeta.accountId;
            s2lobby.titleHistory.push(s2LobTitle);

            if (ev.lobby.lobbyNameMeta.accountId !== null) {
                await this.fetchOrCreateBnAccount(ev.lobby.lobbyNameMeta.accountId);
            }
        }

        try {
            await this.conn.transaction(async tsManager => {
                await tsManager.getRepository(S2GameLobby).insert(s2lobby);
                await tsManager.getRepository(S2GameLobbyMap).insert(s2LobbyMaps);
                s2lobby.titleHistory.forEach(x => {
                    x.lobbyId = s2lobby.id;
                });
                await tsManager.getRepository(S2GameLobbyTitle).insert(s2lobby.titleHistory);
            });

            this.lobbiesCache.set(info.lobbyId.toString(), s2lobby);
            logger.info(`NEW src=${ev.feedName} ${s2lobby.globalId} map=${s2lobby.mapBnetId}`);
        }
        catch (err) {
            if (isErrDuplicateEntry(err)) {
                s2lobby = await this.getLobby(ev.lobby);
                if (!s2lobby) {
                    throw err;
                }
                if (s2lobby.status !== GameLobbyStatus.Open) {
                    const snapshotTimeDiff = ev.lobby.snapshotUpdatedAt.getTime() - s2lobby.snapshotUpdatedAt.getTime();
                    this.lobbiesReopenCandidates.add(s2lobby.id);
                    logger.verbose(oneLine`
                        src=${ev.feedName} ${s2lobby.globalId}
                        reappeared ${s2lobby.createdAt.toISOString()}
                        stdiff=${snapshotTimeDiff}
                    `);
                }
            }
            else {
                throw err;
            }
        }
    }

    @logIt({ when: 'out', profTime: true })
    async onCloseLobby(ev: JournalEventCloseLobby) {
        const s2lobby = await this.getLobby(ev.lobby);
        if (!s2lobby) return;

        // discard candidate and exit without altering any data
        if (this.lobbiesReopenCandidates.has(s2lobby.id)) {
            this.lobbiesReopenCandidates.delete(s2lobby.id);
            this.lobbiesCache.delete(s2lobby.id.toString());
            return;
        }

        // verify if anything has changed in a closed lobby which has reappeared
        if (s2lobby.status !== GameLobbyStatus.Open) {
            if (s2lobby.status === GameLobbyStatus.Unknown && ev.lobby.status !== GameLobbyStatus.Unknown) {
                logger.warn(`src=${ev.feedName} ${s2lobby.globalId} reopening lobby with status=${s2lobby.status}`);
                await this.updateLobby(s2lobby, {
                    closedAt: null,
                    status: GameLobbyStatus.Open,

                    snapshotUpdatedAt: ev.lobby.snapshotUpdatedAt,
                    hostName: ev.lobby.hostName,
                    lobbyTitle: ev.lobby.lobbyName,
                    slotsHumansTaken: ev.lobby.slotsHumansTaken,
                    slotsHumansTotal: ev.lobby.slotsHumansTotal,
                });
            }
            else {
                const closeDiff = s2lobby.closedAt.getTime() - ev.lobby.closedAt.getTime();
                if (closeDiff !== 0) {
                    logger.verbose(`src=${ev.feedName} ${s2lobby.globalId} attempted to close lobby which has its state already determined`);
                }
                this.lobbiesCache.delete(ev.lobby.initInfo.lobbyId.toString());
                return;
            }
        }

        await this.doUpdateSlots(s2lobby, ev.lobby, ev);
        if (s2lobby.titleHistory.length > 0) {
            await this.updateLobbyTitleOrigin(s2lobby, ev.lobby, this.conn.manager);
        }
        if (
            (ev.lobby.status !== GameLobbyStatus.Started && s2lobby.slots.length)
        ) {
            await this.conn.getRepository(S2GameLobbyPlayerJoin).createQueryBuilder()
                .update()
                .set({ leftAt: ev.lobby.closedAt })
                .andWhere('leftAt IS NULL')
                .andWhere('lobby = :lobbyId')
                .setParameter('lobbyId', s2lobby.id)
                .execute()
            ;
            // TODO: cleanup slot records instead of deleting
            await this.conn.getRepository(S2GameLobbySlot).createQueryBuilder()
                .delete()
                .andWhere('lobby = :lobbyId')
                .setParameter('lobbyId', s2lobby.id)
                .execute()
            ;
        }
        else {
            await this.updateProfileLastOnline(s2lobby.slots.filter(x => x.profile).map(x => x.profile), ev.lobby.closedAt);
        }

        await this.updateLobby(s2lobby, {
            snapshotUpdatedAt: ev.lobby.snapshotUpdatedAt,
            closedAt: ev.lobby.closedAt,
            status: ev.lobby.status,
        });
        this.lobbiesCache.delete(ev.lobby.initInfo.lobbyId.toString());
        logger.info(`CLOSED src=${ev.feedName} ${s2lobby.globalId} ${ev.lobby.closedAt.toISOString()} status=${ev.lobby.status}`);
    }

    @logIt({ when: 'out', profTime: true })
    async onUpdateLobbySnapshot(ev: JournalEventUpdateLobbySnapshot) {
        const s2lobby = await this.getLobby(ev.lobby);
        if (!s2lobby) return;

        if (s2lobby.snapshotUpdatedAt > ev.lobby.snapshotUpdatedAt) return;

        // do not update data from snapshots on *closed* lobbies - it may happen when data feed from one of the runners arrives too late
        // thus it needs to be processed retroactively to fill eventual gaps in what has been already stored in database
        // wait till the Close event to determine if provided data actually affects anything
        if (s2lobby.status !== GameLobbyStatus.Open) {
            return;
        }

        // skip if there's nothing to update
        if (
            ev.lobby.lobbyName === s2lobby.lobbyTitle &&
            ev.lobby.hostName === s2lobby.hostName &&
            ev.lobby.slotsHumansTaken === s2lobby.slotsHumansTaken &&
            ev.lobby.slotsHumansTotal === s2lobby.slotsHumansTotal
        ) {
            return;
        }

        if (ev.lobby.lobbyNameMeta !== null && ev.lobby.lobbyName !== s2lobby.lobbyTitle) {
            const matchingTitleEntry = s2lobby.titleHistory.find(x => x.date.getTime() === ev.lobby.lobbyNameMeta.changedAt.getTime());
            if (!matchingTitleEntry) {
                const s2LobTitle = new S2GameLobbyTitle();
                s2LobTitle.date = ev.lobby.lobbyNameMeta.changedAt;
                s2LobTitle.lobbyId = s2lobby.id;
                s2LobTitle.title = ev.lobby.lobbyNameMeta.title;
                s2LobTitle.hostName = ev.lobby.lobbyNameMeta.profileName;
                s2LobTitle.profileId = null;
                s2LobTitle.accountId = ev.lobby.lobbyNameMeta.accountId;

                if (ev.lobby.lobbyNameMeta.accountId !== null) {
                    await this.fetchOrCreateBnAccount(ev.lobby.lobbyNameMeta.accountId);
                }

                await this.conn.getRepository(S2GameLobbyTitle).insert(s2LobTitle);
                s2lobby.titleHistory.push(s2LobTitle);

                await this.updateLobbyTitleOrigin(s2lobby, ev.lobby, this.conn.manager);
            }
        }

        await this.updateLobby(s2lobby, {
            snapshotUpdatedAt: ev.lobby.snapshotUpdatedAt,
            lobbyTitle: ev.lobby.lobbyName,
            hostName: ev.lobby.hostName,
            slotsHumansTaken: ev.lobby.slotsHumansTaken,
            slotsHumansTotal: ev.lobby.slotsHumansTotal,
        });
    }

    @logIt({ when: 'out', profTime: true })
    async onUpdateLobbySlots(ev: JournalEventUpdateLobbySlots) {
        const s2lobby = await this.getLobby(ev.lobby);
        if (!s2lobby) return;

        const slotsStatPrev = s2lobby.statSlots;
        const changed = await this.doUpdateSlots(s2lobby, ev.lobby, ev);
        if (changed !== false) {
            logger.info(oneLine`
                src=${ev.feedName} ${s2lobby.globalId} slots updated c=${changed}
                prev=${slotsStatPrev} curr=${s2lobby.statSlots}
            `);

            if (s2lobby.closedAt !== null) {
                logger.info(`src=${ev.feedName} ${s2lobby.globalId} lobby reopened`);
                await this.updateLobby(s2lobby, {
                    status: GameLobbyStatus.Open,
                    closedAt: null,

                    snapshotUpdatedAt: ev.lobby.snapshotUpdatedAt,
                    lobbyTitle: ev.lobby.lobbyName,
                    hostName: ev.lobby.hostName,
                    slotsHumansTaken: ev.lobby.slotsHumansTaken,
                    slotsHumansTotal: ev.lobby.slotsHumansTotal,
                });
                this.lobbiesReopenCandidates.delete(s2lobby.id);
            }
        }
    }

    async onUpdateLobbyList(ev: JournalEventUpdateLobbyList) {
    }
}

process.on('unhandledRejection', e => { throw e; });
async function run() {
    setupFileLogger('dataproc');

    let activeRegions = [
        GameRegion.US,
        GameRegion.EU,
        GameRegion.KR,
        GameRegion.CN,
    ];
    if (process.argv.length > 2) {
        const regionId = Number(process.argv[2]);
        if (!GameRegion[regionId]) {
            logger.error(`provided invalid region`);
            return;
        }
        activeRegions = [regionId];
    }

    const conn = await orm.createConnection();
    const workers = await Promise.all(activeRegions.map(async region => {
        const worker = new DataProc(conn, region);
        await worker.open();
        return worker;
    }));

    if (process.env.NOTIFY_SOCKET) {
        await systemdNotifyReady();
    }

    setupProcessTerminator(async () => {
        await Promise.all(workers.map(async x => {
            logger.info(`Closing worker ${GameRegion[x.region]}`);
            await x.close();
            logger.info(`Worker done ${GameRegion[x.region]}`);
        }));
    });

    await Promise.all(workers.map(x => x.work()));
    logger.info(`All workers exited`);
    await conn.close();
    logger.info(`Database connection closed`);
}

run();
