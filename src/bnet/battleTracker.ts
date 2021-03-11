import * as orm from 'typeorm';
import PQueue from 'p-queue';
import type lruFactory from 'tiny-lru';
const lru: typeof lruFactory = require('tiny-lru');
import { GameRegion, GameLobbyStatus } from '../common';
import { S2ProfileMatch, S2MatchType } from '../entity/S2ProfileMatch';
import { S2GameLobbyRepository } from '../repository/S2GameLobbyRepository';
import { S2GameLobbySlotKind, S2GameLobbySlot } from '../entity/S2GameLobbySlot';
import { logger, logIt } from '../logger';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileBattleTracking } from '../entity/S2ProfileBattleTracking';
import { sleep, TypedEvent } from '../helpers';
import { addSeconds, differenceInSeconds, differenceInMinutes, addHours, subHours, subSeconds } from 'date-fns';
import { S2LobbyMatch, S2LobbyMatchResult } from '../entity/S2LobbyMatch';
import { S2LobbyMatchProfile } from '../entity/S2LobbyMatchProfile';
import { S2Map } from '../entity/S2Map';
import { BattleProfileUpdater, getProfileLocalCacheKey, ProfileLocalParams } from './updater';
import { oneLine } from 'common-tags';
import { S2GameLobby } from '../entity/S2GameLobby';
import { ServiceProcess } from '../proc/process';
import { AppStorage } from '../entity/AppStorage';
import { AppStorageRepository } from '../repository/AppStorageRepository';

// can actually be more, due to game pauses
const battleMatchMaxSecs = 3600 * 9;

type BattlePartialS2Lobby = Pick<S2GameLobby,
    'id' |
    'status' |
    'regionId' |
    'bnetBucketId' |
    'bnetRecordId' |
    'mapBnetId' |
    'closedAt' |
    'slotsHumansTaken' |
    'slotsHumansTotal' |
    'slots' |
    'match'
>;

type BattleTrackedLobby = BattlePartialS2Lobby & {
    globalId: string;
    lastCheckedAt: Date | null;
    checkCounter: number;
    isStartConfirmed: boolean;
    players: number[];
};

interface BattleTrackedPlayerMHStatus {
    matchHistoryUpdatedAt: Date | null;
    lastMatchAt: Date | null;
    battleAPIErrorLast: Date | null;
    battleAPIErrorCounter: number;
}

interface BattleTrackedPlayer extends BattleTrackedPlayerMHStatus {
    recentMatches: {
        from: Date;
        to: Date;
        matches: S2ProfileMatch[];
    } | null;
}

export interface BattleCompletedLobbyPayload {
    lobby: BattleTrackedLobby;
    match: S2LobbyMatch;
}

export interface BattleMatchTrackerOptions {
    concurrency: number;
}

export class BattleMatchTracker {
    bProfileUpdater?: BattleProfileUpdater = void 0;
    protected trackedLobbies = new Map<number, BattleTrackedLobby>();
    protected trackedPlayers = lru<BattleTrackedPlayer>(10000, 1000 * 3600 * 4);

    protected _onLobbyComplete = new TypedEvent<BattleCompletedLobbyPayload>();
    readonly onLobbyComplete = this._onLobbyComplete.on.bind(this._onLobbyComplete);

    /** composite key of `mapId/profileCacheKey` */
    protected currentlyEvaluated = new Set<string>();

    public readonly taskQueue: PQueue;
    protected isRunning = false;

    constructor(protected conn: orm.Connection, options?: Partial<BattleMatchTrackerOptions>) {
        this.taskQueue = new PQueue({
            concurrency: options?.concurrency ?? 10,
        });
    }

    get trackedLobbiesCount(): number {
        return this.trackedLobbies.size;
    }

    get trackedLobbiesLowestId(): number {
        return Array.from(this.trackedLobbies.keys()).reduce((prev, curr) => prev > curr ? curr : prev);
    }

    async close() {
        logger.info(`Stopping ${this.constructor.name}.. queue=${this.taskQueue.size} pending=${this.taskQueue.pending}`);
        this.isRunning = false;
        this.taskQueue.clear();
        await this.taskQueue.onIdle();
        logger.info(`Stopped ${this.constructor.name} queue=${this.taskQueue.size} pending=${this.taskQueue.pending}`);
    }

    async onDone() {
        await this.taskQueue.onIdle();
    }

    protected async fetchPlayerMHStatus(params: ProfileLocalParams): Promise<BattleTrackedPlayerMHStatus> {
        return this.conn.getRepository(S2ProfileBattleTracking).createQueryBuilder('bTrack')
            .select([
                'bTrack.lastMatchAt',
                'bTrack.matchHistoryUpdatedAt',
                'bTrack.battleAPIErrorLast',
                'bTrack.battleAPIErrorCounter',
            ])
            .andWhere('bTrack.regionId = :regionId AND bTrack.localProfileId = :localProfileId', {
                regionId: params.regionId,
                localProfileId: params.localProfileId,
            })
            .limit(1)
            .getOne()
        ;
    }

    protected async getPlayerMatches(profParams: ProfileLocalParams, mapId: number, fromDate: Date, toDate: Date) {
        const cacheKey = getProfileLocalCacheKey(profParams);
        let tPlayer = this.trackedPlayers.get(cacheKey);
        if (!tPlayer) {
            tPlayer = {
                matchHistoryUpdatedAt: null,
                lastMatchAt: null,
                recentMatches: null,
                battleAPIErrorLast: null,
                battleAPIErrorCounter: 0,
            };
            this.trackedPlayers.set(cacheKey, tPlayer);
        }

        // - if we haven't acquired player match history info to begin with
        // - if we tried, but have not succeed
        // - if we might have the stale info - if it's within requested date range
        if (
            !tPlayer.matchHistoryUpdatedAt || tPlayer.matchHistoryUpdatedAt < toDate
        ) {
            let updatedMHStatus: BattleTrackedPlayerMHStatus;
            if (tPlayer.battleAPIErrorCounter > 5 && differenceInMinutes(Date.now(), tPlayer.battleAPIErrorLast) < 5) {
                // don't even try
            }
            else if (this.bProfileUpdater) {
                updatedMHStatus = await this.bProfileUpdater.updateProfileMatches(profParams, toDate);
                if (!tPlayer.lastMatchAt || tPlayer.lastMatchAt < updatedMHStatus.lastMatchAt) {
                    await this.bProfileUpdater.flushProfile(profParams, { onlyMatches: true });
                }
            }
            else {
                updatedMHStatus = await this.fetchPlayerMHStatus(profParams);
            }

            if (updatedMHStatus) {
                tPlayer.matchHistoryUpdatedAt = updatedMHStatus.matchHistoryUpdatedAt;
                tPlayer.lastMatchAt = updatedMHStatus.lastMatchAt;
                tPlayer.battleAPIErrorLast = updatedMHStatus.battleAPIErrorLast;
                tPlayer.battleAPIErrorCounter = updatedMHStatus.battleAPIErrorCounter;
                if (
                    tPlayer.lastMatchAt &&
                    tPlayer.recentMatches &&
                    tPlayer.recentMatches.from < tPlayer.lastMatchAt
                ) {
                    tPlayer.recentMatches = null;
                }
            }
        }

        // fetch player's recent matches to a cache if required
        if (
            tPlayer.lastMatchAt &&
            (
                !tPlayer.recentMatches || // cache empty
                tPlayer.recentMatches.from > fromDate || // not in `from` range
                (tPlayer.recentMatches.to < toDate && tPlayer.recentMatches.to < tPlayer.lastMatchAt) // not in `to` range
            )
        ) {
            const qFromDate = subHours(fromDate, 1);
            const qToDate = addHours(toDate, 10);
            const matches = await this.conn.getRepository(S2ProfileMatch).createQueryBuilder('profMatch')
                .leftJoin('profMatch.lobbyMatchProfile', 'lmp')
                .select([
                    'profMatch.id',
                    'profMatch.regionId',
                    'profMatch.localProfileId',
                    'profMatch.date',
                    'profMatch.decision',
                    'profMatch.mapId',
                    'lmp.lobbyId',
                    'lmp.profileMatchId',
                ])
                .andWhere('profMatch.regionId = :regionId AND profMatch.localProfileId = :localProfileId AND profMatch.type = :mType', {
                    regionId: profParams.regionId,
                    localProfileId: profParams.localProfileId,
                    mType: S2MatchType.Custom,
                })
                .andWhere('profMatch.date > :fromDate AND profMatch.date <= :toDate', {
                    fromDate: qFromDate,
                    toDate: qToDate,
                })
                .orderBy('profMatch.id', 'ASC')
                .getMany()
            ;
            tPlayer.recentMatches = {
                matches,
                from: qFromDate,
                to: qToDate,
            };
        }

        if (tPlayer.recentMatches) {
            return tPlayer.recentMatches.matches
                .filter(x => {
                    return (
                        x.date > fromDate && x.date <= toDate &&
                        x.mapId === mapId
                    );
                })
            ;
        }
    }

    async findLobbyCandidates(lobbyInfo: BattleTrackedLobby | S2GameLobby | number, opts?: {
        dateThreshold?: Date;
        considerMatched?: boolean;
        dontQuitEarly?: boolean;
    }) {
        if (typeof lobbyInfo === 'number') {
            lobbyInfo = (await this.loadLobbyInfo(lobbyInfo))[0];
        }
        let lobbyPlayers = (<BattleTrackedLobby>lobbyInfo)?.players ??
            lobbyInfo.slots.filter(x => x.kind === S2GameLobbySlotKind.Human && x.profile.localProfileId).map(x => x.profile.localProfileId)
        ;
        const matchDateThreshold = opts?.dateThreshold ?? addSeconds(lobbyInfo.closedAt, battleMatchMaxSecs);
        // const individualCandidates: S2ProfileMatch[][] = [];
        const allCandidates = new Map<number, S2ProfileMatch[]>(); // <time, counter>

        if ((<BattleTrackedLobby>lobbyInfo)?.checkCounter) {
            const lobOffset = (<BattleTrackedLobby>lobbyInfo)?.checkCounter % lobbyPlayers.length;
            if (lobOffset > 0) {
                lobbyPlayers = lobbyPlayers.slice(lobOffset).concat(lobbyPlayers.slice(0, lobOffset));
            }
        }
        for (const [i, localProfileId] of lobbyPlayers.entries()) {
            let latestPlayerMatches = await this.getPlayerMatches(
                { regionId: lobbyInfo.regionId, localProfileId: localProfileId },
                lobbyInfo.mapBnetId,
                lobbyInfo.closedAt,
                matchDateThreshold
            );
            if (!opts?.considerMatched && latestPlayerMatches) {
                latestPlayerMatches = latestPlayerMatches.filter(x => !x.lobbyMatchProfile);
            }
            if (!latestPlayerMatches || latestPlayerMatches.length <= 0) {
                if (opts?.dontQuitEarly) continue;
                return;
            }
            // individualCandidates[i] = latestPlayerMatches;

            let hasPotentialCommonCandiate = false;
            for (const candidate of latestPlayerMatches) {
                const cTime = candidate.date.getTime();
                let tmp = allCandidates.get(cTime);
                if (!tmp) {
                    tmp = [];
                    allCandidates.set(cTime, tmp);
                }
                else {
                    hasPotentialCommonCandiate = true;
                }
                tmp.push(candidate);
            }

            if ((i > 0 && !hasPotentialCommonCandiate)) {
                if (opts?.dontQuitEarly) continue;
                return;
            }
        }

        const validCandidateKeys = Array.from(allCandidates.keys()).filter(x => {
            const currSet = allCandidates.get(x);
            const individualMatchesCurrLen = new Set(currSet.map(y => y.localProfileId)).size;
            return individualMatchesCurrLen === lobbyPlayers.length;
        });

        const firstCandidateTimeKey = validCandidateKeys.length ? validCandidateKeys.sort()[0] : void 0;

        return {
            allCandidates,
            validCandidates: validCandidateKeys,
            finalCandidate: firstCandidateTimeKey ? allCandidates.get(firstCandidateTimeKey) : null,
        };
    }

    protected markLobbyCheck(lobbyInfo: BattleTrackedLobby) {
        lobbyInfo.lastCheckedAt = new Date();
        lobbyInfo.checkCounter++;
    }

    protected completeLobby(lobbyInfo: BattleTrackedLobby, lobMatch: S2LobbyMatch) {
        this.trackedLobbies.delete(lobbyInfo.id);
        this._onLobbyComplete.emit({
            lobby: lobbyInfo,
            match: lobMatch,
        });
    }

    protected async completeLobbyAsFailed(lobbyInfo: BattleTrackedLobby, result: S2LobbyMatchResult) {
        const lobMatch: S2LobbyMatch = Object.assign(new S2LobbyMatch(), {
            lobbyId: lobbyInfo.id,
            result: result,
        } as S2LobbyMatch);
        await this.conn.getRepository(S2LobbyMatch).insert(lobMatch);
        logger.verbose(oneLine`
            Failed to match lobby ${lobbyInfo.globalId} result=${S2LobbyMatchResult[result]}
            map=${lobbyInfo.regionId}/${lobbyInfo.mapBnetId} [${lobbyInfo.slotsHumansTaken}/${lobbyInfo.slotsHumansTotal}]
            closed=${lobbyInfo.closedAt.toISOString()}
            tl=${this.trackedLobbiesCount}
        `);
        this.completeLobby(lobbyInfo, lobMatch);
        return lobMatch;
    }

    async processLobby(lobbyId: number) {
        const lobbyInfo = this.trackedLobbies.get(lobbyId);
        const dateThreshold = addSeconds(lobbyInfo.closedAt, battleMatchMaxSecs);
        let pMatches = (await this.findLobbyCandidates(lobbyInfo, { dateThreshold }))?.finalCandidate;

        if (pMatches?.length && !lobbyInfo.isStartConfirmed) {
            const completedAt = pMatches[0].date;
            if (differenceInMinutes(Date.now(), completedAt) < 10 && (lobbyInfo.checkCounter < 1 && this.trackedLobbies.size > 1)) {
                this.markLobbyCheck(lobbyInfo);
                return;
            }

            const totalCandidateCount = await this.conn.getRepository(S2ProfileMatch).createQueryBuilder('profMatch')
                .select('profMatch.id')
                .distinct()
                .leftJoin('profMatch.lobbyMatchProfile', 'lmp')
                .andWhere('profMatch.regionId = :regionId AND profMatch.mapId = :mapId AND profMatch.date = :date', {
                    regionId: lobbyInfo.regionId,
                    mapId: lobbyInfo.mapBnetId,
                    date: completedAt,
                })
                .andWhere(`profMatch.type = '${S2MatchType.Custom}'`)
                .andWhere('lmp.lobbyId IS NULL')
                .getCount()
            ;
            if (totalCandidateCount > pMatches.length) {
                logger.warn(`lobby=${lobbyInfo.globalId} matching=${pMatches.length} foundTotal=${totalCandidateCount} cc=${lobbyInfo.checkCounter}`);
                logger.debug('pMatches', pMatches);
                if (lobbyInfo.checkCounter > 6 || Date.now() > dateThreshold.getTime() || this.trackedLobbies.size === 1) {
                    return this.completeLobbyAsFailed(lobbyInfo, S2LobbyMatchResult.UncertainTimestampAdditionalMatches);
                }
                else {
                    this.markLobbyCheck(lobbyInfo);
                    return;
                }
            }
        }

        // check for duplicates (same timestamp & mapId) of individual player results
        // examples:
        // https://sc2arcade.com/lobby/2/1609814152/12519195
        // https://sc2arcade.com/lobby/2/1609814152/12518503
        if (pMatches?.length && pMatches.length > lobbyInfo.players.length) {
            const invidualPlayerMatches = new Map<number, typeof pMatches>();
            for (const item of pMatches) {
                let tmpa = invidualPlayerMatches.get(item.localProfileId);
                if (!tmpa) {
                    tmpa = [];
                    invidualPlayerMatches.set(item.localProfileId, tmpa);
                }
                tmpa.push(item);
            }
            if (invidualPlayerMatches.size !== pMatches.length) {
                const dupProfileIds = Array.from(invidualPlayerMatches).filter(x => x[1].length > 1).map(x => x[0]);
                const dupDiffProfileIds: number[] = [];
                for (const localProfileId of dupProfileIds) {
                    const diffDecisions = new Set(invidualPlayerMatches.get(localProfileId).map(x => x.decision));
                    if (diffDecisions.size > 1) {
                        dupDiffProfileIds.push(localProfileId);
                    }
                }

                // only care if decisions are different on duplicates
                if (dupDiffProfileIds.length > 0) {
                    logger.warn(`individualMatches has duplicates? lobby=${lobbyInfo.globalId} dups=${dupProfileIds} dupsdiff=${dupDiffProfileIds}`);
                    logger.debug('individualMatches', lobbyInfo, pMatches);

                    return this.completeLobbyAsFailed(lobbyInfo, S2LobbyMatchResult.UncertainTimestampPlayerDuplicates);
                }
                else {
                    pMatches = Array.from(invidualPlayerMatches.values()).map(x => x[0]);
                }
            }
        }

        if (pMatches) {
            const lobMatch = new S2LobbyMatch();
            lobMatch.lobbyId = lobbyId;
            lobMatch.completedAt = pMatches[0].date;
            lobMatch.result = S2LobbyMatchResult.Success;

            pMatches.forEach(x => {
                if (x.lobbyMatchProfile) {
                    logger.error(`lobbyMatchProfile`, lobbyInfo, pMatches, x.lobbyMatchProfile);
                    throw new Error(`x.lobbyMatchProfile already exists?!`);
                }
                x.lobbyMatchProfile = {
                    lobbyId: lobbyId,
                    profileMatchId: x.id,
                } as S2LobbyMatchProfile;
            });

            await this.conn.transaction(async (tsManager) => {
                await tsManager.getRepository(S2LobbyMatch).insert(lobMatch);
                await tsManager.getRepository(S2LobbyMatchProfile).insert(
                    pMatches.map(x => {
                        return {
                            lobbyId: lobbyId,
                            profileMatchId: x.id,
                        };
                    })
                );
            });
            logger.info(oneLine`
                Found a match for lobby=${lobbyInfo.globalId} map=${lobbyInfo.regionId}/${lobbyInfo.mapBnetId} (${lobbyInfo.players.length}p)
                closed=${lobbyInfo.closedAt.toISOString()}
                started=${lobMatch.completedAt.toISOString()}
                duration=${lobMatch.completedAt ? `${(differenceInSeconds(lobMatch.completedAt, lobbyInfo.closedAt) / 60.0).toFixed(1)}m` : 'none'}
                tl=${this.trackedLobbiesCount}
            `, pMatches.map(x => oneLine`
                (${x.decision.substr(0, 1).toUpperCase()})
                ${lobbyInfo.slots.find(y => y?.profile?.localProfileId === x.localProfileId)?.profile.name.padEnd(12, ' ')}
            `).join(' '));
            this.completeLobby(lobbyInfo, lobMatch);
            return lobMatch;
        }
        else if (new Date() > dateThreshold) {
            return this.completeLobbyAsFailed(lobbyInfo, S2LobbyMatchResult.Unknown);
        }
        else {
            const tdiff = differenceInSeconds(new Date(), lobbyInfo.closedAt) / 60.0;
            logger.debug(`Couldn't find a match for lobby ${lobbyInfo.globalId} (${lobbyInfo.players.length}p) tdiff=${tdiff.toFixed(1)}m ..`);
            this.markLobbyCheck(lobbyInfo);
        }
    }

    async loadLobbyInfo(lobbyId: number | number[]) {
        const qb = this.conn.getCustomRepository(S2GameLobbyRepository).createQueryBuilder('lobby')
            .leftJoinAndMapOne('lobby.map', S2Map, 'map', 'map.regionId = lobby.regionId AND map.bnetId = lobby.mapBnetId')
            .select([
                'lobby.id',
                'lobby.status',
                'lobby.regionId',
                'lobby.bnetBucketId',
                'lobby.bnetRecordId',
                'lobby.mapBnetId',
                'lobby.closedAt',
                'lobby.slotsHumansTaken',
                'lobby.slotsHumansTotal',
                'map.id',
            ])
            .leftJoin('lobby.match', 'lobMatch')
            .addSelect([
                'lobMatch.result',
                // 'lobMatch.date',
            ])
            .leftJoin('lobby.slots', 'slot')
            .addSelect([
                // 'slot.slotNumber',
                // 'slot.team',
                'slot.kind',
                // 'slot.name',
            ])
            .leftJoin('slot.profile', 'profile')
            .addSelect([
                // TODO: don't pull the name? (used only for debugging by logger)
                'profile.name',
                'profile.localProfileId',
            ])
            .addOrderBy('lobby.id', 'ASC')
        ;

        let results: S2GameLobby[];

        if (typeof lobbyId === 'number') {
            qb.andWhere('lobby.id = :lobbyId', {
                lobbyId: lobbyId,
            });
            const lobbyInfo = await qb.getOne();
            if (!lobbyInfo) {
                throw new Error(`invalid lobby ${lobbyId}`);
            }
            results = [lobbyInfo];
        }
        else {
            qb.andWhere('lobby.id IN (:lobbyId)', {
                lobbyId: lobbyId,
            });
            results = await qb.getMany();
        }

        return results;
    }

    async addLobby(lobbyId: number | number[]) {
        const results = await this.loadLobbyInfo(lobbyId);

        for (const lobItem of results) {
            if (this.trackedLobbies.has(lobItem.id)) {
                throw new Error(`lobby ${lobItem.globalId} already tracked`);
            }
            if (lobItem.closedAt === null) {
                throw new Error(`lobby ${lobItem.globalId} not yet closed`);
            }
            if (lobItem.match) {
                logger.warn(`lobby ${lobItem.globalId} already matched with result=${S2LobbyMatchResult[lobItem.match.result]}, skipping..`);
                continue;
            }

            const humanSlots = lobItem.slots.filter(x => x.kind === S2GameLobbySlotKind.Human);
            const lobbyInfo: BattleTrackedLobby = {
                ...lobItem,
                globalId: lobItem.globalId,
                lastCheckedAt: null,
                checkCounter: 0,
                isStartConfirmed: lobItem.slotsHumansTaken === lobItem.slotsHumansTotal,
                players: humanSlots.filter(x => x.profile).map(x => x.profile.localProfileId),
            };

            if (lobItem.status !== GameLobbyStatus.Started) {
                await this.completeLobbyAsFailed(lobbyInfo, S2LobbyMatchResult.DidNotStart);
                continue;
            }
            if (!lobItem.map) {
                await this.completeLobbyAsFailed(lobbyInfo, S2LobbyMatchResult.MapInfoMissing);
                continue;
            }
            if (humanSlots.length !== lobbyInfo.slotsHumansTaken) {
                await this.completeLobbyAsFailed(lobbyInfo, S2LobbyMatchResult.HumanSlotCountMissmatch);
                continue;
            }
            if (humanSlots.find(x => !x.profile)) {
                await this.completeLobbyAsFailed(lobbyInfo, S2LobbyMatchResult.HumanSlotProfileMissing);
                continue;
            }
            if ((new Set(humanSlots.map(x => x.profile.localProfileId))).size !== humanSlots.length) {
                await this.completeLobbyAsFailed(lobbyInfo, S2LobbyMatchResult.HumanSlotDataCorrupted);
                continue;
            }
            if (humanSlots.length === 0) {
                await this.completeLobbyAsFailed(lobbyInfo, S2LobbyMatchResult.SlotsDataMissing);
                continue;
            }

            this.trackedLobbies.set(lobbyInfo.id, lobbyInfo);
        }
    }

    async work() {
        if (this.isRunning) return;

        this.isRunning = true;
        let firstCycle = true;
        const maxCheckPeriod = {
            [GameRegion.US]: 180,
            [GameRegion.EU]: 180,
            [GameRegion.KR]: 300,
            [GameRegion.CN]: 600,
        };
        while (true) {
            if (!this.isRunning) {
                await this.taskQueue.onIdle();
                break;
            }

            const tnow = new Date();
            let lobsInCycleCounter = 0;

            for (const [lobbyId, lobbyInfo] of this.trackedLobbies) {
                if (lobbyInfo.lastCheckedAt) {
                    const tLobbyDiffMins = differenceInMinutes(tnow, lobbyInfo.closedAt);
                    const checkPeriodSecs = Math.min(
                        maxCheckPeriod[lobbyInfo.regionId as GameRegion],
                        30 + Math.pow(1.05, tLobbyDiffMins)
                    );
                    if (differenceInSeconds(tnow, lobbyInfo.lastCheckedAt) < checkPeriodSecs) continue;
                }
                else if (!lobbyInfo.isStartConfirmed) {
                    if (differenceInSeconds(tnow, lobbyInfo.closedAt) < maxCheckPeriod[lobbyInfo.regionId as GameRegion]) continue;
                    if (firstCycle) continue;
                }

                const currentlyProcessingKeys = lobbyInfo.players.map(x => `${lobbyInfo.mapBnetId}/${getProfileLocalCacheKey({
                    regionId: lobbyInfo.regionId,
                    localProfileId: x,
                })}`);
                currentlyProcessingKeys.push(`${lobbyInfo.id}`);
                const canEvaluate = !currentlyProcessingKeys.some(x => this.currentlyEvaluated.has(x));
                if (!canEvaluate) continue;
                currentlyProcessingKeys.forEach(x => this.currentlyEvaluated.add(x));

                this.taskQueue.add(async () => {
                    await this.processLobby(lobbyId);
                    currentlyProcessingKeys.forEach(x => this.currentlyEvaluated.delete(x));
                });
                lobsInCycleCounter++;
            }

            firstCycle = false;

            // sleep if there's nothing to do
            if (lobsInCycleCounter === 0) {
                if (this.taskQueue.pending === 0 && this.trackedLobbies.size > 0) {
                    await sleep(1000);
                }
                else {
                    await sleep(500);
                }
            }
            else {
                logger.verbose(`battle tracking cycle, count=${lobsInCycleCounter} tl=${this.trackedLobbiesCount}`);
            }

            await this.taskQueue.onEmpty();
        }
    }
}

interface BattleLobbyTrackerState {
    lobbyIdOffset: number;
    lastUpdate: number;
}

export class BattleLobbyProvider extends ServiceProcess {
    protected state: BattleLobbyTrackerState;
    protected offsetLastCheckedAt = new Date();
    protected unclosedLobbyIds = new Set<number>();
    // protected uncompletedLobbyIds = new Set<number>();

    constructor(
        protected conn: orm.Connection,
        protected bmTracker: BattleMatchTracker
    ) {
        super();
    }

    protected async loadState() {
        this.state = await this.conn.getCustomRepository(AppStorageRepository).getByKey<BattleLobbyTrackerState>('battle_lobby_tracker_state', true);
        if (!this.state) {
            const lobResult = await this.conn.getCustomRepository(S2GameLobbyRepository).createQueryBuilder('lobby')
                .select('lobby.id', 'id')
                .andWhere('lobby.closedAt >= :closedAt', { closedAt: '2020-12-01' })
                .limit(1)
                .getRawOne()
            ;
            this.state = {
                lobbyIdOffset: lobResult.id,
                lastUpdate: Date.now(),
            };
            await this.persistState();
        }
        else {
            logger.info(`loaded tracking state`, this.state);
        }
    }

    protected async persistState() {
        await this.conn.getCustomRepository(AppStorageRepository).setByKey('battle_lobby_tracker_state', this.state);
    }

    protected determineNewOffset() {
        let offsetLowest = Number.MAX_SAFE_INTEGER;
        if (this.unclosedLobbyIds.size > 0) {
            offsetLowest = Math.min(
                offsetLowest,
                Array.from(this.unclosedLobbyIds.keys()).reduce((prev, curr) => prev > curr ? curr : prev)
            );
        }
        if (this.bmTracker.trackedLobbiesCount > 0) {
            offsetLowest = Math.min(
                offsetLowest,
                this.bmTracker.trackedLobbiesLowestId
            );
        }
        return offsetLowest;
    }

    protected async updateOffset(force = false) {
        if (!force && differenceInSeconds(Date.now(), this.offsetLastCheckedAt) < 120) return;
        this.offsetLastCheckedAt = new Date();
        const newOffset = this.determineNewOffset();
        if (newOffset === Number.MAX_SAFE_INTEGER) return;
        if (this.state.lobbyIdOffset !== newOffset) {
            logger.verbose(`new tracking offset=${newOffset} prev=${this.state.lobbyIdOffset}`);
            this.state.lobbyIdOffset = newOffset;
            this.state.lastUpdate = Date.now();
            await this.persistState();
        }
    }

    async doShutdown() {
        await this.updateOffset(true);
    }

    async doWork() {
        const qLimit = 500;

        const qbMain = this.conn.getCustomRepository(S2GameLobbyRepository).createQueryBuilder('lobby')
            .select([
                'lobby.id',
                'lobby.closedAt',
                'lobby.status',
            ])
            .orderBy('lobby.id', 'ASC')
            .limit(qLimit)
        ;

        const qbClosed = qbMain.clone()
            .andWhere('(lobby.closedAt IS NOT NULL AND lobby.closedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 SECOND))')
            .andWhere('lobby.id IN (:lobbyIds)')
        ;

        qbMain
            .andWhere('lobby.id >= :lobbyOffset', { lobbyOffset: 0 })
            .leftJoin('lobby.match', 'lobMatch')
            .andWhere('lobMatch.lobbyId IS NULL')
        ;
        let lobbyOffset = this.state.lobbyIdOffset;
        while (!this.isShuttingDown) {
            logger.debug(`Retieving lobbies offset=${lobbyOffset} unclosed=${this.unclosedLobbyIds.size}`);

            qbMain.setParameter('lobbyOffset', lobbyOffset);
            const lobNewResults = await qbMain.getMany();
            let lobResults = lobNewResults;
            logger.debug(`Retrieved ${lobResults.length} new lobbies`);

            if (this.unclosedLobbyIds.size > 0) {
                qbClosed.setParameter('lobbyIds', Array.from(this.unclosedLobbyIds));
                const lobClosedResults = await qbClosed.getMany();
                logger.debug(`Retrieved ${lobClosedResults.length} closed lobbies`);
                lobResults = lobClosedResults.concat(lobResults);
            }

            let closedLobResults: typeof lobResults = [];
            for (const lobby of lobResults) {
                const closeDateThreshold = subSeconds(Date.now(), 60);
                if (lobby.closedAt === null || lobby.closedAt > closeDateThreshold) {
                    this.unclosedLobbyIds.add(lobby.id);
                }
                else {
                    // this.uncompletedLobbyIds.add(lobby.id);
                    this.unclosedLobbyIds.delete(lobby.id);
                    closedLobResults.push(lobby);
                }
            }
            if (closedLobResults.length > 0) {
                await this.bmTracker.addLobby(closedLobResults.map(x => x.id));
            }
            if (lobNewResults.length > 0) {
                lobbyOffset = lobNewResults[lobNewResults.length - 1].id + 1;
            }

            await this.updateOffset();
            // sleep up to 30s
            for (let i = 0;; i++) {
                if (this.isShuttingDown) break;
                if (
                    (lobNewResults.length >= qLimit && this.bmTracker.trackedLobbiesCount < 5000) ||
                    (i >= 300)
                ) {
                    break;
                }
                await sleep(100);
            }
        }
    }

    async doStart() {
        await this.loadState();
        await this.doWork();
        // setImmediate(this.doWork.bind(this));
    }
}
